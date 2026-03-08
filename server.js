import express from 'express';
import { randomUUID, timingSafeEqual } from 'crypto';
import { rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
    getLoginAccountsForMode,
    getLoginState,
    getSessionState,
    getTrialState,
    resolveBaseProfileDir,
    resolveLoginSessionDir,
} from './src/account-session.js';
import { buildPublicConfig as buildPublicConfigPayload, loadConfig } from './src/config.js';
import { loginAccountsBatch } from './src/login-batch.js';
import { buildPaymentData, decorateVccEntries } from './src/payment.js';
import {
    deleteSignInAccounts,
    deleteVccEntries,
    loadSignInAccounts,
    loadVccEntries,
    resetSignInAccountLoginState,
    saveSignInAccount,
    saveVccEntry,
} from './src/storage.js';
import { toBoolean, toNumber } from './src/value-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = loadConfig();
const app = express();
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

app.use(express.json({ limit: '1mb' }));
const basicAuthMiddleware = createBasicAuthMiddleware();
if (basicAuthMiddleware) {
    app.use(basicAuthMiddleware);
}
app.use(express.static(join(__dirname, 'public')));

function decorateAccounts(accounts = []) {
    return accounts.map((account) => {
        const session = getSessionState(account, config);
        const login = getLoginState(account, session, config);
        const trial = getTrialState(account);
        return {
            ...account,
            has_session: session.hasSession,
            session_label: session.label,
            session_dir: session.dir,
            login_label: login.label,
            login_badge: login.key,
            trial_label: trial.label,
            trial_badge: trial.key,
        };
    });
}

function buildPublicConfig() {
    return buildPublicConfigPayload(config);
}

function unauthorized(res) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Duolingo Ops Board"');
    res.status(401).send('Authentication required');
}

function createBasicAuthMiddleware() {
    const username = String(process.env.BASIC_AUTH_USER || '').trim();
    const password = String(process.env.BASIC_AUTH_PASSWORD || '').trim();
    if (!username || !password) return null;

    const expectedUsername = Buffer.from(username);
    const expectedPassword = Buffer.from(password);
    const safeCompare = (value, expected) => {
        const actual = Buffer.from(String(value));
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    };

    return (req, res, next) => {
        if (req.path === '/healthz') {
            next();
            return;
        }

        const authHeader = String(req.headers.authorization || '');
        if (!authHeader.startsWith('Basic ')) {
            unauthorized(res);
            return;
        }

        let decoded = '';
        try {
            decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        } catch {
            unauthorized(res);
            return;
        }

        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex < 0) {
            unauthorized(res);
            return;
        }

        const suppliedUsername = decoded.slice(0, separatorIndex);
        const suppliedPassword = decoded.slice(separatorIndex + 1);
        if (!safeCompare(suppliedUsername, expectedUsername) || !safeCompare(suppliedPassword, expectedPassword)) {
            unauthorized(res);
            return;
        }

        next();
    };
}

function createSession() {
    const id = randomUUID();
    const session = {
        id,
        status: 'running',
        created_at: new Date().toISOString(),
        logs: [],
        listeners: new Set(),
        result: null,
    };
    sessions.set(id, session);
    return session;
}

function pushSessionLog(session, message) {
    const entry = { t: new Date().toISOString(), message: String(message) };
    session.logs.push(entry);
    if (session.logs.length > 1000) session.logs.shift();
    const payload = `data: ${JSON.stringify({ type: 'log', entry })}\n\n`;
    for (const listener of session.listeners) listener.write(payload);
}

function finishSession(session, result, status = 'done') {
    session.status = status;
    session.result = result;
    const payload = `data: ${JSON.stringify({ type: 'result', status, result })}\n\n`;
    for (const listener of session.listeners) {
        listener.write(payload);
        listener.end();
    }
    session.listeners.clear();
}

async function resolveVccData(body = {}) {
    const action = String(body.after_login_action || 'none').trim().toLowerCase();
    if (action !== 'trial-auto-vcc') return null;

    const normalizeOrThrow = (value) => {
        const normalized = buildPaymentData(value);
        if (!normalized.cardNumber || !normalized.expMonth || !normalized.expYear || !normalized.cvc) {
            throw new Error('Data VCC tidak valid. Card number, expired, dan CVC wajib diisi.');
        }
        return normalized;
    };

    const directData = body.vccData && typeof body.vccData === 'object'
        ? body.vccData
        : null;
    if (directData?.cardNumber) {
        return normalizeOrThrow(directData);
    }

    const vccId = String(body.vcc_id || '').trim();
    if (!vccId) {
        throw new Error('VCC wajib dipilih untuk claim trial otomatis.');
    }

    const entries = await loadVccEntries();
    const selected = entries.find((entry) => String(entry?.id || '').trim() === vccId);
    if (!selected) {
        throw new Error(`VCC dengan id ${vccId} tidak ditemukan.`);
    }

    return normalizeOrThrow(selected);
}

async function buildOverridesFromBody(body = {}) {
    const manualPassword = toBoolean(body.manual_password, config.manual_password === true);
    const overrides = {
        ...(body.password ? { password: String(body.password).trim() } : {}),
        ...(body.browser ? { browser: String(body.browser).trim().toLowerCase() } : {}),
        ...(body.profile_dir ? { profile_dir: String(body.profile_dir).trim() } : {}),
        ...(body.persistent_profile !== undefined ? { persistent_profile: toBoolean(body.persistent_profile, true) } : {}),
        ...(body.headless !== undefined ? { headless: toBoolean(body.headless, config.headless === true) } : {}),
        ...(body.force_headed_login !== undefined ? { force_headed_login: toBoolean(body.force_headed_login, config.force_headed_login === true) } : {}),
        ...(body.show_pointer !== undefined ? { show_pointer: toBoolean(body.show_pointer, config.show_pointer !== false) } : {}),
        ...(body.slow_mo !== undefined ? { slow_mo: toNumber(body.slow_mo, config.slow_mo) } : {}),
        ...(body.timeout !== undefined ? { timeout: toNumber(body.timeout, config.timeout) } : {}),
        ...(body.max_workers !== undefined ? { max_workers: toNumber(body.max_workers, config.max_workers) } : {}),
        ...(body.submit_wait_seconds !== undefined ? { submit_wait_seconds: body.submit_wait_seconds === '' ? '' : toNumber(body.submit_wait_seconds, config.submit_wait_seconds ?? 4) } : {}),
        ...(body.login_retry_attempts !== undefined ? { login_retry_attempts: toNumber(body.login_retry_attempts, config.login_retry_attempts ?? 5) } : {}),
        ...(body.after_login_action ? { after_login_action: String(body.after_login_action).trim().toLowerCase() } : {}),
        ...(body.manual_password !== undefined ? { manual_password: manualPassword } : {}),
    };

    if (body.headless !== undefined && body.force_headed_login === undefined && toBoolean(body.headless, config.headless === true)) {
        overrides.force_headed_login = false;
    }

    const proxyServer = String(body.proxy_server || '').trim();
    if (proxyServer) {
        overrides.proxy = {
            server: proxyServer,
            username: String(body.proxy_username || '').trim() || undefined,
            password: String(body.proxy_password || '').trim() || undefined,
        };
    }

    if (manualPassword) {
        overrides.headless = false;
        overrides.max_workers = 1;
    }

    const vccData = await resolveVccData(body);
    if (vccData) {
        overrides.vccData = vccData;
    }

    return overrides;
}

async function resolveRunPayload(body = {}) {
    const overrides = await buildOverridesFromBody(body);
    const runtimeConfig = {
        ...config,
        ...overrides,
    };
    const allAccounts = await loadSignInAccounts();
    const usableAccounts = getLoginAccountsForMode(allAccounts, runtimeConfig);
    const singleEmail = String(body.email || body.account_email || '').trim().toLowerCase();
    const explicitEmails = Array.isArray(body.emails)
        ? body.emails.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];

    let accounts = [];
    if (singleEmail) {
        const selected = allAccounts.find((account) => String(account?.email || '').trim().toLowerCase() === singleEmail);
        if (!selected) {
            throw new Error(`Akun ${singleEmail} tidak ditemukan di sign-in-account.json.`);
        }
        accounts = [selected];
    } else if (explicitEmails.length > 0) {
        accounts = explicitEmails
            .map((email) => allAccounts.find((account) => String(account?.email || '').trim().toLowerCase() === email))
            .filter(Boolean);
        if (accounts.length === 0) {
            throw new Error('Tidak ada akun yang cocok dengan pilihan yang dikirim.');
        }
    } else {
        const latestAccounts = [...usableAccounts].reverse();
        const count = Math.max(1, Math.min(toNumber(body.count, 1), latestAccounts.length));
        accounts = latestAccounts.slice(0, count);
    }

    if (accounts.length === 0) {
        throw new Error('Tidak ada akun yang bisa dijalankan.');
    }

    return {
        count: accounts.length,
        accounts,
        overrides,
    };
}

async function runLogin(body = {}, onLog) {
    const payload = await resolveRunPayload(body);
    return await loginAccountsBatch({
        count: payload.count,
        baseConfig: config,
        overrides: payload.overrides,
        accounts: payload.accounts,
        onLog,
    });
}

async function startLoginSessionFromBody(body = {}) {
    const payload = await resolveRunPayload(body);
    const session = createSession();
    pushSessionLog(session, `[SESSION] START id=${session.id}`);

    loginAccountsBatch({
        count: payload.count,
        baseConfig: config,
        overrides: payload.overrides,
        accounts: payload.accounts,
        onLog: (line) => pushSessionLog(session, line),
    }).then((result) => {
        pushSessionLog(session, '[SESSION] DONE');
        finishSession(session, result, 'done');
    }).catch((error) => {
        pushSessionLog(session, `[SESSION] ERROR ${error.message || 'Unknown error'}`);
        finishSession(session, { error: error.message || 'Internal server error' }, 'failed');
    });

    return {
        session,
        count: payload.count,
    };
}

async function removeStoredSessionsByEmails(emails = []) {
    if (config?.persistent_profile === false) {
        return { removed_session_count: 0, scope: 'off' };
    }

    const normalizedEmails = new Set(
        emails
            .map((email) => String(email || '').trim().toLowerCase())
            .filter(Boolean),
    );

    const accounts = await loadSignInAccounts();
    const targets = accounts.filter((account) => normalizedEmails.has(String(account?.email || '').trim().toLowerCase()));
    for (const account of targets) {
        rmSync(resolveLoginSessionDir(account, config), { recursive: true, force: true });
    }
    await resetSignInAccountLoginState(targets.map((account) => account.email)).catch(() => { });

    return {
        removed_session_count: targets.length,
        scope: 'selected',
    };
}

async function clearAllStoredSessions() {
    if (config?.persistent_profile === false) {
        return { removed_session_count: 0, scope: 'off' };
    }

    const accounts = await loadSignInAccounts();
    const loginBaseDir = resolve(resolveBaseProfileDir(config), 'login');
    rmSync(loginBaseDir, { recursive: true, force: true });
    await resetSignInAccountLoginState(accounts.map((account) => account.email)).catch(() => { });

    return {
        removed_session_count: accounts.length,
        scope: 'all',
    };
}

function handleError(res, error, status = 400) {
    res.status(status).json({ error: error?.message || String(error) || 'Unknown error' });
}

app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
    res.json(buildPublicConfig());
});

app.get('/api/overview', async (_req, res) => {
    const accounts = decorateAccounts(await loadSignInAccounts());
    const vccEntries = decorateVccEntries(await loadVccEntries());
    res.json({
        config: buildPublicConfig(),
        stats: {
            accounts: accounts.length,
            sessions: accounts.filter((account) => account.has_session).length,
            login_success: accounts.filter((account) => account.login_badge === 'success').length,
            trial_claimed: accounts.filter((account) => account.trial_badge === 'claimed').length,
            vcc: vccEntries.length,
        },
    });
});

app.get('/api/accounts', async (_req, res) => {
    const accounts = decorateAccounts(await loadSignInAccounts());
    res.json({ total: accounts.length, file: 'sign-in-account.json', accounts });
});

app.post('/api/accounts', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim();
        const password = String(req.body?.password || '').trim();
        const username = String(req.body?.username || '').trim();
        if (!/.+@.+\..+/.test(email)) {
            throw new Error('Email tidak valid.');
        }
        if (!password) {
            throw new Error('Password wajib diisi.');
        }

        const previousEmail = String(req.body?.previous_email || '').trim();
        if (previousEmail && previousEmail.toLowerCase() !== email.toLowerCase()) {
            await deleteSignInAccounts([previousEmail]);
            await removeStoredSessionsByEmails([previousEmail]).catch(() => { });
        }

        const result = await saveSignInAccount({ email, password, username });
        const accounts = decorateAccounts(await loadSignInAccounts());
        const saved = accounts.find((account) => String(account?.email || '').trim().toLowerCase() === email.toLowerCase()) || null;
        res.json({
            ...result,
            account: saved,
            total: accounts.length,
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.delete('/api/accounts', async (req, res) => {
    try {
        const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
        if (emails.length === 0) {
            throw new Error('Pilih minimal 1 akun untuk dihapus.');
        }

        const removeSessions = toBoolean(req.body?.remove_sessions, true);
        const result = await deleteSignInAccounts(emails);
        let sessionResult = { removed_session_count: 0 };
        if (removeSessions) {
            sessionResult = await removeStoredSessionsByEmails(emails);
        }
        const accounts = decorateAccounts(await loadSignInAccounts());
        res.json({
            ...result,
            ...sessionResult,
            total: accounts.length,
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.post('/api/sessions/clear', async (req, res) => {
    try {
        const scope = String(req.body?.scope || 'selected').trim().toLowerCase();
        let result;
        if (scope === 'all') {
            result = await clearAllStoredSessions();
        } else {
            const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
            if (emails.length === 0) {
                throw new Error('Pilih akun yang sesi-nya ingin dihapus.');
            }
            result = await removeStoredSessionsByEmails(emails);
        }

        const accounts = decorateAccounts(await loadSignInAccounts());
        res.json({
            ...result,
            total: accounts.length,
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.get('/api/vcc', async (_req, res) => {
    const entries = decorateVccEntries(await loadVccEntries());
    res.json({ total: entries.length, file: 'vcc.json', entries });
});

app.post('/api/vcc', async (req, res) => {
    try {
        const result = await saveVccEntry(req.body || {});
        const entries = decorateVccEntries(await loadVccEntries());
        const saved = entries.find((entry) => entry.id === result.entry?.id) || null;
        res.json({
            ...result,
            entry: saved,
            total: entries.length,
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.put('/api/vcc/:id', async (req, res) => {
    try {
        const result = await saveVccEntry({
            ...(req.body || {}),
            id: req.params.id,
        });
        const entries = decorateVccEntries(await loadVccEntries());
        const saved = entries.find((entry) => entry.id === result.entry?.id) || null;
        res.json({
            ...result,
            entry: saved,
            total: entries.length,
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.delete('/api/vcc', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        if (ids.length === 0) {
            throw new Error('Pilih minimal 1 VCC untuk dihapus.');
        }

        const result = await deleteVccEntries(ids);
        res.json(result);
    } catch (error) {
        handleError(res, error);
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const result = await runLogin(req.body || {});
        res.json(result);
    } catch (error) {
        handleError(res, error, 500);
    }
});

app.post('/api/create', async (req, res) => {
    try {
        const result = await runLogin(req.body || {});
        res.json(result);
    } catch (error) {
        handleError(res, error, 500);
    }
});

app.post('/api/login-session', async (req, res) => {
    try {
        const { session, count } = await startLoginSessionFromBody(req.body || {});
        res.json({ session_id: session.id, status: session.status, count });
    } catch (error) {
        handleError(res, error);
    }
});

app.post('/api/create-session', async (req, res) => {
    try {
        const { session, count } = await startLoginSessionFromBody(req.body || {});
        res.json({ session_id: session.id, status: session.status, count });
    } catch (error) {
        handleError(res, error);
    }
});

function handleSessionStatus(req, res) {
    const session = sessions.get(req.params.id);
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    res.json({
        session_id: session.id,
        status: session.status,
        created_at: session.created_at,
        result: session.result,
        logs_count: session.logs.length,
    });
}

app.get('/api/login-session/:id', handleSessionStatus);
app.get('/api/create-session/:id', handleSessionStatus);

function handleSessionEvents(req, res) {
    const session = sessions.get(req.params.id);
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    session.logs.forEach((entry) => {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    });

    if (session.status !== 'running') {
        res.write(`data: ${JSON.stringify({ type: 'result', status: session.status, result: session.result })}\n\n`);
        res.end();
        return;
    }

    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    session.listeners.add(res);
    req.on('close', () => {
        clearInterval(heartbeat);
        session.listeners.delete(res);
    });
}

app.get('/api/login-session/:id/events', handleSessionEvents);
app.get('/api/create-session/:id/events', handleSessionEvents);

export { app, buildPublicConfig };

const isDirectRun = process.argv[1]
    ? resolve(process.argv[1]) === __filename
    : false;

if (isDirectRun) {
    app.listen(port, () => {
        console.log(`Web app running on http://localhost:${port}`);
    });
}
