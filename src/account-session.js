import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

// Helper ini dipakai bersama oleh CLI, web UI, dan runner Playwright
// supaya aturan validasi akun dan lokasi session profile tetap konsisten.
export const LOGIN_STATE_KEYS = {
    pending: 'pending',
    success: 'success',
    failed: 'failed',
};

export const TRIAL_STATE_KEYS = {
    unknown: 'unknown',
    claimed: 'claimed',
    submitted: 'submitted',
    failed: 'failed',
};

const CLAIMED_TRIAL_STATUS = new Set(['claimed', 'claim', 'success', 'active', 'trial-active']);
const SUBMITTED_TRIAL_STATUS = new Set(['submitted', 'processing', 'pending', 'payment-submitted', 'vcc-injected-success']);
const FAILED_TRIAL_STATUS = new Set(['failed', 'error', 'rejected', 'vcc-inject-failed']);

export function normalizeLoginAccount(account, runtimeConfig = {}) {
    const email = String(account?.email || '').trim();
    const password = String(account?.password || runtimeConfig.password || '').trim();
    const username = String(account?.username || '').trim() || null;

    if (!email || (!password && runtimeConfig.manual_password !== true)) {
        return null;
    }

    return {
        ...account,
        email,
        password,
        username,
    };
}

export function hasUsablePassword(account, runtimeConfig = {}) {
    if (runtimeConfig.manual_password === true) return true;
    return Boolean(String(account?.password || runtimeConfig.password || '').trim());
}

export function getLoginAccountsForMode(accounts = [], runtimeConfig = {}) {
    return accounts.filter((account) => Boolean(normalizeLoginAccount(account, runtimeConfig)));
}

export function sanitizeSessionKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'default';
}

export function normalizeTrialStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    if (CLAIMED_TRIAL_STATUS.has(status)) return TRIAL_STATE_KEYS.claimed;
    if (SUBMITTED_TRIAL_STATUS.has(status)) return TRIAL_STATE_KEYS.submitted;
    if (FAILED_TRIAL_STATUS.has(status)) return TRIAL_STATE_KEYS.failed;
    return TRIAL_STATE_KEYS.unknown;
}

export function resolveBaseProfileDir(runtimeConfig = {}) {
    return resolve(String(runtimeConfig?.profile_dir || '.profiles/duolingo-chromium'));
}

export function resolveLoginSessionDir(account, runtimeConfig = {}) {
    const baseDir = resolveBaseProfileDir(runtimeConfig);
    if (runtimeConfig?.persistent_profile === false) return baseDir;

    const key = sanitizeSessionKey(account?.email || account?.username || 'session');
    return resolve(baseDir, 'login', key);
}

export function hasStoredSessionDir(dir) {
    try {
        return existsSync(dir) && readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

export function getSessionState(account, runtimeConfig = {}) {
    if (runtimeConfig?.persistent_profile === false) {
        return {
            hasSession: false,
            label: 'off',
            dir: resolveBaseProfileDir(runtimeConfig),
        };
    }

    const dir = resolveLoginSessionDir(account, runtimeConfig);
    const hasSession = hasStoredSessionDir(dir);

    return {
        hasSession,
        label: hasSession ? 'tersimpan' : 'kosong',
        dir,
    };
}

export function getLoginState(account, sessionState, runtimeConfig = {}) {
    const status = String(account?.last_login_status || '').trim().toLowerCase();

    if (status === 'success' && runtimeConfig?.persistent_profile !== false && !sessionState?.hasSession) {
        return {
            key: LOGIN_STATE_KEYS.pending,
            label: 'belum dicek',
        };
    }

    if (status === 'success') {
        return {
            key: LOGIN_STATE_KEYS.success,
            label: 'bisa login',
        };
    }

    if (status === 'failed') {
        return {
            key: LOGIN_STATE_KEYS.failed,
            label: 'gagal',
        };
    }

    return {
        key: LOGIN_STATE_KEYS.pending,
        label: 'belum dicek',
    };
}

export function getTrialState(account = {}) {
    const key = normalizeTrialStatus(account?.trial_status);

    if (key === TRIAL_STATE_KEYS.claimed) {
        return {
            key,
            label: 'claimed',
        };
    }

    if (key === TRIAL_STATE_KEYS.submitted) {
        return {
            key,
            label: 'submit',
        };
    }

    if (key === TRIAL_STATE_KEYS.failed) {
        return {
            key,
            label: 'gagal',
        };
    }

    return {
        key: TRIAL_STATE_KEYS.unknown,
        label: 'belum',
    };
}
