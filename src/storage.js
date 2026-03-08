// src/storage.js
// Handles saving and reading local JSON credential files

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { readJson, writeJson, ensureFile } from 'fs-extra/esm';
import { TRIAL_STATE_KEYS, normalizeTrialStatus } from './account-session.js';
import { resolveDataFile } from './runtime-paths.js';

const ACCOUNTS_FILE = resolveDataFile('accounts.json');
const SIGN_IN_ACCOUNTS_FILE = resolveDataFile('sign-in-account.json');
const VCC_FILE = resolveDataFile('vcc.json');

function buildStoredTrialSnapshot(account = {}) {
    return {
        trial_status: account?.trial_status || null,
        trial_claimed_at: account?.trial_claimed_at || null,
        trial_last_action: account?.trial_last_action || null,
        trial_last_status: account?.trial_last_status || null,
        trial_last_error: account?.trial_last_error || null,
        trial_updated_at: account?.trial_updated_at || null,
    };
}

function deriveStoredTrialSnapshot(account = {}, result = {}, now = new Date().toISOString()) {
    const current = buildStoredTrialSnapshot(account);
    const currentTrialState = normalizeTrialStatus(current.trial_status);
    const explicitTrialState = normalizeTrialStatus(result?.trial_status);

    const applyStatus = (key, metadata = {}) => {
        if (key === TRIAL_STATE_KEYS.unknown) {
            return {
                ...current,
                ...metadata,
            };
        }

        if (currentTrialState === TRIAL_STATE_KEYS.claimed && key !== TRIAL_STATE_KEYS.claimed) {
            return {
                ...current,
                ...metadata,
                trial_updated_at: now,
            };
        }

        return {
            ...current,
            ...metadata,
            trial_status: key,
            trial_claimed_at: key === TRIAL_STATE_KEYS.claimed
                ? (current.trial_claimed_at || now)
                : current.trial_claimed_at,
            trial_updated_at: now,
        };
    };

    if (explicitTrialState !== TRIAL_STATE_KEYS.unknown) {
        return applyStatus(explicitTrialState, {
            trial_last_action: result?.trial_action
                ? String(result.trial_action)
                : current.trial_last_action,
            trial_last_status: result?.trial_status
                ? String(result.trial_status)
                : current.trial_last_status,
            trial_last_error: result?.trial_error
                ? String(result.trial_error)
                : null,
        });
    }

    const action = String(result?.after_login_action || '').trim().toLowerCase();
    if (action !== 'trial-manual' && action !== 'trial-auto-vcc') {
        return current;
    }

    const derivedTrialState = normalizeTrialStatus(result?.after_login_status);
    return applyStatus(derivedTrialState, {
        trial_last_action: action,
        trial_last_status: result?.after_login_status ? String(result.after_login_status) : null,
        trial_last_error: result?.after_login_error ? String(result.after_login_error) : null,
    });
}

async function readAccountsFile(path) {
    try {
        await ensureFile(path);
        const data = await readJson(path).catch(() => []);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function normalizeMonth(value) {
    const digits = String(value || '').replace(/\D+/g, '').slice(0, 2);
    if (!digits) return '';
    return digits.padStart(2, '0');
}

function normalizeYear(value) {
    const digits = String(value || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 2) return `20${digits}`;
    if (digits.length >= 4) return digits.slice(-4);
    return digits;
}

function buildExpDate(expMonth, expYear) {
    if (!expMonth || !expYear) return '';
    return `${String(expMonth).padStart(2, '0')}/${String(expYear).slice(-2)}`;
}

function normalizeVccEntry(entry = {}, fallbackId = null) {
    const expDateRaw = String(entry?.expDate || entry?.exp_date || '').trim();
    const expDateDigits = expDateRaw.replace(/\D+/g, '');
    const expMonth = normalizeMonth(entry?.expMonth || entry?.exp_month || expDateDigits.slice(0, 2));
    const expYear = normalizeYear(entry?.expYear || entry?.exp_year || expDateDigits.slice(2));
    const cardNumber = String(entry?.cardNumber || entry?.card_number || '').replace(/\D+/g, '');
    const cvc = String(entry?.cvc || '').replace(/\D+/g, '').slice(0, 4);
    const cardholderName = String(entry?.cardholderName || entry?.cardholder_name || '').trim();
    const postalCode = String(entry?.postalCode || entry?.postal_code || '').trim();
    const label = String(entry?.label || '').trim();

    if (!cardNumber || !expMonth || !expYear || !cvc) return null;

    return {
        id: String(entry?.id || fallbackId || randomUUID()),
        label,
        cardNumber,
        expMonth,
        expYear,
        expDate: buildExpDate(expMonth, expYear),
        cvc,
        cardholderName,
        postalCode,
        created_at: entry?.created_at || null,
        updated_at: entry?.updated_at || null,
    };
}

function parseLegacyVccLine(line, index) {
    const text = String(line || '').trim();
    if (!text) return null;
    const [cardNumber, expMonth, expYear, cvc] = text.split('|').map((part) => String(part || '').trim());
    return normalizeVccEntry(
        { cardNumber, expMonth, expYear, cvc },
        `legacy-vcc-${index + 1}`,
    );
}

async function loadVccRawText() {
    try {
        await ensureFile(VCC_FILE);
        return await readFile(VCC_FILE, 'utf8').catch(() => '');
    } catch {
        return '';
    }
}

function parseVccFileContent(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return [];

    try {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.vccs) ? parsed.vccs : []);

        return list
            .map((item, index) => {
                if (typeof item === 'string') return parseLegacyVccLine(item, index);
                return normalizeVccEntry(item, `json-vcc-${index + 1}`);
            })
            .filter(Boolean);
    } catch {
        return text
            .split(/\r?\n/)
            .map((line, index) => parseLegacyVccLine(line, index))
            .filter(Boolean);
    }
}

async function writeVccEntries(entries = []) {
    const normalizedEntries = entries
        .map((entry, index) => normalizeVccEntry(entry, `vcc-${index + 1}`))
        .filter(Boolean);

    await writeJson(VCC_FILE, normalizedEntries, { spaces: 2 });
    return normalizedEntries;
}

export async function loadAccounts() {
    return await readAccountsFile(ACCOUNTS_FILE);
}

export async function loadSignInAccounts() {
    return await readAccountsFile(SIGN_IN_ACCOUNTS_FILE);
}

export async function loadVccEntries() {
    return parseVccFileContent(await loadVccRawText());
}

export async function saveVccEntry(entry = {}) {
    const normalized = normalizeVccEntry(entry, entry?.id || randomUUID());
    if (!normalized) {
        throw new Error('Data VCC tidak valid. Card number, expired, dan CVC wajib diisi.');
    }

    const entries = await loadVccEntries();
    const now = new Date().toISOString();
    const index = entries.findIndex((item) => String(item?.id || '').trim() === normalized.id);

    if (index >= 0) {
        entries[index] = {
            ...entries[index],
            ...normalized,
            created_at: entries[index]?.created_at || now,
            updated_at: now,
        };
    } else {
        entries.push({
            ...normalized,
            created_at: now,
            updated_at: now,
        });
    }

    const nextEntries = await writeVccEntries(entries);
    return {
        count: nextEntries.length,
        updated: index >= 0,
        index: index >= 0 ? index : nextEntries.length - 1,
        entry: nextEntries[index >= 0 ? index : nextEntries.length - 1] || null,
    };
}

export async function deleteVccEntries(ids = []) {
    const keys = new Set(
        ids
            .map((id) => String(id || '').trim())
            .filter(Boolean),
    );

    if (keys.size === 0) {
        return { removedCount: 0, count: (await loadVccEntries()).length };
    }

    const entries = await loadVccEntries();
    const filtered = entries.filter((entry) => !keys.has(String(entry?.id || '').trim()));
    const removedCount = entries.length - filtered.length;
    const nextEntries = await writeVccEntries(filtered);

    return {
        removedCount,
        count: nextEntries.length,
    };
}

export async function saveSignInAccount(account) {
    const accounts = await loadSignInAccounts();
    const email = String(account?.email || '').trim();
    const password = String(account?.password || '').trim();
    const username = String(account?.username || '').trim();
    const now = new Date().toISOString();

    const index = accounts.findIndex((item) => String(item?.email || '').trim().toLowerCase() === email.toLowerCase());
    if (index >= 0) {
        const credentialsChanged = String(accounts[index]?.password || '') !== password;
        accounts[index] = {
            ...accounts[index],
            ...account,
            email,
            password,
            username,
            updated_at: now,
            created_at: accounts[index]?.created_at || now,
            ...(credentialsChanged ? {
                last_login_status: null,
                last_login_at: null,
                last_login_error: null,
                last_login_attempt_count: null,
                last_login_url: null,
            } : {}),
        };
    } else {
        accounts.push({
            ...account,
            email,
            password,
            username,
            created_at: now,
            updated_at: now,
            last_login_status: null,
            last_login_at: null,
            last_login_error: null,
            last_login_attempt_count: null,
            last_login_url: null,
            trial_status: account?.trial_status || null,
            trial_claimed_at: account?.trial_claimed_at || null,
            trial_last_action: account?.trial_last_action || null,
            trial_last_status: account?.trial_last_status || null,
            trial_last_error: account?.trial_last_error || null,
            trial_updated_at: account?.trial_updated_at || null,
        });
    }

    await writeJson(SIGN_IN_ACCOUNTS_FILE, accounts, { spaces: 2 });

    return {
        count: accounts.length,
        updated: index >= 0,
        index: index >= 0 ? index : accounts.length - 1,
    };
}

export async function deleteSignInAccounts(emails = []) {
    const keys = new Set(
        emails
            .map((email) => String(email || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const accounts = await loadSignInAccounts();
    const filtered = accounts.filter((account) => !keys.has(String(account?.email || '').trim().toLowerCase()));
    const removedCount = accounts.length - filtered.length;

    await writeJson(SIGN_IN_ACCOUNTS_FILE, filtered, { spaces: 2 });

    return {
        removedCount,
        count: filtered.length,
    };
}

export async function updateSignInAccountLoginResult(email, result = {}) {
    const key = String(email || '').trim().toLowerCase();
    if (!key) {
        return { updated: false, reason: 'missing-email' };
    }

    const accounts = await loadSignInAccounts();
    const index = accounts.findIndex((account) => String(account?.email || '').trim().toLowerCase() === key);
    if (index < 0) {
        return { updated: false, reason: 'not-found' };
    }

    const now = new Date().toISOString();
    const attemptCount = Number(result?.attempt_count);
    const trialSnapshot = deriveStoredTrialSnapshot(accounts[index], result, now);
    accounts[index] = {
        ...accounts[index],
        last_login_status: result?.success ? 'success' : 'failed',
        last_login_at: now,
        last_login_error: result?.success ? null : String(result?.error || 'Login gagal'),
        last_login_attempt_count: Number.isFinite(attemptCount) ? attemptCount : null,
        last_login_url: result?.current_url ? String(result.current_url) : null,
        ...trialSnapshot,
        updated_at: now,
    };

    await writeJson(SIGN_IN_ACCOUNTS_FILE, accounts, { spaces: 2 });

    return {
        updated: true,
        count: accounts.length,
    };
}

export async function resetSignInAccountLoginState(emails = []) {
    const keys = new Set(
        emails
            .map((email) => String(email || '').trim().toLowerCase())
            .filter(Boolean),
    );
    if (keys.size === 0) {
        return { updatedCount: 0 };
    }

    const accounts = await loadSignInAccounts();
    let updatedCount = 0;
    const nextAccounts = accounts.map((account) => {
        const key = String(account?.email || '').trim().toLowerCase();
        if (!keys.has(key)) return account;
        updatedCount += 1;
        return {
            ...account,
            last_login_status: null,
            last_login_at: null,
            last_login_error: null,
            last_login_attempt_count: null,
            last_login_url: null,
            updated_at: new Date().toISOString(),
        };
    });

    await writeJson(SIGN_IN_ACCOUNTS_FILE, nextAccounts, { spaces: 2 });

    return { updatedCount };
}

export async function saveAccount(account) {
    const accounts = await loadAccounts();
    accounts.push({
        ...account,
        created_at: new Date().toISOString(),
    });
    await writeJson(ACCOUNTS_FILE, accounts, { spaces: 2 });
    return accounts.length;
}
