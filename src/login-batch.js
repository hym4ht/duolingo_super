import pLimit from 'p-limit';
import { normalizeLoginAccount } from './account-session.js';
import { loginDuolingo } from './duolingo.js';
import { normalizeRuntimeConfig } from './runtime-config.js';
import { loadSignInAccounts, saveFamilyLink, updateSignInAccountLoginResult } from './storage.js';

function emitLog(onLog, message) {
    if (typeof onLog === 'function') onLog(message);
}

async function loginSingleAccount({ account, config, onLog, index, total }) {
    const credentials = normalizeLoginAccount(account, config);
    if (!credentials) {
        const email = String(account?.email || '').trim();
        emitLog(onLog, `[LOGIN-BATCH][${index}/${total}] SKIP account tidak valid | ${email || '-'}`);
        return {
            success: false,
            email,
            username: String(account?.username || '').trim() || null,
            error: config.manual_password === true
                ? 'Akun tidak punya email yang valid'
                : 'Akun tidak punya email/password yang valid',
        };
    }

    emitLog(onLog, `[LOGIN-BATCH][${index}/${total}] START ${credentials.email}`);
    const result = await loginDuolingo(credentials, {
        ...config,
        onLog: (line) => emitLog(onLog, line),
    });
    await updateSignInAccountLoginResult(credentials.email, result).catch(() => { });
    if (result?.family_invite_link) {
        await saveFamilyLink({
            email: credentials.email,
            username: credentials.username,
            invite_link: result.family_invite_link,
        }).catch(() => { });
    }

    if (result.success) {
        emitLog(onLog, `[LOGIN-BATCH][${index}/${total}] DONE ${credentials.email}`);
    } else {
        emitLog(onLog, `[LOGIN-BATCH][${index}/${total}] FAIL ${credentials.email} | ${result.error || '-'}`);
    }

    return {
        ...result,
        email: result.email || credentials.email,
        username: result.username || credentials.username,
    };
}

export async function loginAccountsBatch({ count, baseConfig, overrides = {}, onLog, accounts }) {
    const runtimeConfig = normalizeRuntimeConfig(baseConfig, overrides);
    const sourceAccounts = Array.isArray(accounts) && accounts.length > 0
        ? accounts
        : await loadSignInAccounts();

    const normalizedAccounts = sourceAccounts
        .map((account) => normalizeLoginAccount(account, runtimeConfig))
        .filter(Boolean);

    if (normalizedAccounts.length === 0) {
        emitLog(onLog, '[LOGIN-BATCH] tidak ada akun valid di sign-in-account.json');
        return {
            count: 0,
            successCount: 0,
            failedCount: 0,
            results: [],
        };
    }

    const safeCount = Math.max(1, Math.min(Number(count) || 1, normalizedAccounts.length));
    if (runtimeConfig.persistent_profile) {
        emitLog(onLog, `[LOGIN-BATCH] persistent profile aktif | base_profile=${runtimeConfig.profile_dir}`);
    }
    if (runtimeConfig.fresh_login === true) {
        emitLog(onLog, '[LOGIN-BATCH] fresh login aktif | profile akun dibersihkan sebelum tiap attempt');
    }
    emitLog(onLog, `[LOGIN-BATCH] START total=${safeCount} workers=${runtimeConfig.max_workers}`);

    const limit = pLimit(runtimeConfig.max_workers);
    const selectedAccounts = normalizedAccounts.slice(0, safeCount);
    const tasks = selectedAccounts.map((account, index) => limit(() => loginSingleAccount({
        account,
        config: runtimeConfig,
        onLog,
        index: index + 1,
        total: safeCount,
    })));

    const settled = await Promise.allSettled(tasks);
    const results = settled.map((item, index) => {
        if (item.status === 'fulfilled') return item.value;
        const fallback = selectedAccounts[index];
        return {
            success: false,
            email: fallback?.email || null,
            username: fallback?.username || null,
            error: item.reason?.message || 'Unknown error',
        };
    });

    const successCount = results.filter((row) => row.success).length;
    const failedCount = results.length - successCount;
    emitLog(onLog, `[LOGIN-BATCH] FINISH success=${successCount} failed=${failedCount}`);

    return {
        count: safeCount,
        successCount,
        failedCount,
        results,
    };
}
