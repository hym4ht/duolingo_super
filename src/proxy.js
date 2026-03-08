const PROXY_CHECK_URLS = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
    'https://httpbin.org/ip',
];

function extractIp(payload) {
    const text = String(payload || '').trim();
    if (!text) return null;

    try {
        const parsed = JSON.parse(text);
        const candidate = parsed.ip || parsed.origin || parsed.query;
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.split(',')[0].trim();
        }
    } catch { /* ignore */ }

    const match = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return match ? match[0] : null;
}

export function normalizeProxyConfig(proxy) {
    const rawServer = String(proxy?.server || '').trim();
    if (!rawServer) return undefined;

    return {
        server: rawServer.includes('://') ? rawServer : `http://${rawServer}`,
        ...(proxy?.username ? { username: String(proxy.username).trim() } : {}),
        ...(proxy?.password ? { password: String(proxy.password) } : {}),
    };
}

export function describeProxy(proxy) {
    const normalized = normalizeProxyConfig(proxy);
    if (!normalized) return 'off';
    return normalized.username
        ? `${normalized.server} | user=${normalized.username}`
        : normalized.server;
}

export async function verifyBrowserProxy({ page, proxy, log = () => { }, timeout = 12000 }) {
    const normalized = normalizeProxyConfig(proxy);
    if (!normalized) {
        log('[PROXY] off');
        return { enabled: false, verified: false };
    }

    log(`[PROXY] configured | server=${normalized.server}${normalized.username ? ` | user=${normalized.username}` : ''}`);

    let lastError;

    for (const url of PROXY_CHECK_URLS) {
        try {
            log(`[PROXY] validating | via=${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            const body = await page.textContent('body');
            const ip = extractIp(body);

            if (!ip) {
                throw new Error('IP tidak terbaca dari response');
            }

            log(`[PROXY] active | exit_ip=${ip} | via=${url}`);
            return { enabled: true, verified: true, ip, via: url };
        } catch (error) {
            lastError = error;
            log(`[PROXY] check_failed | via=${url} | ${error.message}`);
        }
    }

    log(`[PROXY] validation_failed | ${lastError?.message || 'unknown error'}`);
    return {
        enabled: true,
        verified: false,
        error: lastError?.message || 'unknown error',
    };
}
