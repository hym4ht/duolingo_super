import { existsSync, readFileSync } from 'fs';
import { isRailwayRuntime, resolveConfigPath, resolveDefaultProfileDir } from './runtime-paths.js';

const CONFIG_FILE_PATH = resolveConfigPath();

const DEFAULT_CONFIG = {
    browser: 'chromium',
    persistent_profile: true,
    fresh_login: false,
    profile_dir: resolveDefaultProfileDir(),
    max_workers: 1,
    headless: true,
    force_headed_login: true,
    show_pointer: true,
    slow_mo: 70,
    timeout: 30000,
    submit_wait_seconds: 4,
    login_retry_attempts: 5,
    trial_failure_hold_seconds: 20,
    manual_password: true,
    password: '',
    proxy: {
        server: '',
        username: '',
        password: '',
    },
};

function readConfigFile() {
    if (!existsSync(CONFIG_FILE_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE_PATH, 'utf-8'));
}

function readStringEnv(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = String(raw).trim();
    return value === '' ? '' : value;
}

function readSecretEnv(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    return String(raw);
}

function readBooleanEnv(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return undefined;
}

function readNumberEnv(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function readRailwayDefaults() {
    if (!isRailwayRuntime()) return {};
    return {
        browser: 'chrome-stable',
        persistent_profile: false,
        fresh_login: false,
        profile_dir: resolveDefaultProfileDir('chrome-stable'),
        headless: true,
        force_headed_login: false,
        show_pointer: false,
        manual_password: false,
    };
}

function readEnvConfig() {
    const proxyServer = readStringEnv('PROXY_SERVER');
    const proxyUsername = readStringEnv('PROXY_USERNAME');
    const proxyPassword = readSecretEnv('PROXY_PASSWORD');
    const proxy = proxyServer !== undefined
        ? {
            server: proxyServer,
            username: proxyUsername || '',
            password: proxyPassword || '',
        }
        : undefined;

    return {
        ...(readStringEnv('BROWSER') !== undefined ? { browser: readStringEnv('BROWSER') } : {}),
        ...(readBooleanEnv('PERSISTENT_PROFILE') !== undefined ? { persistent_profile: readBooleanEnv('PERSISTENT_PROFILE') } : {}),
        ...(readBooleanEnv('FRESH_LOGIN') !== undefined ? { fresh_login: readBooleanEnv('FRESH_LOGIN') } : {}),
        ...(readStringEnv('PROFILE_DIR') !== undefined ? { profile_dir: resolveDefaultProfileDir() } : {}),
        ...(readBooleanEnv('HEADLESS') !== undefined ? { headless: readBooleanEnv('HEADLESS') } : {}),
        ...(readBooleanEnv('FORCE_HEADED_LOGIN') !== undefined ? { force_headed_login: readBooleanEnv('FORCE_HEADED_LOGIN') } : {}),
        ...(readBooleanEnv('SHOW_POINTER') !== undefined ? { show_pointer: readBooleanEnv('SHOW_POINTER') } : {}),
        ...(readNumberEnv('SLOW_MO') !== undefined ? { slow_mo: readNumberEnv('SLOW_MO') } : {}),
        ...(readNumberEnv('TIMEOUT') !== undefined ? { timeout: readNumberEnv('TIMEOUT') } : {}),
        ...(readNumberEnv('MAX_WORKERS') !== undefined ? { max_workers: readNumberEnv('MAX_WORKERS') } : {}),
        ...(readNumberEnv('SUBMIT_WAIT_SECONDS') !== undefined ? { submit_wait_seconds: readNumberEnv('SUBMIT_WAIT_SECONDS') } : {}),
        ...(readNumberEnv('LOGIN_RETRY_ATTEMPTS') !== undefined ? { login_retry_attempts: readNumberEnv('LOGIN_RETRY_ATTEMPTS') } : {}),
        ...(readNumberEnv('TRIAL_FAILURE_HOLD_SECONDS') !== undefined ? { trial_failure_hold_seconds: readNumberEnv('TRIAL_FAILURE_HOLD_SECONDS') } : {}),
        ...(readBooleanEnv('MANUAL_PASSWORD') !== undefined ? { manual_password: readBooleanEnv('MANUAL_PASSWORD') } : {}),
        ...(readSecretEnv('DEFAULT_ACCOUNT_PASSWORD') !== undefined ? { password: readSecretEnv('DEFAULT_ACCOUNT_PASSWORD') } : {}),
        ...(proxy ? { proxy } : {}),
    };
}

export function loadConfig() {
    const config = {
        ...DEFAULT_CONFIG,
        ...readConfigFile(),
        ...readRailwayDefaults(),
        ...readEnvConfig(),
    };

    return {
        ...config,
        profile_dir: String(config.profile_dir || resolveDefaultProfileDir()).trim() || resolveDefaultProfileDir(),
        proxy: {
            server: String(config.proxy?.server || '').trim(),
            username: String(config.proxy?.username || '').trim(),
            password: String(config.proxy?.password || ''),
        },
    };
}

export function buildPublicConfig(config = {}) {
    return {
        browser: config.browser,
        persistent_profile: config.persistent_profile,
        fresh_login: config.fresh_login,
        profile_dir: config.profile_dir,
        headless: config.headless,
        force_headed_login: config.force_headed_login,
        show_pointer: config.show_pointer,
        slow_mo: config.slow_mo,
        timeout: config.timeout,
        max_workers: config.max_workers,
        submit_wait_seconds: config.submit_wait_seconds,
        login_retry_attempts: config.login_retry_attempts,
        trial_failure_hold_seconds: config.trial_failure_hold_seconds,
        manual_password: config.manual_password,
        default_password_configured: Boolean(String(config.password || '').trim()),
        proxy_enabled: Boolean(String(config.proxy?.server || '').trim()),
    };
}
