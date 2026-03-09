import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

export function resolveProjectPath(...parts) {
    return resolve(PROJECT_ROOT, ...parts);
}

export function resolveConfigPath() {
    const customPath = String(process.env.CONFIG_PATH || '').trim();
    return customPath ? resolve(customPath) : resolveProjectPath('config.json');
}

export function resolveDataDir() {
    const customDir = String(process.env.DATA_DIR || '').trim();
    return customDir ? resolve(customDir) : PROJECT_ROOT;
}

export function resolveDataFile(name) {
    return join(resolveDataDir(), name);
}

function normalizeBrowserKey(browser = 'chromium') {
    const normalized = String(browser || 'chromium').trim().toLowerCase();
    if (['chrome', 'chrome-stable', 'google-chrome', 'google-chrome-stable'].includes(normalized)) {
        return 'chrome-stable';
    }
    return 'chromium';
}

export function resolveDefaultProfileDir(browser = 'chromium') {
    const explicitProfileDir = String(process.env.PROFILE_DIR || '').trim();
    if (explicitProfileDir) return resolve(explicitProfileDir);
    const profileFolder = normalizeBrowserKey(browser) === 'chrome-stable'
        ? 'duolingo-google-chrome'
        : 'duolingo-chromium';
    return resolve(resolveDataDir(), '.profiles', profileFolder);
}

export function resolveDebugDir() {
    const explicitDebugDir = String(process.env.DEBUG_DIR || '').trim();
    if (explicitDebugDir) return resolve(explicitDebugDir);
    return resolve(resolveDataDir(), 'debug');
}

export function isRailwayRuntime() {
    return Boolean(
        String(process.env.RAILWAY_PROJECT_ID || '').trim()
        || String(process.env.RAILWAY_ENVIRONMENT_ID || '').trim()
        || String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim(),
    );
}
