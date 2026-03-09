import { spawn } from 'child_process';

let displayStartupPromise = null;
let displayProcess = null;
let managedDisplay = '';
let cleanupRegistered = false;

function stopManagedDisplay() {
    if (!displayProcess || displayProcess.killed) return;
    displayProcess.kill('SIGTERM');
}

function registerCleanupHandlers() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    process.once('exit', stopManagedDisplay);
    process.once('SIGINT', () => {
        stopManagedDisplay();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        stopManagedDisplay();
        process.exit(0);
    });
}

function describeSpawnError(error, stderr = '') {
    const detail = stderr.trim();
    return detail
        ? `${error.message} | ${detail}`
        : error.message;
}

async function startVirtualDisplay(log) {
    const command = process.env.XVFB_BIN || 'Xvfb';
    const args = ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac'];

    await new Promise((resolve, reject) => {
        let settled = false;
        let stderr = '';
        let stdout = '';
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            displayProcess = null;
            managedDisplay = '';
            reject(error);
        };

        const finishResolve = (display) => {
            if (settled) return;
            settled = true;
            displayProcess = child;
            managedDisplay = display;
            process.env.DISPLAY = display;
            registerCleanupHandlers();
            log?.(`[DISPLAY] Xvfb aktif di ${display}`);
            resolve();
        };

        const startupTimeout = setTimeout(() => {
            child.kill('SIGTERM');
            finishReject(new Error('Xvfb tidak siap dalam 5 detik'));
        }, 5000);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            const match = stdout.match(/(\d+)/);
            if (!match) return;
            clearTimeout(startupTimeout);
            finishResolve(`:${match[1]}`);
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            clearTimeout(startupTimeout);
            finishReject(new Error(`Gagal menjalankan Xvfb: ${describeSpawnError(error, stderr)}`));
        });

        child.on('exit', (code, signal) => {
            clearTimeout(startupTimeout);
            const exitedBeforeReady = !settled;
            displayProcess = null;
            if (managedDisplay && process.env.DISPLAY === managedDisplay) {
                delete process.env.DISPLAY;
            }
            managedDisplay = '';

            if (exitedBeforeReady) {
                const reason = stderr.trim() || `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
                finishReject(new Error(`Xvfb berhenti sebelum siap: ${reason}`));
            }
        });
    });
}

export async function ensureVirtualDisplay({ headless = true, log } = {}) {
    if (headless === true) return false;
    if (process.platform !== 'linux') return false;

    const existingDisplay = String(process.env.DISPLAY || '').trim();
    if (existingDisplay) {
        log?.(`[DISPLAY] gunakan ${existingDisplay}`);
        return false;
    }

    if (displayProcess && displayProcess.exitCode === null && managedDisplay) {
        process.env.DISPLAY = managedDisplay;
        log?.(`[DISPLAY] gunakan ${managedDisplay}`);
        return false;
    }

    if (!displayStartupPromise) {
        // Request headed bisa datang walau web server boot dalam mode headless.
        displayStartupPromise = startVirtualDisplay(log)
            .finally(() => {
                displayStartupPromise = null;
            });
    }

    await displayStartupPromise;
    return true;
}
