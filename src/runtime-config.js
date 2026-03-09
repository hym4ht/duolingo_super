import { resolve } from 'path';
import { resolveDefaultProfileDir } from './runtime-paths.js';

// Semua entry point pakai normalisasi yang sama supaya mode CLI, web,
// dan batch runner tidak punya aturan konfigurasi yang saling berbeda.
export function normalizeRuntimeConfig(baseConfig = {}, overrides = {}) {
    const browser = String(overrides.browser ?? baseConfig.browser ?? 'chromium').trim().toLowerCase();
    const baseBrowser = String(baseConfig.browser ?? 'chromium').trim().toLowerCase();
    const persistentProfile = overrides.persistent_profile ?? baseConfig.persistent_profile ?? true;
    const browserDefaultProfileDir = resolveDefaultProfileDir(browser);
    const rawProfileDir = String(overrides.profile_dir ?? baseConfig.profile_dir ?? browserDefaultProfileDir).trim();
    const inheritedDefaultProfileDirs = new Set([
        resolveDefaultProfileDir('chromium'),
        resolveDefaultProfileDir(baseBrowser),
    ]);
    const profileDir = overrides.profile_dir === undefined && inheritedDefaultProfileDirs.has(resolve(rawProfileDir))
        ? browserDefaultProfileDir
        : rawProfileDir;
    const headless = overrides.headless ?? baseConfig.headless;
    const slowMo = Number(overrides.slow_mo ?? baseConfig.slow_mo);
    const timeout = Number(overrides.timeout ?? baseConfig.timeout);
    const maxWorkers = Number(overrides.max_workers ?? baseConfig.max_workers);
    const password = String(overrides.password ?? baseConfig.password ?? '');
    const manualPassword = overrides.manual_password ?? baseConfig.manual_password ?? false;
    const submitWaitSeconds = overrides.submit_wait_seconds ?? baseConfig.submit_wait_seconds;
    const loginRetryAttempts = overrides.login_retry_attempts ?? baseConfig.login_retry_attempts;
    const trialFailureHoldSeconds = overrides.trial_failure_hold_seconds ?? baseConfig.trial_failure_hold_seconds;
    const afterLoginAction = String(overrides.after_login_action ?? baseConfig.after_login_action ?? 'none').trim().toLowerCase();
    const forceHeadedLogin = overrides.force_headed_login ?? baseConfig.force_headed_login;
    const showPointer = overrides.show_pointer ?? baseConfig.show_pointer;
    const debugSteps = overrides.debug_steps ?? baseConfig.debug_steps;
    const vccData = overrides.vccData ?? baseConfig.vccData;
    const proxy = overrides.proxy?.server ? {
        server: String(overrides.proxy.server).trim(),
        username: overrides.proxy.username ? String(overrides.proxy.username) : undefined,
        password: overrides.proxy.password ? String(overrides.proxy.password) : undefined,
    } : undefined;

    return {
        ...baseConfig,
        browser,
        persistent_profile: persistentProfile !== false,
        profile_dir: profileDir,
        headless: Boolean(headless),
        slow_mo: Number.isFinite(slowMo) ? slowMo : baseConfig.slow_mo,
        timeout: Number.isFinite(timeout) ? timeout : baseConfig.timeout,
        // Chromium persistent profile tidak aman dipakai paralel karena profilnya terkunci.
        max_workers: persistentProfile !== false
            ? 1
            : (Number.isFinite(maxWorkers) ? Math.max(1, maxWorkers) : baseConfig.max_workers),
        password,
        manual_password: manualPassword === true,
        submit_wait_seconds: submitWaitSeconds,
        login_retry_attempts: Number.isFinite(Number(loginRetryAttempts))
            ? Number(loginRetryAttempts)
            : baseConfig.login_retry_attempts,
        trial_failure_hold_seconds: Number.isFinite(Number(trialFailureHoldSeconds))
            ? Math.max(0, Number(trialFailureHoldSeconds))
            : baseConfig.trial_failure_hold_seconds,
        after_login_action: afterLoginAction,
        force_headed_login: forceHeadedLogin === true,
        show_pointer: showPointer !== false,
        debug_steps: debugSteps !== false,
        ...(vccData ? { vccData } : {}),
        ...(proxy ? { proxy } : {}),
    };
}

export function buildRuntimeLoginConfig(baseConfig = {}, passwordMode = 'auto') {
    const manualPassword = passwordMode === 'manual';

    return normalizeRuntimeConfig(baseConfig, {
        manual_password: manualPassword,
        headless: manualPassword ? false : baseConfig.headless,
        max_workers: manualPassword ? 1 : baseConfig.max_workers,
    });
}
