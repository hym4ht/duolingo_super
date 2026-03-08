// src/duolingo.js
// Handles Duolingo browser automation using Playwright Chromium
// Selectors 100% akurat dari Playwright codegen (hasil.js)
//
// Flow yang direkam:
//   1. Klik bahasa Inggris [data-test="flag-english language-card"]
//   2. Klik continue [data-test="funboarding-continue-button"] beberapa kali
//   3. Pilih opsi radio secara acak di tiap survey step
//   4. Dismiss notif [data-test="block-button"]
//   5. Pilih jalur belajar → klik continue → quit lesson
//   6. Klik create profile [data-test="create-profile-juicy"]
//   7. Isi umur [data-test="age-input"] → continue
//   8. Isi email + password → submit

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    resolveBaseProfileDir,
    resolveLoginSessionDir,
} from './account-session.js';
import { normalizeTrialPaymentData } from './payment.js';
import { normalizeProxyConfig, verifyBrowserProxy } from './proxy.js';
import { resolveDebugDir } from './runtime-paths.js';

const SELECTORS = {
    englishCard: '[data-test="flag-english language-card"]',
    funboardingContinue: '[data-test="funboarding-continue-button"]',
    otherOption: '[data-test="other"]',
    blockButton: '[data-test="block-button"]',
    quitButton: '[data-test="quit-button"]',
    profileAvatar: '[data-test="profile-menu"] img, [data-test="user-avatar"] img, img[alt*="profile" i]',
    createProfile: '[data-test="create-profile-juicy"]',
    ageInput: '[data-test="age-input"]',
    ageContinue: '[data-test="continue-button"]',
    cookieBanner: '#onetrust-banner-sdk',
    cookieReject: '#onetrust-reject-all-handler',
    cookieAccept: '#onetrust-accept-btn-handler',
};

const pointerState = new WeakMap();
const CONTINUE_BUTTON_TEXT = /lanjut|continue|mulai|start|selanjutnya|teruskan/i;
const CONTINUE_BUTTON_SELECTOR = `${SELECTORS.funboardingContinue}, [data-test="continue-button"]`;
const HDYHAU_OPTION_SELECTOR = '[data-test="hdyhau-other"], [data-test="hdyhau-googleSearch"], [data-test="hdyhau-youtube"], [data-test="hdyhau-facebookOrInstagram"], [data-test="hdyhau-tiktok"], [data-test="hdyhau-friendsOrFamily"], [data-test="hdyhau-tv"], [data-test="hdyhau-newsArticleOrBlog"]';
const REGISTER_BUTTON_SELECTOR = '[data-test="register-button"], button[type="submit"], button:has-text("Buat Akun"), button:has-text("Daftar"), button:has-text("Gabung")';
const LOGIN_EMAIL_SELECTOR = '[data-test="email-input"], input[type="email"], input[name="email"], input[name="identifier"], input[autocomplete="email"], input[placeholder*="Email"], input[placeholder*="email"]';
const LOGIN_PASSWORD_SELECTOR = 'input[type="password"], input[name="password"], [data-test="password-input"]';
const LOGIN_BUTTON_SELECTOR = '[data-test="login-button"], [data-test="register-button"], button[type="submit"], button:has-text("Masuk"), button:has-text("Log in"), button:has-text("Login")';
const OPEN_LOGIN_TEXT = /masuk|log in|login|already have an account|have an account|sudah punya akun/i;
const OPEN_LOGIN_BUTTON_SELECTOR = '[data-test="login-button"], [data-test="have-account"], a[href*="log-in"], button:has-text("Masuk"), a:has-text("Masuk"), button:has-text("Log in"), a:has-text("Log in"), button:has-text("Login"), a:has-text("Login"), button:has-text("I ALREADY HAVE AN ACCOUNT"), button:has-text("Already have an account"), button:has-text("Sudah punya akun")';
const LOGIN_API_URL_PATTERN = /\/2023-05-23\/login(?:\?|$)/i;
const TRIAL_CTA_TEXT = /coba 1 minggu gratis|try 1 week free/i;
const PLUS_CONTINUE_SELECTOR = '[data-test="plus-continue"], button:has-text("Lanjutkan"), button:has-text("Continue")';
const TRIAL_PLAN_SELECTOR = '[data-test*="stripe_subscription"][data-test*="trial"], [data-test*="subscription_premium_trial"], [data-test*="premium_trial"], [data-test*="trial7"]';
const STRIPE_IFRAME_SELECTOR = 'iframe[name^="__privateStripeFrame"], iframe[src*="stripe.com"]';
const LEARN_EXIT_SELECTOR = [
    SELECTORS.quitButton,
    '[data-test="close-button"]',
    '[data-test*="close"]',
    'button[aria-label*="close" i]',
    'button[aria-label*="tutup" i]',
    'button[aria-label*="quit" i]',
    'button[aria-label*="keluar" i]',
    'button:has-text("✕")',
    'button:has-text("×")',
    'button:has-text("X")',
    'button:has-text("Keluar")',
    'button:has-text("Quit")',
    'button:has-text("Close")',
].join(', ');
const LOGIN_ERROR_PATTERNS = [
    /wrong password|incorrect password|invalid password|password salah|kata sandi salah/i,
    /wrong (email|username)|incorrect (email|username)|invalid (email|username)/i,
    /wrong (email|username) or password|incorrect (email|username) or password|email atau kata sandi salah|nama pengguna atau kata sandi salah/i,
    /wrong|incorrect|invalid|salah|try again|coba lagi|captcha|blocked|terlalu banyak|suspicious/i,
];

function generateUsername(email) {
    const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
    const rand = Math.floor(Math.random() * 9000) + 1000;
    return `${prefix}${rand}`;
}

function generateAdultAge() {
    return String(Math.floor(Math.random() * 15) + 18);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function randomInt(min, max) {
    return Math.floor(randomBetween(min, max + 1));
}

function cubicBezierPoint(start, control1, control2, end, t) {
    const inv = 1 - t;
    return {
        x: (inv ** 3 * start.x)
            + (3 * inv * inv * t * control1.x)
            + (3 * inv * t * t * control2.x)
            + (t ** 3 * end.x),
        y: (inv ** 3 * start.y)
            + (3 * inv * inv * t * control1.y)
            + (3 * inv * t * t * control2.y)
            + (t ** 3 * end.y),
    };
}

function mountPointerOverlayScript() {
    const POINTER_ID = '__duo-playwright-pointer';
    const STYLE_ID = '__duo-playwright-pointer-style';

    const ensurePointer = () => {
        const doc = document;
        if (!doc?.documentElement) return null;

        if (!doc.getElementById(STYLE_ID)) {
            const style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `
                #${POINTER_ID} {
                    position: fixed;
                    left: 0;
                    top: 0;
                    width: 18px;
                    height: 18px;
                    border-radius: 999px;
                    border: 2px solid rgba(22, 163, 74, 0.95);
                    background: rgba(134, 239, 172, 0.35);
                    box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
                    transform: translate(-50%, -50%);
                    pointer-events: none;
                    z-index: 2147483647;
                    opacity: 0.95;
                    transition: transform 80ms ease, box-shadow 80ms ease;
                }

                #${POINTER_ID}[data-pressed="true"] {
                    box-shadow: 0 0 0 7px rgba(22, 163, 74, 0.18);
                    transform: translate(-50%, -50%) scale(0.92);
                }
            `;
            (doc.head || doc.documentElement).appendChild(style);
        }

        let pointer = doc.getElementById(POINTER_ID);
        if (!pointer) {
            pointer = doc.createElement('div');
            pointer.id = POINTER_ID;
            (doc.body || doc.documentElement).appendChild(pointer);
        }

        return pointer;
    };

    const syncPointer = (event) => {
        const pointer = ensurePointer();
        if (!pointer) return;
        pointer.style.left = `${event.clientX}px`;
        pointer.style.top = `${event.clientY}px`;
    };

    if (!window.__duoPointerOverlayMounted) {
        window.__duoPointerOverlayMounted = true;
        window.addEventListener('mousemove', syncPointer, { capture: true, passive: true });
        window.addEventListener('mousedown', () => {
            const pointer = ensurePointer();
            if (pointer) pointer.dataset.pressed = 'true';
        }, true);
        window.addEventListener('mouseup', () => {
            const pointer = ensurePointer();
            if (pointer) pointer.dataset.pressed = 'false';
        }, true);
        window.addEventListener('focus', () => {
            ensurePointer();
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensurePointer();
        }, { once: true });
    } else {
        ensurePointer();
    }
}

function getPointerSnapshot(page) {
    if (!pointerState.has(page)) {
        pointerState.set(page, { x: 72, y: 72 });
    }
    return pointerState.get(page);
}

async function ensurePointerOverlay(page) {
    await page.evaluate(mountPointerOverlayScript).catch(() => { });
}

async function humanPause(min, max) {
    await sleep(randomInt(min, max));
}

async function movePointerSegment(page, start, end, maxWidth, maxHeight, stepBias = 0) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const distance = Math.hypot(deltaX, deltaY);
    const steps = clamp(Math.round(distance / 18) + stepBias, 10, 48);
    const directionX = distance === 0 ? 0 : deltaX / distance;
    const directionY = distance === 0 ? 0 : deltaY / distance;
    const normalX = -directionY;
    const normalY = directionX;
    const curveStrength = clamp(distance * randomBetween(0.08, 0.18), 12, 64);
    const curveDirection = Math.random() < 0.5 ? -1 : 1;

    const control1 = {
        x: clamp(start.x + (deltaX * randomBetween(0.18, 0.32)) + (normalX * curveStrength * curveDirection), 6, maxWidth),
        y: clamp(start.y + (deltaY * randomBetween(0.18, 0.32)) + (normalY * curveStrength * curveDirection), 6, maxHeight),
    };
    const control2 = {
        x: clamp(start.x + (deltaX * randomBetween(0.62, 0.82)) - (normalX * curveStrength * curveDirection * randomBetween(0.35, 0.7)), 6, maxWidth),
        y: clamp(start.y + (deltaY * randomBetween(0.62, 0.82)) - (normalY * curveStrength * curveDirection * randomBetween(0.35, 0.7)), 6, maxHeight),
    };

    for (let i = 1; i <= steps; i += 1) {
        const progress = i / steps;
        const eased = progress < 0.5
            ? 2 * progress * progress
            : 1 - (Math.pow(-2 * progress + 2, 2) / 2);
        const point = cubicBezierPoint(start, control1, control2, end, eased);
        const remaining = 1 - progress;
        const jitterX = i === steps ? 0 : randomBetween(-1.8, 1.8) * remaining;
        const jitterY = i === steps ? 0 : randomBetween(-1.8, 1.8) * remaining;
        await page.mouse.move(
            clamp(point.x + jitterX, 6, maxWidth),
            clamp(point.y + jitterY, 6, maxHeight),
        );
        await sleep(randomInt(6, 18) + (progress > 0.82 ? randomInt(4, 16) : 0));
    }
}

async function movePointer(page, targetX, targetY, options = {}) {
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const state = getPointerSnapshot(page);
    const safeTargetX = clamp(targetX, 6, Math.max(6, viewport.width - 6));
    const safeTargetY = clamp(targetY, 6, Math.max(6, viewport.height - 6));
    const maxWidth = Math.max(6, viewport.width - 6);
    const maxHeight = Math.max(6, viewport.height - 6);
    const distance = Math.hypot(safeTargetX - state.x, safeTargetY - state.y);
    const start = { x: state.x, y: state.y };
    const end = { x: safeTargetX, y: safeTargetY };

    await ensurePointerOverlay(page);

    if (distance > 150 && options.allowOvershoot !== false && Math.random() < 0.72) {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const overshootDistance = clamp(distance * randomBetween(0.02, 0.045), 5, 18);
        const overshoot = {
            x: clamp(end.x + (Math.cos(angle) * overshootDistance), 6, maxWidth),
            y: clamp(end.y + (Math.sin(angle) * overshootDistance), 6, maxHeight),
        };
        await movePointerSegment(page, start, overshoot, maxWidth, maxHeight, 2);
        await humanPause(30, 90);
        await movePointerSegment(page, overshoot, end, maxWidth, maxHeight, -2);
    } else {
        await movePointerSegment(page, start, end, maxWidth, maxHeight);
    }

    state.x = safeTargetX;
    state.y = safeTargetY;
}

async function movePointerToLocator(page, locator) {
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    const box = await locator.boundingBox().catch(() => null);
    if (!box) return null;

    const offsetX = Math.min(12, box.width * 0.18);
    const offsetY = Math.min(10, box.height * 0.18);
    const targetX = box.x + (box.width / 2) + randomBetween(-offsetX, offsetX);
    const targetY = box.y + (box.height / 2) + randomBetween(-offsetY, offsetY);
    await movePointer(page, targetX, targetY);
    return { x: targetX, y: targetY, box };
}

async function typeLikeHuman(locator, value) {
    const text = String(value);
    let cursor = 0;

    while (cursor < text.length) {
        const remaining = text.length - cursor;
        const chunkSize = Math.min(remaining, randomInt(1, remaining > 4 ? 3 : 2));
        const chunk = text.slice(cursor, cursor + chunkSize);
        await locator.type(chunk, { delay: randomInt(45, 110) });
        cursor += chunk.length;
        if (cursor >= text.length) break;

        const lastChar = chunk[chunk.length - 1];
        const pause = /[@._-]/.test(lastChar) ? randomInt(120, 240) : randomInt(35, 135);
        await sleep(pause);
    }
}

async function clickLocator(page, locator, options = {}) {
    const timeout = options.timeout;
    const force = options.force === true;
    const allowForceFallback = options.allowForceFallback !== false;
    const humanize = options.humanize !== false;

    let targetPoint = null;
    if (await locator.isVisible().catch(() => false)) {
        targetPoint = await movePointerToLocator(page, locator).catch(() => null);
        if (humanize) {
            await humanPause(50, 170);
            if (targetPoint && Math.random() < 0.38) {
                const nudgeX = targetPoint.x + randomBetween(-3.2, 3.2);
                const nudgeY = targetPoint.y + randomBetween(-2.8, 2.8);
                await movePointer(page, nudgeX, nudgeY, { allowOvershoot: false }).catch(() => { });
                await humanPause(25, 70);
                await movePointer(page, targetPoint.x, targetPoint.y, { allowOvershoot: false }).catch(() => { });
            }
        }
    }

    try {
        await locator.click({ timeout, force });
        if (humanize) await humanPause(45, 120);
        return true;
    } catch {
        if (!force && allowForceFallback) {
            return await locator.click({ timeout, force: true }).then(async () => {
                if (humanize) await humanPause(45, 120);
                return true;
            }).catch(() => false);
        }
        return false;
    }
}

async function fillField(page, locator, value, timeout = 10000) {
    await locator.waitFor({ state: 'visible', timeout });
    await movePointerToLocator(page, locator).catch(() => { });
    await humanPause(60, 180);
    await locator.click({ timeout: Math.min(timeout, 2500) }).catch(async () => {
        await locator.click({ timeout: Math.min(timeout, 2500), force: true });
    }).catch(() => { });
    await humanPause(40, 140);
    await locator.fill('');
    await typeLikeHuman(locator, value);
    await humanPause(35, 110);
}

async function fillCredentialField(page, locator, value, options = {}) {
    const expected = String(value ?? '');
    const timeout = options.timeout ?? 10000;
    const label = options.label ?? 'field';

    await fillField(page, locator, expected, timeout);
    let currentValue = await locator.inputValue().catch(() => '');
    if (currentValue === expected) return;

    await humanPause(60, 140);
    await locator.fill(expected).catch(() => { });
    currentValue = await locator.inputValue().catch(() => '');
    if (currentValue === expected) return;

    await locator.evaluate((element, nextValue) => {
        element.focus();
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.value = nextValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }, expected).catch(() => { });

    currentValue = await locator.inputValue().catch(() => '');
    if (currentValue === expected) return;

    throw new Error(`Nilai ${label} tidak cocok sebelum submit | expected=${expected.length} chars | actual=${currentValue.length} chars`);
}

async function waitForManualPasswordEntry(page, locator, options = {}) {
    const timeout = options.timeout ?? 300000;
    const stableMs = options.stableMs ?? 1200;
    const label = options.label ?? 'password manual';
    const startedAt = Date.now();
    let lastValue = '';
    let lastChangedAt = Date.now();

    await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 15000) });
    await movePointerToLocator(page, locator).catch(() => { });
    await humanPause(60, 180);
    await locator.click({ timeout: 3000 }).catch(async () => {
        await locator.click({ timeout: 3000, force: true });
    }).catch(() => { });
    await humanPause(40, 120);
    await locator.fill('').catch(() => { });

    while ((Date.now() - startedAt) < timeout) {
        if (!await locator.isVisible().catch(() => false)) {
            return lastValue;
        }

        const currentValue = await locator.inputValue().catch(() => '');
        if (currentValue !== lastValue) {
            lastValue = currentValue;
            lastChangedAt = Date.now();
        }

        if (currentValue && (Date.now() - lastChangedAt) >= stableMs) {
            return currentValue;
        }

        await sleep(250);
    }

    throw new Error(`${label} belum diisi sampai timeout`);
}

async function gotoWithRetry(page, url, options = {}) {
    const maxTry = options.maxTry ?? 3;
    const timeout = options.timeout ?? 90000;
    let lastError;
    for (let attempt = 1; attempt <= maxTry; attempt += 1) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            return true;
        } catch (error) {
            lastError = error;
            await sleep(1200 * attempt);
        }
    }
    throw lastError;
}

async function safeClick(page, selector, timeout = 3000) {
    try {
        const targets = page.locator(selector);
        const total = await targets.count();
        if (total === 0) return false;

        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            for (let i = 0; i < total; i += 1) {
                const el = targets.nth(i);
                if (await el.isVisible().catch(() => false)) {
                    return await clickLocator(page, el, {
                        timeout: Math.max(500, deadline - Date.now()),
                        allowForceFallback: false,
                    });
                }
            }
            await sleep(120);
        }
    } catch { /* ignore */ }
    return false;
}

async function domClick(page, selector) {
    const target = page.locator(selector).first();
    const exists = await target.count().catch(() => 0);
    if (exists === 0) return false;

    return await target.evaluate((element) => {
        element.click();
        return true;
    }).catch(() => false);
}

async function dismissCookieBanner(page, timeout = 3500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const bannerVisible =
            await page.locator(SELECTORS.cookieBanner).isVisible().catch(() => false)
            || await page.getByText(/duo suka cookie/i).first().isVisible().catch(() => false);

        if (!bannerVisible) return false;

        const buttons = [
            page.locator(SELECTORS.cookieReject).first(),
            page.locator(SELECTORS.cookieAccept).first(),
            page.getByRole('button', { name: /tolak semua|reject all/i }).first(),
            page.getByRole('button', { name: /terima cookie|accept/i }).first(),
        ];

        for (const button of buttons) {
            if (!await button.isVisible().catch(() => false)) continue;
            await clickLocator(page, button, { force: true, timeout: 1500 });
            await page.locator(SELECTORS.cookieBanner).waitFor({ state: 'hidden', timeout: 1500 }).catch(() => { });
            return true;
        }

        await sleep(120);
    }
    return false;
}

async function clickAnyVisibleNonCookieButton(page, selector, timeout = 1800, textRegex = null) {
    const buttons = page.locator(selector);
    const total = await buttons.count().catch(() => 0);
    if (total === 0) return false;

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (let i = 0; i < total; i += 1) {
            const button = buttons.nth(i);
            if (!await button.isVisible().catch(() => false)) continue;

            const id = (await button.getAttribute('id').catch(() => '')) || '';
            const text = ((await button.textContent().catch(() => '')) || '').trim().toLowerCase();
            if (id.startsWith('onetrust-')) continue;
            if (!text) continue;
            if (/terima cookie|tolak semua|accept cookie|reject all/i.test(text)) continue;
            if (textRegex && !textRegex.test(text)) continue;

            return await clickLocator(page, button, {
                timeout: Math.max(500, deadline - Date.now()),
                allowForceFallback: false,
            });
        }
        await sleep(120);
    }

    return false;
}

async function clickContinue(page, timeout = 4000) {
    const maxTry = 3;
    for (let attempt = 1; attempt <= maxTry; attempt += 1) {
        await dismissCookieBanner(page, 800).catch(() => { });
        if (await safeClick(page, CONTINUE_BUTTON_SELECTOR, timeout)) return true;
        const byText = page.getByRole('button', { name: CONTINUE_BUTTON_TEXT }).first();
        if (await byText.isVisible().catch(() => false)) {
            return await clickLocator(page, byText, { timeout: Math.max(800, timeout) });
        }
        if (await clickAnyVisibleNonCookieButton(page, 'button[type="button"], button[type="submit"]', Math.min(timeout, 1800), CONTINUE_BUTTON_TEXT)) return true;
        const selectedChoiceVisible = await page.locator('[role="radio"][aria-checked="true"]').first().isVisible().catch(() => false);
        if (selectedChoiceVisible && await forceClickContinue(page)) return true;
        await sleep(250 * attempt);
    }
    return false;
}

async function clickRecordedRadio(page, nameRegex, timeout = 2500) {
    try {
        const radio = page.getByRole('radio', { name: nameRegex }).first();
        if (await radio.isVisible({ timeout })) {
            await clickLocator(page, radio, { timeout });
            await sleep(300);
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

async function clickRandomRadio(page) {
    try {
        const radios = page.getByRole('radio');
        const count = await radios.count();
        if (count > 0) {
            const idx = Math.floor(Math.random() * count);
            await clickLocator(page, radios.nth(idx), { timeout: 2000 });
            await sleep(400);
            return true;
        }
    } catch { /* skip */ }
    return false;
}

async function clickChoiceByLabel(page, nameRegex, timeout = 1200) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const candidates = [
                page.getByRole('radio', { name: nameRegex }).first(),
                page.getByRole('button', { name: nameRegex }).first(),
                page.getByText(nameRegex).first(),
            ];
            for (const candidate of candidates) {
                if (await candidate.isVisible().catch(() => false)) {
                    await clickLocator(page, candidate, { timeout: 1800 });
                    await sleep(220);
                    return true;
                }
            }
        } catch { /* ignore */ }
        await sleep(120);
    }
    return false;
}

async function clickRandomChoice(page) {
    if (await clickRandomRadio(page)) return true;
    try {
        const buttons = page.locator('button');
        const total = await buttons.count();
        const candidates = [];
        for (let i = 0; i < total; i += 1) {
            const button = buttons.nth(i);
            const text = ((await button.textContent().catch(() => '')) || '').trim().toLowerCase();
            if (!text) continue;
            if (/lanjut|continue|mulai|start|selanjutnya|teruskan|quit|keluar|blokir/i.test(text)) continue;
            if (await button.isVisible().catch(() => false)) candidates.push(button);
        }
        if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            await clickLocator(page, pick, { timeout: 1800 });
            await sleep(300);
            return true;
        }
    } catch { /* ignore */ }

    try {
        const cards = page.locator('button, [role="button"], [role="radio"], label, [data-test*="option"], [data-test*="choice"]');
        const total = await cards.count();
        const candidates = [];
        for (let i = 0; i < total; i += 1) {
            const el = cards.nth(i);
            if (!await el.isVisible().catch(() => false)) continue;
            const box = await el.boundingBox().catch(() => null);
            if (!box) continue;
            if (box.width < 150 || box.height < 36) continue;
            if (box.y < 120 || box.y > 760) continue;

            const text = ((await el.textContent().catch(() => '')) || '').trim().toLowerCase();
            if (/lanjut|continue|mulai|start|selanjutnya|teruskan|quit|keluar|blokir|menu|profil/i.test(text)) continue;
            candidates.push(el);
        }
        if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            await clickLocator(page, pick, { timeout: 1800, force: true });
            await sleep(350);
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

async function ensureChoiceStepReady(page, continueTries = 3) {
    for (let i = 0; i < continueTries; i += 1) {
        const ready = (await page.getByRole('radio').count().catch(() => 0)) > 0
            || (await page.getByRole('button', { name: /lainnya|facebook|tiktok|google|youtube|teman/i }).count().catch(() => 0)) > 0;
        if (ready) return true;
        const moved = await clickContinue(page, 3500);
        if (!moved) break;
        await sleep(650);
    }
    return (await page.getByRole('radio').count().catch(() => 0)) > 0
        || (await page.getByRole('button', { name: /lainnya|facebook|tiktok|google|youtube|teman/i }).count().catch(() => 0)) > 0;
}

async function hasAnyRadio(page, waitMs = 0) {
    const deadline = Date.now() + waitMs;
    do {
        const count = await page.getByRole('radio').count().catch(() => 0);
        if (count > 0) return true;
        if (Date.now() < deadline) await sleep(150);
    } while (Date.now() < deadline);
    return false;
}

async function continueOrRadioReady(page, timeout = 4500) {
    if (await clickContinue(page, timeout)) return true;
    return await hasAnyRadio(page, 2500);
}

function getWelcomeStepFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get('welcomeStep');
    } catch {
        return null;
    }
}

async function waitWelcomeStepChanged(page, prevStep, timeout = 9000) {
    if (!prevStep) return true;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const current = getWelcomeStepFromUrl(page.url());
        if (current && current !== prevStep) return true;
        await sleep(200);
    }
    return false;
}

async function advanceUntilWelcomeStep(page, matchers, maxContinue = 8) {
    for (let i = 0; i <= maxContinue; i += 1) {
        const step = (getWelcomeStepFromUrl(page.url()) || '').toLowerCase();
        if (matchers.some((matcher) => matcher.test(step))) return true;
        if (i < maxContinue) {
            await clickContinue(page, 3500);
            await sleep(500);
        }
    }
    return false;
}

async function isSourceInfoStepVisible(page) {
    const step = (getWelcomeStepFromUrl(page.url()) || '').toLowerCase();
    if (/hdyhau|acquisition|source/i.test(step)) return true;

    const byTitle = await page.getByText(/dari mana kamu tahu tentang duolingo/i).first().isVisible().catch(() => false);
    if (byTitle) return true;

    const byChoices = await page.getByRole('button', { name: /facebook|instagram|tiktok|youtube|google|lainnya|teman/i }).count().catch(() => 0);
    if (byChoices > 0) return true;

    const bySurvey = await page.locator('[data-test="acquisitionSurvey"]').first().isVisible().catch(() => false);
    if (bySurvey) return true;

    return await page.locator(HDYHAU_OPTION_SELECTOR).first().isVisible().catch(() => false);
}

async function waitForSourceInfoStep(page, timeout = 9000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isSourceInfoStepVisible(page)) return true;
        await sleep(250);
    }
    return await isSourceInfoStepVisible(page);
}

async function reachSourceStepQuick(page, maxContinue = 2) {
    if (await waitForSourceInfoStep(page, 9000)) return true;

    for (let i = 0; i < maxContinue; i += 1) {
        const continued = await waitAndClickContinueEnabled(page, 6000);
        if (!continued) {
            await sleep(250);
            continue;
        }
        await sleep(400);
        if (await waitForSourceInfoStep(page, 4000)) return true;
    }

    return await isSourceInfoStepVisible(page);
}

async function waitAndClickQuit(page, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await safeClick(page, SELECTORS.quitButton, 900)) return true;
        if (await safeClick(page, SELECTORS.createProfile, 900)) return false;
        if (await page.locator(SELECTORS.ageInput).isVisible().catch(() => false)) return false;
        await sleep(220);
    }
    return false;
}

async function isSplashContinueScreen(page) {
    const disabledContinue = page.locator('[data-test="funboarding-continue-button"][disabled], [data-test="continue-button"][disabled]').first();
    if (!await disabledContinue.isVisible().catch(() => false)) return false;

    const radios = await page.getByRole('radio').count().catch(() => 0);
    const inputs = await page.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0);
    const enabledContinue = await page.locator('[data-test="funboarding-continue-button"]:not([disabled]), [data-test="continue-button"]:not([disabled])').count().catch(() => 0);

    return radios === 0 && inputs === 0 && enabledContinue === 0;
}

async function forceClickContinue(page) {
    const continueButton = page.locator(CONTINUE_BUTTON_SELECTOR).first();
    if (!await continueButton.isVisible().catch(() => false)) return false;

    await continueButton.evaluate((button) => {
        button.disabled = false;
        button.removeAttribute('disabled');
        button.setAttribute('aria-disabled', 'false');
    }).catch(() => { });

    return await clickLocator(page, continueButton, { timeout: 2000, force: true });
}

async function isContinueButtonEnabled(page) {
    const continueButton = page.locator(CONTINUE_BUTTON_SELECTOR).first();
    if (!await continueButton.isVisible().catch(() => false)) return false;

    return await continueButton.evaluate((button) => !(
        button.disabled
        || button.hasAttribute('disabled')
        || button.getAttribute('aria-disabled') === 'true'
    )).catch(() => false);
}

async function waitForContinueEnabled(page, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isContinueButtonEnabled(page)) return true;
        await sleep(180);
    }
    return await isContinueButtonEnabled(page);
}

async function waitForStepToChange(page, prevStep, timeout = 9000) {
    if (!prevStep) return true;
    return await waitWelcomeStepChanged(page, prevStep, timeout);
}

async function waitForSourceInfoStepToExit(page, timeout = 9000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (!await isSourceInfoStepVisible(page)) return true;
        await sleep(220);
    }
    return !await isSourceInfoStepVisible(page);
}

async function isEmailFormVisible(page) {
    const emailSelector = 'input[type="email"], [data-test="email-input"], input[name="email"]';
    const passwordSelector = 'input[type="password"], [data-test="password-input"]';
    const emailVisible = await page.locator(emailSelector).first().isVisible().catch(() => false);
    const passwordVisible = await page.locator(passwordSelector).first().isVisible().catch(() => false);
    return emailVisible || passwordVisible;
}

async function isOnboardingSurfaceReady(page) {
    if (await page.locator(SELECTORS.englishCard).first().isVisible().catch(() => false)) return true;
    if (await page.locator(CONTINUE_BUTTON_SELECTOR).first().isVisible().catch(() => false)) return true;
    if (await page.locator(SELECTORS.createProfile).first().isVisible().catch(() => false)) return true;
    if (await page.locator(SELECTORS.ageInput).first().isVisible().catch(() => false)) return true;
    if (await isEmailFormVisible(page)) return true;
    if (await isSourceInfoStepVisible(page)) return true;
    return false;
}

async function waitForOnboardingSurface(page, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isOnboardingSurfaceReady(page)) return true;
        await sleep(250);
    }
    return await isOnboardingSurfaceReady(page);
}

async function isLoginFormVisible(page) {
    const emailVisible = await page.locator(LOGIN_EMAIL_SELECTOR).first().isVisible().catch(() => false);
    const passwordVisible = await page.locator(LOGIN_PASSWORD_SELECTOR).first().isVisible().catch(() => false);
    return emailVisible || passwordVisible;
}

async function waitForLoginEntryState(page, timeout = 0) {
    const deadline = Date.now() + Math.max(0, timeout);
    do {
        if (await isAuthenticatedPage(page)) return 'authenticated';
        if (await isLoginFormVisible(page)) return 'form';
        if (Date.now() < deadline) await sleep(250);
    } while (Date.now() < deadline);

    if (await isAuthenticatedPage(page)) return 'authenticated';
    if (await isLoginFormVisible(page)) return 'form';
    return 'none';
}

async function waitForLoginForm(page, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const state = await waitForLoginEntryState(page);
        if (state === 'form') return true;
        if (state === 'authenticated') return false;
        await sleep(250);
    }
    return await isLoginFormVisible(page);
}

async function openLoginForm(page, timeout = 12000) {
    const initialState = await waitForLoginEntryState(page, 500);
    if (initialState === 'form') return 'form';
    if (initialState === 'authenticated') return 'authenticated';

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await dismissCookieBanner(page, 500).catch(() => { });
        const stateBeforeClick = await waitForLoginEntryState(page, 400);
        if (stateBeforeClick === 'form') return 'form';
        if (stateBeforeClick === 'authenticated') return 'authenticated';

        if (await safeClick(page, OPEN_LOGIN_BUTTON_SELECTOR, 1800)) {
            await sleep(450);
            const stateAfterOpenClick = await waitForLoginEntryState(page, 500);
            if (stateAfterOpenClick === 'form') return 'form';
            if (stateAfterOpenClick === 'authenticated') return 'authenticated';
        }

        const roleCandidates = [
            page.getByRole('button', { name: OPEN_LOGIN_TEXT }).first(),
            page.getByRole('link', { name: OPEN_LOGIN_TEXT }).first(),
        ];

        for (const candidate of roleCandidates) {
            if (!await candidate.isVisible().catch(() => false)) continue;
            if (await clickLocator(page, candidate, { timeout: 2200 })) {
                await sleep(450);
                const stateAfterRoleClick = await waitForLoginEntryState(page, 500);
                if (stateAfterRoleClick === 'form') return 'form';
                if (stateAfterRoleClick === 'authenticated') return 'authenticated';
            }
        }

        await sleep(250);
    }

    return await waitForLoginEntryState(page, 500);
}

function isLoggedInUrl(url) {
    return /duolingo\.com/i.test(url)
        && !/\/log-?in/i.test(url)
        && !/\/register/i.test(url);
}

function isAuthenticatedDestinationUrl(url) {
    try {
        const parsed = new URL(url);
        return isLoggedInUrl(url) && parsed.pathname !== '/';
    } catch {
        return false;
    }
}

async function isAuthenticatedPage(page) {
    const profileVisible =
        await page.locator(`${SELECTORS.profileAvatar}, [data-test="profile-menu"], [data-test="user-avatar"], img[alt="profile"]`).first().isVisible().catch(() => false);
    if (profileVisible) return true;
    return isAuthenticatedDestinationUrl(page.url()) && !await isLoginFormVisible(page);
}

function matchesLoginErrorText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (/site is protected by recaptcha|situs ini dilindungi oleh recaptcha/i.test(normalized)) return false;
    return LOGIN_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function trackAsyncValue(promise) {
    const state = {
        settled: false,
        value: null,
    };

    Promise.resolve(promise)
        .then((value) => {
            state.settled = true;
            state.value = value;
        })
        .catch(() => {
            state.settled = true;
            state.value = null;
        });

    return {
        isSettled: () => state.settled,
        getValue: () => state.value,
    };
}

function extractLoginApiMessage(payload) {
    if (!payload) return null;

    if (typeof payload === 'string') {
        const normalized = payload.replace(/\s+/g, ' ').trim();
        return normalized || null;
    }

    if (typeof payload !== 'object') return null;

    const candidates = [
        payload.error,
        payload.message,
        payload.detail,
        payload.errorMessage,
        payload.description,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const normalized = candidate.replace(/\s+/g, ' ').trim();
        if (normalized) return normalized;
    }

    if (Array.isArray(payload.errors)) {
        for (const item of payload.errors) {
            const text = extractLoginApiMessage(item);
            if (text) return text;
        }
    }

    return null;
}

function summarizeLoginApiPayload(payload) {
    if (payload == null) return null;

    let text = null;
    if (typeof payload === 'string') {
        text = payload;
    } else {
        try {
            text = JSON.stringify(payload);
        } catch {
            text = String(payload);
        }
    }

    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}

function defaultLoginApiError(status) {
    if (status === 401) return 'Kata sandi salah. Silakan coba lagi.';
    if (status === 403) return 'Login diblokir atau butuh verifikasi tambahan.';
    if (status === 429) return 'Terlalu banyak percobaan login. Coba lagi nanti.';
    if (status >= 500) return 'Server login Duolingo sedang bermasalah.';
    return `Login API gagal | status=${status}`;
}

async function parseLoginApiResponse(response) {
    if (!response) return null;

    const status = response.status();
    let payload = null;

    try {
        payload = await response.json();
    } catch {
        try {
            payload = await response.text();
        } catch {
            payload = null;
        }
    }

    const message = extractLoginApiMessage(payload);
    if (status >= 200 && status < 300) {
        return {
            success: true,
            status,
            message,
            debug_body: summarizeLoginApiPayload(payload),
            url: response.url(),
        };
    }

    return {
        success: false,
        status,
        error: message || defaultLoginApiError(status),
        debug_body: summarizeLoginApiPayload(payload),
        url: response.url(),
    };
}

async function extractLoginError(page) {
    for (const pattern of LOGIN_ERROR_PATTERNS) {
        const textNode = page.getByText(pattern).first();
        if (!await textNode.isVisible().catch(() => false)) continue;
        const text = ((await textNode.textContent().catch(() => '')) || '').trim();
        if (matchesLoginErrorText(text)) return text;
    }

    const selectors = [
        '[role="alert"]',
        '[data-test*="error"]',
        '[aria-live="assertive"]',
    ];

    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (!await locator.isVisible().catch(() => false)) continue;
        const text = ((await locator.textContent().catch(() => '')) || '').trim();
        if (matchesLoginErrorText(text)) return text;
    }

    return null;
}

async function waitForLoginResult(page, timeout = 15000, options = {}) {
    const startedAt = Date.now();
    const unlimitedWait = options.unlimitedWait === true || !Number.isFinite(timeout);
    const deadline = unlimitedWait ? Number.POSITIVE_INFINITY : (startedAt + timeout);
    const initialUrl = String(options.initialUrl || page.url());
    const minNoNavigationWaitRaw = options.minNoNavigationWaitMs;
    const minNoNavigationWaitMs = Number.isFinite(minNoNavigationWaitRaw)
        ? Math.max(0, Number(minNoNavigationWaitRaw))
        : 0;
    const loginApiTracker = options.loginApiTracker || null;
    const shouldDelayFailureWhilePageIsStuck = () => {
        if (unlimitedWait) return false;
        if (Date.now() - startedAt >= minNoNavigationWaitMs) return false;
        return page.url() === initialUrl;
    };

    while (Date.now() < deadline) {
        const loginApiResult = loginApiTracker?.getValue?.() ?? null;

        if (loginApiResult?.success && !await isLoginFormVisible(page)) {
            return { success: true, current_url: page.url() };
        }

        if (await isAuthenticatedPage(page)) {
            return { success: true, current_url: page.url() };
        }

        if (loginApiResult && !loginApiResult.success && !shouldDelayFailureWhilePageIsStuck()) {
            return { success: false, error: loginApiResult.error, current_url: page.url() };
        }

        const loginError = await extractLoginError(page);
        if (loginError && !shouldDelayFailureWhilePageIsStuck()) {
            return { success: false, error: loginError, current_url: page.url() };
        }

        await sleep(250);
    }

    const loginError = await extractLoginError(page);
    if (loginError) {
        return { success: false, error: loginError, current_url: page.url() };
    }

    const loginApiResult = loginApiTracker?.getValue?.() ?? null;
    if (loginApiResult?.success && !await isLoginFormVisible(page)) {
        return { success: true, current_url: page.url() };
    }
    if (loginApiResult && !loginApiResult.success) {
        return { success: false, error: loginApiResult.error, current_url: page.url() };
    }

    if (await isAuthenticatedPage(page)) {
        return { success: true, current_url: page.url() };
    }

    return {
        success: false,
        error: `Login belum berpindah | url=${page.url()}`,
        current_url: page.url(),
    };
}

async function clickTrialCta(page) {
    const candidates = [
        page.getByRole('button', { name: TRIAL_CTA_TEXT }).first(),
        page.getByRole('link', { name: TRIAL_CTA_TEXT }).first(),
        page.getByText(TRIAL_CTA_TEXT).first(),
    ];

    for (const candidate of candidates) {
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (await clickLocator(page, candidate, { timeout: 3000 })) return true;
    }

    return false;
}

function isLearnScreenUrl(url) {
    return /duolingo\.com/i.test(String(url || ''))
        && /\/learn|\/welcome|\/onboarding/i.test(String(url || ''));
}

async function exitLearnScreenToDashboard(page, timeout = 10000) {
    if (!isLearnScreenUrl(page.url())) return false;

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const exitButton = page.locator(LEARN_EXIT_SELECTOR).first();
        if (await exitButton.isVisible().catch(() => false)) {
            const beforeUrl = page.url();
            const clicked = await clickLocator(page, exitButton, {
                timeout: Math.max(1000, deadline - Date.now()),
                allowForceFallback: true,
            });
            if (clicked) {
                await sleep(600);
                if (!isLearnScreenUrl(page.url()) || page.url() !== beforeUrl) return true;
            }
        }

        const topLeftButtons = page.locator('button, [role="button"]');
        const total = await topLeftButtons.count().catch(() => 0);
        for (let i = 0; i < Math.min(total, 8); i += 1) {
            const candidate = topLeftButtons.nth(i);
            if (!await candidate.isVisible().catch(() => false)) continue;
            const box = await candidate.boundingBox().catch(() => null);
            if (!box) continue;
            if (box.x > 90 || box.y > 90) continue;

            const text = ((await candidate.textContent().catch(() => '')) || '').trim();
            const ariaLabel = ((await candidate.getAttribute('aria-label').catch(() => '')) || '').trim();
            if (!text && !ariaLabel) {
                const clicked = await clickLocator(page, candidate, {
                    timeout: Math.max(1000, deadline - Date.now()),
                    allowForceFallback: true,
                });
                if (clicked) {
                    await sleep(600);
                    if (!isLearnScreenUrl(page.url())) return true;
                }
                continue;
            }

            if (/^x$|^×$|^✕$|close|tutup|quit|keluar/i.test(`${text} ${ariaLabel}`)) {
                const clicked = await clickLocator(page, candidate, {
                    timeout: Math.max(1000, deadline - Date.now()),
                    allowForceFallback: true,
                });
                if (clicked) {
                    await sleep(600);
                    if (!isLearnScreenUrl(page.url())) return true;
                }
            }
        }

        await sleep(250);
    }

    return !isLearnScreenUrl(page.url());
}

async function clickPlusContinue(page, timeout = 5000) {
    const button = page.locator(PLUS_CONTINUE_SELECTOR).first();
    if (await button.isVisible().catch(() => false)) {
        return await clickLocator(page, button, { timeout: Math.min(timeout, 3000) });
    }

    return await safeClick(page, PLUS_CONTINUE_SELECTOR, timeout);
}

async function chooseTrialPlan(page, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const preferred = page.locator(TRIAL_PLAN_SELECTOR).first();
        if (await preferred.isVisible().catch(() => false)) {
            return await clickLocator(page, preferred, { timeout: 3000 });
        }
        await sleep(250);
    }
    return false;
}

async function waitForStripeFrame(page, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const frame = page.locator(STRIPE_IFRAME_SELECTOR).first();
        if (await frame.isVisible().catch(() => false)) return true;
        await sleep(250);
    }
    return false;
}

function getStripeFrames(page) {
    return page.frames().filter((frame) => {
        if (frame === page.mainFrame()) return false;
        return /stripe/i.test(frame.url()) || /__privateStripeFrame/i.test(frame.name());
    });
}

async function findVisiblePaymentField(page, selectors, timeout = 10000) {
    const query = Array.isArray(selectors) ? selectors.join(', ') : selectors;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const contexts = [page, ...getStripeFrames(page)];
        for (const context of contexts) {
            const field = context.locator(query).first();
            const count = await field.count().catch(() => 0);
            if (count === 0) continue;
            if (await field.isVisible().catch(() => false)) return field;
        }
        await sleep(250);
    }

    return null;
}

async function fillPaymentField(page, { selectors, value, label, timeout = 12000, required = true }) {
    const text = String(value ?? '').trim();
    if (!text) {
        if (required) throw new Error(`Nilai ${label} kosong`);
        return null;
    }

    const field = await findVisiblePaymentField(page, selectors, timeout);
    if (!field) {
        if (required) throw new Error(`Field ${label} tidak ditemukan`);
        return null;
    }

    await field.click({ timeout: Math.min(timeout, 2500) }).catch(async () => {
        await field.click({ timeout: Math.min(timeout, 2500), force: true });
    }).catch(() => { });
    await sleep(120);
    await field.fill('').catch(() => { });
    await field.pressSequentially(text, { delay: randomInt(80, 150) }).catch(async () => {
        await field.type(text, { delay: randomInt(80, 150) });
    });
    await sleep(250);
    return field;
}

async function runAfterLoginAction(page, config, logStep) {
    const action = String(config?.after_login_action || 'none').trim().toLowerCase();
    if (action !== 'trial-manual' && action !== 'trial-auto-vcc') {
        return {
            action,
            status: 'unknown-action',
            error: `After login action tidak dikenal: ${action}`,
            current_url: page.url(),
        };
    }

    logStep('[AFTER] mulai buka trial sampai form pembayaran');

    if (isLearnScreenUrl(page.url())) {
        logStep(`[AFTER] layar belajar terdeteksi | coba klik X kiri atas | url=${page.url()}`);
        const exitedLearnScreen = await exitLearnScreenToDashboard(page, 12000);
        if (exitedLearnScreen) {
            logStep(`[AFTER] berhasil keluar ke dashboard | url=${page.url()}`);
        } else {
            logStep(`[AFTER] gagal keluar dari layar belajar | lanjut pakai fallback URL | url=${page.url()}`);
        }
    }

    const candidateUrls = [
        page.url(),
        'https://www.duolingo.com/super',
        'https://www.duolingo.com/plus',
    ];

    let ctaOpened = false;
    for (const candidateUrl of candidateUrls) {
        if (candidateUrl && candidateUrl !== page.url()) {
            await gotoWithRetry(page, candidateUrl, {
                maxTry: 2,
                timeout: Math.max(45000, Number(config?.timeout || 0)),
            }).catch(() => { });
            await dismissCookieBanner(page, 2500).catch(() => { });
            await sleep(300);
        }

        if (await clickTrialCta(page)) {
            ctaOpened = true;
            break;
        }
    }

    if (!ctaOpened) {
        return {
            action,
            status: 'failed',
            error: 'Tombol trial tidak ditemukan',
            current_url: page.url(),
        };
    }

    await sleep(500);
    await clickPlusContinue(page, 5000).catch(() => false);
    await sleep(350);
    await clickPlusContinue(page, 5000).catch(() => false);
    await sleep(350);

    const planSelected = await chooseTrialPlan(page, 12000);
    if (!planSelected) {
        return {
            action,
            status: 'failed',
            error: 'Paket trial tidak ditemukan',
            current_url: page.url(),
        };
    }

    await sleep(350);
    await clickPlusContinue(page, 6000).catch(() => false);

    const stripeReady = await waitForStripeFrame(page, Math.max(20000, Number(config?.timeout || 0)));
    if (!stripeReady) {
        return { action, status: 'failed', error: 'Form pembayaran belum muncul', current_url: page.url() };
    }

    const paymentData = normalizeTrialPaymentData(config?.vccData);
    if (action === 'trial-auto-vcc' && paymentData) {
        logStep('[AFTER] form pembayaran siap | memproses input data pembayaran otomatis...');
        try {
            await fillPaymentField(page, {
                selectors: [
                    'input[name="cardnumber"]',
                    'input[autocomplete="cc-number"]',
                    'input[data-elements-stable-field-name="cardNumber"]',
                ],
                value: paymentData.cardNumber,
                label: 'nomor kartu',
            });

            await fillPaymentField(page, {
                selectors: [
                    'input[name="exp-date"]',
                    'input[autocomplete="cc-exp"]',
                    'input[data-elements-stable-field-name="cardExpiry"]',
                ],
                value: paymentData.expDate,
                label: 'expired date',
            });

            const cvcInput = await fillPaymentField(page, {
                selectors: [
                    'input[name="cvc"]',
                    'input[autocomplete="cc-csc"]',
                    'input[data-elements-stable-field-name="cardCvc"]',
                ],
                value: paymentData.cvc,
                label: 'CVC',
            });

            if (paymentData.cardholderName) {
                const nameInput = await fillPaymentField(page, {
                    selectors: [
                        'input[name="name"]',
                        'input[name="cardholderName"]',
                        'input[autocomplete="cc-name"]',
                        'input[data-elements-stable-field-name="cardholderName"]',
                    ],
                    value: paymentData.cardholderName,
                    label: 'nama kartu',
                    required: false,
                });
                if (!nameInput) {
                    logStep('[AFTER] field nama kartu tidak tersedia, skip');
                }
            }

            let submitSource = cvcInput;
            if (paymentData.postalCode) {
                const postalInput = await fillPaymentField(page, {
                    selectors: [
                        'input[name="postalCode"]',
                        'input[name="billingPostalCode"]',
                        'input[autocomplete="postal-code"]',
                        'input[data-elements-stable-field-name="postalCode"]',
                    ],
                    value: paymentData.postalCode,
                    label: 'kode pos billing',
                    required: false,
                });
                if (postalInput) {
                    submitSource = postalInput;
                } else {
                    logStep('[AFTER] field kode pos billing tidak tersedia, skip');
                }
            }

            logStep('[AFTER] input pembayaran selesai | kirim Enter untuk submit');
            await submitSource.press('Enter').catch(() => { });

            logStep('[AFTER] menunggu respons Stripe (10 detik)...');
            await sleep(10000);

            return { action, status: 'vcc-injected-success', current_url: page.url() };
        } catch (error) {
            logStep(`[AFTER] error saat input pembayaran: ${error.message}`);
            return { action, status: 'vcc-inject-failed', error: error.message, current_url: page.url() };
        }
    }

    return { action, status: 'no-vcc-data', current_url: page.url() };
}

async function advanceSourceInfoStep(page) {
    const prevStep = getWelcomeStepFromUrl(page.url());
    const sourceClicked =
        await pickHdyhauOption(page, 3500)
        || await safeClick(page, HDYHAU_OPTION_SELECTOR, 1500)
        || await clickRandomChoice(page);

    if (!sourceClicked) return false;

    await sleep(80);
    const continueClicked =
        (await waitForContinueEnabled(page, 5000) && await waitAndClickContinueEnabled(page, 4000))
        || await forceClickContinue(page);
    if (!continueClicked) return false;

    return (
        await waitForStepToChange(page, prevStep, 12000)
        || await waitForSourceInfoStepToExit(page, 6000)
    );
}

async function handleAgeStep(page) {
    const ageInput = page.locator(SELECTORS.ageInput).first();
    if (!await ageInput.isVisible().catch(() => false)) return false;

    await fillField(page, ageInput, generateAdultAge());
    await sleep(400);
    await safeClick(page, SELECTORS.ageContinue, 4000);
    await sleep(900);
    return true;
}

async function advanceChoiceStep(page) {
    if (await isSourceInfoStepVisible(page)) {
        return await advanceSourceInfoStep(page);
    }

    const prevStep = getWelcomeStepFromUrl(page.url());
    const picked =
        await clickChoiceByLabel(page, /lainnya|other|facebook|instagram|tiktok|google|youtube|teman|keluarga|berita|blog|santai|regular|serious|hari|mulai dari awal|ambil tes|placement|aku bisa|aku tahu|aku baru/i, 1200)
        || await clickRandomChoice(page);

    if (!picked) return false;

    await sleep(320);

    if (await isEmailFormVisible(page)) return true;
    if (await page.locator(SELECTORS.ageInput).first().isVisible().catch(() => false)) return true;

    if (await clickContinue(page, 4500)) {
        await sleep(650);
        return true;
    }

    if (await advanceByKeyboardSelection(page, 4)) {
        await sleep(650);
        return true;
    }

    return await waitWelcomeStepChanged(page, prevStep, 5000);
}

async function waitForEmailForm(page, timeout = 90000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (await isEmailFormVisible(page)) return true;

        if (await handleAgeStep(page)) continue;

        if (await page.locator(SELECTORS.createProfile).first().isVisible().catch(() => false)) {
            if (await safeClick(page, SELECTORS.createProfile, 3000)) {
                await sleep(1200);
                continue;
            }
        }

        if (await advanceChoiceStep(page)) continue;

        const continued = await waitAndClickContinueEnabled(page, 2500);
        if (continued) {
            await sleep(1200);
            continue;
        }

        await sleep(250);
    }

    return await isEmailFormVisible(page);
}

async function waitAndClickContinueEnabled(page, timeout = 5000) {
    const continueButton = page.locator(CONTINUE_BUTTON_SELECTOR).first();
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (await continueButton.isVisible().catch(() => false)) {
            const disabled = !await isContinueButtonEnabled(page);

            if (!disabled) {
                return await clickLocator(page, continueButton, { timeout: 2500 });
            }
        }

        await sleep(250);
    }

    if (await isSplashContinueScreen(page)) {
        await sleep(500);
        if (await forceClickContinue(page)) return true;
    }

    return await clickContinue(page, Math.min(timeout, 3000));
}

async function pickHdyhauOption(page, timeout = 6000) {
    const group = page.locator('[data-test="acquisitionSurvey"]');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await group.isVisible().catch(() => false)) {
            const preferredRadio = group.locator('[data-test="hdyhau-other"]').locator('xpath=ancestor::*[@role="radio"][1]').first();
            if (await preferredRadio.isVisible().catch(() => false)) {
                await clickLocator(page, preferredRadio, { force: true, timeout: 1800 });
                await sleep(80);
                if (await preferredRadio.getAttribute('aria-checked').catch(() => 'false') === 'true') return true;
            }

            const firstVisibleRadio = group.locator('[role="radio"]').first();
            if (await firstVisibleRadio.isVisible().catch(() => false)) {
                await clickLocator(page, firstVisibleRadio, { force: true, timeout: 1800 });
                await sleep(80);
                if (await firstVisibleRadio.getAttribute('aria-checked').catch(() => 'false') === 'true') return true;
            }
        } else if (await group.count().catch(() => 0)) {
            const clicked =
                await domClick(page, '[data-test="hdyhau-other"]')
                || await domClick(page, HDYHAU_OPTION_SELECTOR);
            if (clicked) {
                await sleep(120);
                return true;
            }
        } else {
            await clickContinue(page, 1200);
        }
        await sleep(120);
    }
    return false;
}

async function advanceByKeyboardSelection(page, maxTry = 8) {
    const startUrl = page.url();
    for (let i = 0; i < maxTry; i += 1) {
        await page.keyboard.press('Tab').catch(() => { });
        await sleep(120);
        await page.keyboard.press('Space').catch(() => { });
        await sleep(220);
        if (await clickContinue(page, 1600)) return true;
        if (page.url() !== startUrl) return true;
    }
    return false;
}

export async function registerDuolingo(email, config) {
    const username = generateUsername(email);
    const password = config.password;
    const proxy = normalizeProxyConfig(config?.proxy);
    const debugSteps = config?.debug_steps !== false;
    const showPointer = config?.show_pointer !== false;
    const profileDir = resolveBaseProfileDir(config);
    const externalLogger = typeof config?.onLog === 'function' ? config.onLog : null;
    const flowStartedAt = Date.now();
    let page;
    let stepIndex = 1;
    const logStep = (message) => {
        const line = `[DUO][${email}][${String(stepIndex).padStart(2, '0')}] ${message}`;
        if (debugSteps) console.log(line);
        if (externalLogger) externalLogger(line);
    };
    const runStep = async (message, action) => {
        const startedAt = Date.now();
        logStep(`START ${message} | t=${new Date(startedAt).toISOString()} | total=+${startedAt - flowStartedAt}ms`);
        try {
            if (page) await dismissCookieBanner(page, 500).catch(() => { });
            const result = await action();
            const elapsed = Date.now() - startedAt;
            const totalElapsed = Date.now() - flowStartedAt;
            logStep(`DONE  ${message} | +${elapsed}ms | total=+${totalElapsed}ms`);
            stepIndex += 1;
            return result;
        } catch (error) {
            try {
                if (page) {
                    const debugDir = resolveDebugDir();
                    mkdirSync(debugDir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const safeStep = message.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const screenshotPath = join(debugDir, `duo-fail-${safeStep}-${stamp}.png`);
                    const htmlPath = join(debugDir, `duo-fail-${safeStep}-${stamp}.html`);
                    await page.screenshot({ path: screenshotPath, fullPage: true });
                    writeFileSync(htmlPath, await page.content(), 'utf8');
                    logStep(`DEBUG saved: ${screenshotPath} | ${htmlPath}`);
                }
            } catch { /* ignore */ }
            logStep(`FAIL  ${message} | ${error.message} | url=${page?.url?.() ?? '-'}`);
            throw error;
        }
    };
    let context;

    try {
        const launchOptions = {
            headless: config.headless,
            slowMo: config.slow_mo,
            viewport: { width: 1280, height: 800 },
            locale: 'id-ID',
        };

        if (proxy) {
            launchOptions.proxy = proxy;
        }

        mkdirSync(profileDir, { recursive: true });
        context = await chromium.launchPersistentContext(profileDir, launchOptions);

        if (showPointer) {
            await context.addInitScript(mountPointerOverlayScript);
        }

        const existingPages = context.pages().filter((candidate) => !candidate.isClosed());
        if (existingPages.length > 0) {
            [page] = existingPages;
            for (const existingPage of existingPages.slice(1)) {
                await existingPage.close().catch(() => { });
            }
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
        } else {
            page = await context.newPage();
        }
        getPointerSnapshot(page);
        page.setDefaultTimeout(config.timeout);
        const ensure = (ok, detail) => {
            if (!ok) throw new Error(detail);
        };
        logStep(`[BROWSER] chromium persistent | profile=${profileDir}`);

        if (proxy) {
            await runStep('Validasi proxy', async () => {
                await verifyBrowserProxy({
                    page,
                    proxy,
                    log: (message) => logStep(message),
                    timeout: Math.max(10000, Math.min(config.timeout, 15000)),
                });
                await sleep(150);
            });
        } else {
            logStep('[PROXY] off');
        }

        await runStep('Navigate register page', async () => {
            await context.clearCookies().catch(() => { });
            await gotoWithRetry(page, 'https://www.duolingo.com/register', { maxTry: 3, timeout: Math.max(60000, config.timeout) });
            await page.evaluate(() => {
                try { window.localStorage?.clear(); } catch { /* ignore */ }
                try { window.sessionStorage?.clear(); } catch { /* ignore */ }
            }).catch(() => { });
            await gotoWithRetry(page, `https://www.duolingo.com/register?fresh=${Date.now()}`, { maxTry: 2, timeout: Math.max(60000, config.timeout) });
            await dismissCookieBanner(page, 5000).catch(() => { });
            ensure(await waitForOnboardingSurface(page, 20000), `Halaman register belum siap | url=${page.url()}`);
            if (showPointer) {
                await movePointer(page, randomBetween(90, 160), randomBetween(90, 140));
            }
            await sleep(2000);
        });

        await runStep('Pilih bahasa Inggris', async () => {
            await dismissCookieBanner(page, 2000).catch(() => { });
            const languageClicked = await safeClick(page, SELECTORS.englishCard, 8000);
            if (!languageClicked) {
                const alreadyBeyondLanguagePick =
                    await isSourceInfoStepVisible(page)
                    || await page.locator(CONTINUE_BUTTON_SELECTOR).first().isVisible().catch(() => false)
                    || await page.locator(SELECTORS.createProfile).first().isVisible().catch(() => false)
                    || await page.locator(SELECTORS.ageInput).first().isVisible().catch(() => false)
                    || await isEmailFormVisible(page);
                ensure(alreadyBeyondLanguagePick, `Selector tidak ketemu: ${SELECTORS.englishCard}`);
            }
            await sleep(1200);
        });

        await runStep('Continue setelah pilih bahasa', async () => {
            await clickContinue(page, 5000);
            await sleep(400);
        });

        await runStep('Continue overview', async () => {
            await clickContinue(page, 5000);
            await sleep(400);
        });

        await runStep('Sinkron ke step sumber info', async () => {
            ensure(await reachSourceStepQuick(page, 2), 'Step sumber info belum siap');
            await sleep(80);
        });

        await runStep('Survey sumber info', async () => {
            const prevStep = getWelcomeStepFromUrl(page.url());
            const pickStart = Date.now();
            const sourceClicked =
                await pickHdyhauOption(page, 3500)
                || await safeClick(page,
                    HDYHAU_OPTION_SELECTOR,
                    1500
                )
                || await clickRandomChoice(page);
            const pickLine = `[DUO][${email}] hdyhau pilih opsi +${Date.now() - pickStart}ms`;
            if (debugSteps) console.log(pickLine);
            if (externalLogger) externalLogger(pickLine);
            ensure(sourceClicked, 'Opsi survey sumber info tidak ketemu');
            const contStart = Date.now();
            await sleep(80);
            const continued =
                (await waitForContinueEnabled(page, 5000) && await waitAndClickContinueEnabled(page, 4000))
                || await forceClickContinue(page);
            ensure(continued, 'Tombol continue tidak ketemu (survey sumber info)');
            const contLine = `[DUO][${email}] hdyhau tunggu lanjut +${Date.now() - contStart}ms`;
            if (debugSteps) console.log(contLine);
            if (externalLogger) externalLogger(contLine);
            const moved =
                await waitForStepToChange(page, prevStep, 12000)
                || await waitForSourceInfoStepToExit(page, 6000);
            ensure(moved, `Masih tertahan di step sumber info | url=${page.url()}`);
            await sleep(120);
        });

        await runStep('Survey tujuan belajar', async () => {
            const otherClicked = await safeClick(page, SELECTORS.otherOption, 2000);
            if (!otherClicked) ensure(await clickChoiceByLabel(page, /lainnya|other/i) || await clickRandomChoice(page), 'Opsi tujuan belajar tidak ketemu');
            await sleep(400);
            ensure(await clickContinue(page), 'Tombol continue tidak ketemu (survey tujuan)');
            await sleep(800);
        });

        await runStep('Survey level kemampuan', async () => {
            const prevStep = getWelcomeStepFromUrl(page.url());
            const picked =
                await clickChoiceByLabel(page, /aku bisa bicara tentang berbagai topik|aku bisa membahas berbagai topik secara detail|aku tahu beberapa kata|aku baru mulai/i, 1500)
                || await clickRecordedRadio(page, /Aku bisa membahas berbagai/i)
                || await clickRandomChoice(page);

            if (picked) {
                await sleep(400);
                await clickContinue(page);
                const moved =
                    await waitWelcomeStepChanged(page, prevStep, 6000)
                    || !/welcomeStep=proficiency/i.test(page.url());
                ensure(moved, 'Step level kemampuan belum berpindah');
                await sleep(450);
                return;
            }

            ensure(await advanceByKeyboardSelection(page, 10), 'Pilihan level kemampuan tidak ketemu');
            ensure(
                await waitWelcomeStepChanged(page, prevStep, 6000) || !/welcomeStep=proficiency/i.test(page.url()),
                'Step level kemampuan belum berpindah'
            );
            await sleep(450);
        });

        await runStep('Continue preview course', async () => {
            ensure(await clickContinue(page), 'Tombol continue tidak ketemu (preview course)');
            await sleep(800);
        });

        await runStep('Survey target harian', async () => {
            if (/welcomeStep=proficiency/i.test(page.url())) {
                await advanceByKeyboardSelection(page, 8);
                await sleep(300);
            }
            const prevStep = getWelcomeStepFromUrl(page.url());
            ensure(
                await clickChoiceByLabel(page, /santai|mnt|hari|casual|regular|serious/i)
                || await clickRecordedRadio(page, /mnt \/ hari Santai/i)
                || await clickRandomChoice(page),
                'Pilihan target harian tidak ketemu'
            );
            await sleep(300);
            await clickContinue(page, 6000);
            const moved =
                await waitWelcomeStepChanged(page, prevStep, 9000)
                || !/welcomeStep=dailyGoal/i.test(page.url());
            ensure(moved, 'Stuck di step target harian (pilih belajar harian)');
            await sleep(800);
        });

        await runStep('Dismiss notifikasi', async () => {
            await safeClick(page, SELECTORS.blockButton, 3000);
            await sleep(600);
        });

        await runStep('Survey pilih jalur', async () => {
            const startUrl = page.url();
            await sleep(400);
            await (
                await clickChoiceByLabel(page, /mulai dari awal|ambil tes|test penempatan|placement/i)
                || await clickRecordedRadio(page, /Mulai dari awal Ambil/i)
                || await clickRandomChoice(page)
            );
            await sleep(400);
            const moved =
                await clickContinue(page, 5000)
                || await advanceByKeyboardSelection(page, 8)
                || await clickContinue(page, 5000)
                || page.url() !== startUrl;

            ensure(moved, 'Gagal lanjut dari course overview / pilih jalur');
            await sleep(800);
        });

        await runStep('Continue loading 1', async () => {
            ensure(await clickContinue(page), 'Tombol continue tidak ketemu (loading 1)');
            await sleep(800);
        });

        await runStep('Continue loading 2', async () => {
            ensure(await clickContinue(page), 'Tombol continue tidak ketemu (loading 2)');
            await sleep(800);
        });

        await runStep('Quit lesson', async () => {
            const quitClicked = await waitAndClickQuit(page, 12000);
            if (!quitClicked) {
                await clickContinue(page, 2500);
            }
            await sleep(1000);
        });

        await runStep('Buka menu profil', async () => {
            await safeClick(page, `${SELECTORS.profileAvatar}, [data-test="profile-menu"], img[alt="profile"]`, 3000);
            await sleep(800);
        });

        await runStep('Klik create profile', async () => {
            const createClicked = await safeClick(page, SELECTORS.createProfile, 5000);
            if (!createClicked) {
                await gotoWithRetry(page, 'https://www.duolingo.com/register', { maxTry: 2, timeout: Math.max(60000, config.timeout) });
                await sleep(2000);
            }
            await sleep(1000);
        });

        await runStep('Isi umur', async () => {
            await handleAgeStep(page);
        });

        await runStep('Isi email dan password', async () => {
            ensure(await waitForEmailForm(page, 90000), 'Form email dan password belum muncul');

            const emailInput = page.locator('input[type="email"], [data-test="email-input"], input[name="email"]').first();
            await fillCredentialField(page, emailInput, email, { label: 'email register' });
            await sleep(500);

            const pwInput = page.locator('input[type="password"], [data-test="password-input"]').first();
            await fillCredentialField(page, pwInput, password, { label: 'password register' });
            await sleep(500);

            let submitted = await safeClick(page, REGISTER_BUTTON_SELECTOR, 5000);
            if (!submitted) {
                await pwInput.press('Enter').catch(() => { });
                await sleep(1200);
                submitted = !await isEmailFormVisible(page);
            }
            if (!submitted) {
                submitted = await domClick(page, '[data-test="register-button"], button[type="submit"]');
                await sleep(1200);
            }
            if (!submitted && await page.locator(REGISTER_BUTTON_SELECTOR).first().isVisible().catch(() => false)) {
                submitted = await safeClick(page, REGISTER_BUTTON_SELECTOR, 3000);
            }

            await sleep(5000);
        });

        // ── 19. Deteksi sukses ──────────────────────────────────────────────────────
        const finalUrl = page.url();
        const success =
            finalUrl.includes('/learn') ||
            finalUrl.includes('/welcome') ||
            finalUrl.includes('/onboarding') ||
            (finalUrl.includes('duolingo.com') && !finalUrl.includes('/register'));

        await context.close();

        if (success) return { success: true, username, email, password };

        return { success: false, username, email, password, error: `Masih di: ${finalUrl}` };

    } catch (err) {
        if (context) await context.close().catch(() => { });
        return { success: false, username, email, password, error: err.message };
    }
}

export async function loginDuolingo(account, config) {
    const email = String(account?.email || '').trim();
    const password = String(account?.password || config?.password || '').trim();
    const username = String(account?.username || email.split('@')[0] || '').trim() || null;
    const proxy = normalizeProxyConfig(config?.proxy);
    const debugSteps = config?.debug_steps !== false;
    const showPointer = config?.show_pointer !== false;
    const effectiveLoginHeadless = config?.force_headed_login === true ? false : config?.headless === true;
    const manualPasswordRequested = config?.manual_password === true;
    const manualPassword = manualPasswordRequested && effectiveLoginHeadless !== true;
    const profileDir = resolveLoginSessionDir({ email, username }, config);
    const submitWaitRaw = config?.submit_wait_seconds;
    const submitWaitSeconds = submitWaitRaw === '' || submitWaitRaw === null
        ? null
        : Math.max(0, Number(submitWaitRaw ?? 4));
    const submitWaitMs = submitWaitSeconds == null ? null : Math.round(submitWaitSeconds * 1000);
    const configuredRetryAttempts = Math.floor(Number(config?.login_retry_attempts ?? 5));
    const retryIndefinitely = !manualPassword && (configuredRetryAttempts <= 0 || submitWaitMs == null);
    const maxLoginAttempts = manualPassword
        ? 1
        : (retryIndefinitely ? Number.MAX_SAFE_INTEGER : configuredRetryAttempts);
    const maxLoginAttemptsLabel = retryIndefinitely ? 'INF' : String(maxLoginAttempts);
    const externalLogger = typeof config?.onLog === 'function' ? config.onLog : null;
    const flowStartedAt = Date.now();
    let page;
    let stepIndex = 1;
    let attemptIndex = 1;
    const logStep = (message) => {
        const line = `[LOGIN][${email || 'unknown'}][A${String(attemptIndex).padStart(2, '0')}/${maxLoginAttemptsLabel}][${String(stepIndex).padStart(2, '0')}] ${message}`;
        if (debugSteps) console.log(line);
        if (externalLogger) externalLogger(line);
    };
    const runStep = async (message, action) => {
        const startedAt = Date.now();
        logStep(`START ${message} | t=${new Date(startedAt).toISOString()} | total=+${startedAt - flowStartedAt}ms`);
        try {
            if (page) await dismissCookieBanner(page, 500).catch(() => { });
            const result = await action();
            const elapsed = Date.now() - startedAt;
            const totalElapsed = Date.now() - flowStartedAt;
            logStep(`DONE  ${message} | +${elapsed}ms | total=+${totalElapsed}ms`);
            stepIndex += 1;
            return result;
        } catch (error) {
            try {
                if (page) {
                    const debugDir = resolveDebugDir();
                    mkdirSync(debugDir, { recursive: true });
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const safeStep = message.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const screenshotPath = join(debugDir, `duo-login-fail-${safeStep}-${stamp}.png`);
                    const htmlPath = join(debugDir, `duo-login-fail-${safeStep}-${stamp}.html`);
                    await page.screenshot({ path: screenshotPath, fullPage: true });
                    writeFileSync(htmlPath, await page.content(), 'utf8');
                    logStep(`DEBUG saved: ${screenshotPath} | ${htmlPath}`);
                }
            } catch { /* ignore */ }
            logStep(`FAIL  ${message} | ${error.message} | url=${page?.url?.() ?? '-'}`);
            throw error;
        }
    };
    let context;

    if (!email || (!password && !manualPassword)) {
        return {
            success: false,
            email,
            username,
            password,
            error: manualPassword ? 'Email kosong' : 'Email atau password kosong',
        };
    }

    try {
        const launchOptions = {
            headless: effectiveLoginHeadless,
            slowMo: config.slow_mo,
            viewport: { width: 1280, height: 800 },
            locale: 'id-ID',
        };

        if (proxy) {
            launchOptions.proxy = proxy;
        }

        mkdirSync(profileDir, { recursive: true });
        context = await chromium.launchPersistentContext(profileDir, launchOptions);

        if (showPointer) {
            await context.addInitScript(mountPointerOverlayScript);
        }

        const attachAttemptPage = async (nextPage) => {
            page = nextPage;
            await page.bringToFront().catch(() => { });
            getPointerSnapshot(page);
            page.setDefaultTimeout(config.timeout);
        };

        const reuseBootstrapPage = async () => {
            const existingPages = context.pages().filter((candidate) => !candidate.isClosed());
            if (existingPages.length === 0) return false;
            const [firstPage, ...otherPages] = existingPages;
            for (const existingPage of otherPages) {
                await existingPage.close().catch(() => { });
            }
            await attachAttemptPage(firstPage);
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
            return true;
        };

        const openRetryAttemptPage = async () => {
            const existingPages = context.pages().filter((candidate) => !candidate.isClosed());
            const fallbackPage = (page && !page.isClosed())
                ? page
                : (existingPages[0] || null);
            let nextPage = null;

            try {
                nextPage = await context.newPage();
            } catch {
                nextPage = fallbackPage;
                if (nextPage) {
                    logStep('[RETRY] gagal buka tab baru, pakai tab sebelumnya');
                }
            }

            if (!nextPage) {
                throw new Error('Gagal membuka tab baru untuk retry login');
            }

            for (const existingPage of existingPages) {
                if (existingPage === nextPage) continue;
                await existingPage.close().catch(() => { });
            }

            await attachAttemptPage(nextPage);
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
        };

        if (!await reuseBootstrapPage()) {
            await attachAttemptPage(await context.newPage());
        }
        const ensure = (ok, detail) => {
            if (!ok) throw new Error(detail);
        };
        logStep(`[BROWSER] chromium persistent | profile=${profileDir} | headless=${effectiveLoginHeadless}`);
        if (config?.force_headed_login === true && config?.headless === true) {
            logStep('[BROWSER] login dipaksa headed walau config headless aktif');
        }

        if (proxy) {
            await runStep('Validasi proxy', async () => {
                await verifyBrowserProxy({
                    page,
                    proxy,
                    log: (message) => logStep(message),
                    timeout: Math.max(10000, Math.min(config.timeout, 15000)),
                });
                await sleep(150);
            });
        } else {
            logStep('[PROXY] off');
        }

        if (manualPasswordRequested && !manualPassword) {
            logStep('[PASSWORD] manual mode diabaikan karena headless aktif');
        }

        let lastFailure = null;

        for (attemptIndex = 1; attemptIndex <= maxLoginAttempts; attemptIndex += 1) {
            stepIndex = 1;

            if (attemptIndex > 1) {
                logStep(`[RETRY] buka tab baru untuk percobaan ${attemptIndex}/${maxLoginAttemptsLabel}`);
                await openRetryAttemptPage();
            }

            try {
                const navigationState = await runStep('Navigate homepage login', async () => {
                    logStep('[SESSION] keep cookies + storage');
                    await gotoWithRetry(page, 'https://www.duolingo.com/?isLoggingIn=true', {
                        maxTry: 3,
                        timeout: Math.max(60000, config.timeout),
                    });
                    await gotoWithRetry(page, `https://www.duolingo.com/?isLoggingIn=true&fresh=${Date.now()}`, {
                        maxTry: 2,
                        timeout: Math.max(60000, config.timeout),
                    });
                    await dismissCookieBanner(page, 5000).catch(() => { });
                    const entryState = await waitForLoginEntryState(page, 5000);
                    if (entryState === 'authenticated') {
                        logStep(`[SESSION] sesi login masih aktif | skip form login | url=${page.url()}`);
                        return {
                            alreadyLoggedIn: true,
                            current_url: page.url(),
                        };
                    }
                    let loginEntryState = entryState;
                    if (loginEntryState !== 'form') {
                        loginEntryState = await openLoginForm(page, 12000);
                    }
                    if (loginEntryState === 'authenticated') {
                        logStep(`[SESSION] sesi login aktif setelah redirect | skip form login | url=${page.url()}`);
                        return {
                            alreadyLoggedIn: true,
                            current_url: page.url(),
                        };
                    }
                    ensure(loginEntryState === 'form', `Tombol/login form belum muncul | url=${page.url()}`);
                    const confirmedFormState = await waitForLoginEntryState(page, 20000);
                    if (confirmedFormState === 'authenticated') {
                        logStep(`[SESSION] sesi login aktif saat menunggu form | skip form login | url=${page.url()}`);
                        return {
                            alreadyLoggedIn: true,
                            current_url: page.url(),
                        };
                    }
                    ensure(confirmedFormState === 'form', `Form login belum muncul | url=${page.url()}`);
                    if (showPointer) {
                        await movePointer(page, randomBetween(90, 160), randomBetween(90, 140));
                    }
                    await sleep(350);
                    return {
                        alreadyLoggedIn: false,
                        current_url: page.url(),
                    };
                });

                let loginResult;
                if (navigationState?.alreadyLoggedIn) {
                    loginResult = {
                        success: true,
                        current_url: navigationState.current_url || page.url(),
                    };
                } else {
                    await runStep('Isi email dan password login', async () => {
                        const emailInput = page.locator(LOGIN_EMAIL_SELECTOR).first();
                        ensure(await emailInput.isVisible().catch(() => false), 'Input email login tidak terlihat');
                        await fillCredentialField(page, emailInput, email, { label: 'email login' });
                        await sleep(120);

                        const passwordInput = page.locator(LOGIN_PASSWORD_SELECTOR).first();
                        ensure(await passwordInput.isVisible().catch(() => false), 'Input password login tidak terlihat');
                        if (manualPassword) {
                            logStep('[PASSWORD] manual mode | ketik password di browser, jangan submit dulu');
                            const manualValue = await waitForManualPasswordEntry(page, passwordInput, {
                                label: 'password manual login',
                                timeout: Math.max(60000, config.timeout * 10),
                            });
                            logStep(`[PASSWORD] manual terdeteksi | length=${manualValue.length}`);
                        } else {
                            await fillCredentialField(page, passwordInput, password, { label: 'password login' });
                        }
                        await sleep(150);
                    });

                    loginResult = await runStep('Submit login', async () => {
                        const submitUrl = page.url();
                        const loginApiTracker = trackAsyncValue(
                            page.waitForResponse(
                                (response) => LOGIN_API_URL_PATTERN.test(response.url()) && response.request().method() === 'POST',
                                { timeout: Math.max(12000, Math.min(config.timeout, 20000)) },
                            )
                                .then((response) => parseLoginApiResponse(response))
                                .catch(() => null),
                        );

                        let submitted = await safeClick(page, LOGIN_BUTTON_SELECTOR, 5000);
                        if (!submitted) {
                            const byRole = page.getByRole('button', { name: /masuk|log in|login/i }).first();
                            if (await byRole.isVisible().catch(() => false)) {
                                submitted = await clickLocator(page, byRole, { timeout: 4000 });
                            }
                        }
                        if (!submitted) {
                            const passwordInput = page.locator(LOGIN_PASSWORD_SELECTOR).first();
                            await passwordInput.press('Enter').catch(() => { });
                            await sleep(300);
                        }

                        const loginResultTimeoutMs = submitWaitMs == null
                            ? Number.POSITIVE_INFINITY
                            : Math.max(16000, Number(config.timeout || 0), submitWaitMs + 6000);
                        const result = await waitForLoginResult(page, loginResultTimeoutMs, {
                            initialUrl: submitUrl,
                            minNoNavigationWaitMs: submitWaitMs ?? 0,
                            unlimitedWait: submitWaitMs == null,
                            loginApiTracker,
                        });

                        const loginApiResult = loginApiTracker.getValue();
                        if (loginApiResult) {
                            logStep(`[LOGIN API] status=${loginApiResult.status} success=${loginApiResult.success ? 'true' : 'false'} body=${loginApiResult.debug_body || '-'}`);
                        }

                        return result;
                    });
                }

                if (loginResult.success) {
                    let afterLoginResult = null;
                    if (config?.after_login_action && String(config.after_login_action).trim().toLowerCase() !== 'none') {
                        afterLoginResult = await runAfterLoginAction(page, config, logStep);
                    }
                    await context.close();
                    const normalizedTrialStatus = afterLoginResult?.status === 'vcc-injected-success'
                        ? 'submitted'
                        : null;
                    return {
                        success: true,
                        email,
                        username,
                        password,
                        current_url: loginResult.current_url,
                        attempt_count: attemptIndex,
                        after_login_action: afterLoginResult?.action || 'none',
                        after_login_status: afterLoginResult?.status || 'skipped',
                        after_login_error: afterLoginResult?.error || null,
                        after_login_url: afterLoginResult?.current_url || loginResult.current_url,
                        trial_status: normalizedTrialStatus,
                    };
                }

                lastFailure = {
                    error: loginResult.error || `Masih di: ${loginResult.current_url || page?.url?.() || '-'}`,
                    current_url: loginResult.current_url,
                };
            } catch (error) {
                lastFailure = {
                    error: error.message,
                    current_url: page?.url?.() || null,
                };
            }

            if (attemptIndex < maxLoginAttempts) {
                logStep(`[RETRY] gagal: ${lastFailure?.error || '-'} | siapkan percobaan ulang`);
                await sleep(350);
                continue;
            }

            break;
        }

        await context.close();

        return {
            success: false,
            email,
            username,
            password,
            error: lastFailure?.error || 'Login gagal',
            current_url: lastFailure?.current_url || null,
            attempt_count: Number.isFinite(maxLoginAttempts) ? maxLoginAttempts : attemptIndex,
        };
    } catch (err) {
        if (context) await context.close().catch(() => { });
        return {
            success: false,
            email,
            username,
            password,
            error: err.message,
            attempt_count: attemptIndex,
        };
    }
}
