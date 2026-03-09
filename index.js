    // index.js — Main entry point for Duolingo login automation
    // Interactive console UI

    import chalk from 'chalk';
    import inquirer from 'inquirer';
    import Table from 'cli-table3';
    import ora from 'ora';
    import { rmSync } from 'fs';
    import { resolve } from 'path';

    import {
        getLoginState,
        getSessionState,
        getTrialState,
        hasStoredSessionDir,
        hasUsablePassword,
        normalizeLoginAccount,
        resolveBaseProfileDir,
    } from './src/account-session.js';
    import { loadConfig } from './src/config.js';
    import { loginDuolingo } from './src/duolingo.js';
    import { loginAccountsBatch } from './src/login-batch.js';
    import {
        buildPaymentData,
        formatExpDate,
        formatStoredExpDate,
        formatVccLine,
        maskCardNumber,
        normalizeCardNumber,
        normalizeExpParts,
    } from './src/payment.js';
    import { buildRuntimeLoginConfig } from './src/runtime-config.js';
    import {
        deleteSignInAccounts,
        loadSignInAccounts,
        loadVccEntries,
        resetSignInAccountLoginState,
        saveSignInAccount,
        saveVccEntry,
        updateSignInAccountLoginResult,
        deleteVccEntries,
    } from './src/storage.js';
    import { maskValue } from './src/value-utils.js';

    const config = loadConfig();
    const LOGIN_BADGE_BY_STATE = {
        pending: chalk.gray('· belum'),
        success: chalk.green('✔ login'),
        failed: chalk.red('✘ login'),
    };
    const TRIAL_BADGE_BY_STATE = {
        unknown: chalk.gray('· belum'),
        claimed: chalk.green('★ claimed'),
        submitted: chalk.yellow('◔ submit'),
        failed: chalk.red('✘ gagal'),
    };

    function decorateAccounts(accounts) {
        return accounts.map((account) => {
            const session = getSessionState(account, config);
            const login = getLoginState(account, session, config);
            const trial = getTrialState(account);

            return {
                ...account,
                session_dir: session.dir,
                has_session: session.hasSession,
                session_label: session.label,
                login_label: login.label,
                login_badge: LOGIN_BADGE_BY_STATE[login.key] || LOGIN_BADGE_BY_STATE.pending,
                trial_label: trial.label,
                trial_badge: TRIAL_BADGE_BY_STATE[trial.key] || TRIAL_BADGE_BY_STATE.unknown,
                trial_key: trial.key,
            };
        });
    }

    async function getLoginAccounts(runtimeConfig = config) {
        const accounts = await loadSignInAccounts();
        return decorateAccounts(accounts.map((account) => normalizeLoginAccount(account, runtimeConfig)).filter(Boolean));
    }

    function formatAccountLine(account) {
        const sessionBadge = account.has_session ? chalk.cyan('sesi') : chalk.gray('baru');
        return `${account.login_badge} ${account.trial_badge} ${sessionBadge} ${String(account.username || '-').padEnd(18)} | ${account.email || '-'}`;
    }

    function formatSubmitWaitLabel(value) {
        if (value === null || value === '') return 'unlimited';
        return `${value}s`;
    }

    async function promptPasswordMode() {
        const { passwordMode } = await inquirer.prompt([
            {
                type: 'list',
                name: 'passwordMode',
                message: chalk.bold('Mode input password:'),
                choices: [
                    {
                        name: `Manual di browser${config.manual_password === true ? ' (default)' : ''}`,
                        value: 'manual',
                    },
                    {
                        name: `Otomatis dari file / config${config.manual_password === true ? '' : ' (default)'}`,
                        value: 'auto',
                    },
                    {
                        name: 'Kembali',
                        value: 'back',
                    },
                ],
                default: config.manual_password === true ? 'manual' : 'auto',
            },
        ]);

        return passwordMode;
    }

    async function promptSubmitWaitSeconds(defaultSeconds) {
        const { submitWait } = await inquirer.prompt([
            {
                type: 'input',
                name: 'submitWait',
                message: chalk.bold(`Tunggu berapa detik setelah submit login? (default ${formatSubmitWaitLabel(defaultSeconds)}, kosong = unlimited, ketik "back" untuk kembali)`),
                default: defaultSeconds === null || defaultSeconds === '' ? '' : String(defaultSeconds),
                validate: (value) => {
                    const text = String(value || '').trim().toLowerCase();
                    if (text === 'back') return true;
                    if (text === '') return true;
                    const parsed = Number(text);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300) {
                        return 'Masukkan angka 0 - 300 detik, kosongkan untuk unlimited, atau ketik back';
                    }
                    return true;
                },
            },
        ]);

        const text = String(submitWait || '').trim().toLowerCase();
        if (text === 'back') return null;
        if (text === '') return '';
        return Number(text);
    }

    async function promptAfterLoginAction() {
        const { afterLoginAction } = await inquirer.prompt([
            {
                type: 'list',
                name: 'afterLoginAction',
                message: chalk.bold('After login:'),
                choices: [
                    { name: 'Tidak ada', value: 'none' },
                    { name: 'Buka trial dan isi data pembayaran otomatis', value: 'trial-auto-vcc' },
                    { name: 'Kembali', value: 'back' },
                ],
                default: 'none',
            },
        ]);

        return afterLoginAction;
    }

    async function promptPaymentDetails(options = {}) {
        const initialValues = options.initialValues || {};
        const title = String(options.title || ' INPUT DATA PEMBAYARAN ').trimEnd();
        console.log(`\n${chalk.bold.bgBlue.white(` ${title} `)}`);
        console.log(chalk.gray('Data ini dipakai otomatis saat halaman trial menampilkan form pembayaran.\n'));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'label',
                message: chalk.bold('Label VCC (opsional):'),
                default: String(initialValues.label || '').trim(),
                filter: (value) => String(value || '').trim(),
            },
            {
                type: 'input',
                name: 'cardNumber',
                message: chalk.bold('Nomor kartu:'),
                default: normalizeCardNumber(initialValues.cardNumber || ''),
                filter: (value) => {
                    const text = String(value || '').trim();
                    return text.toLowerCase() === 'back' ? 'back' : normalizeCardNumber(text);
                },
                validate: (value) => {
                    if (String(value || '').trim().toLowerCase() === 'back') return true;
                    const digits = normalizeCardNumber(value);
                    return digits.length >= 15 && digits.length <= 19
                        ? true
                        : 'Nomor kartu harus 15 - 19 digit, atau ketik back';
                },
            },
            {
                type: 'input',
                name: 'expDateRaw',
                message: chalk.bold('Expired (MM/YY atau MM/YYYY):'),
                when: (answers) => String(answers.cardNumber || '').trim().toLowerCase() !== 'back',
                default: formatExpDate(initialValues.expDate || `${initialValues.expMonth || ''}${initialValues.expYear || ''}`),
                filter: (value) => formatExpDate(value),
                validate: (value, answers) => {
                    if (String(answers.cardNumber || '').trim().toLowerCase() === 'back') return true;
                    const { expMonth, expYear } = normalizeExpParts(value);
                    if (!expMonth || !expYear || ![2, 4].includes(String(expYear).length)) {
                        return 'Format harus MM/YY atau MM/YYYY';
                    }
                    const month = Number(expMonth);
                    return month >= 1 && month <= 12 ? true : 'Bulan expired harus 01 - 12';
                },
            },
            {
                type: 'password',
                name: 'cvc',
                mask: '*',
                message: chalk.bold('CVC:'),
                when: (answers) => String(answers.cardNumber || '').trim().toLowerCase() !== 'back',
                default: String(initialValues.cvc || '').trim(),
                filter: (value) => String(value || '').replace(/\D+/g, '').slice(0, 4),
                validate: (value, answers) => {
                    if (String(answers.cardNumber || '').trim().toLowerCase() === 'back') return true;
                    return /^\d{3,4}$/.test(String(value || '').trim())
                        ? true
                        : 'CVC harus 3 atau 4 digit';
                },
            },
            {
                type: 'input',
                name: 'cardholderName',
                message: chalk.bold('Nama pada kartu (opsional):'),
                when: (answers) => String(answers.cardNumber || '').trim().toLowerCase() !== 'back',
                default: String(initialValues.cardholderName || '').trim(),
                filter: (value) => String(value || '').trim(),
            },
            {
                type: 'input',
                name: 'postalCode',
                message: chalk.bold('Kode pos billing (opsional):'),
                when: (answers) => String(answers.cardNumber || '').trim().toLowerCase() !== 'back',
                default: String(initialValues.postalCode || '').trim(),
                filter: (value) => String(value || '').trim(),
            },
        ]);

        if (String(answers.cardNumber || '').trim().toLowerCase() === 'back') {
            return null;
        }

        const paymentData = buildPaymentData({
            ...initialValues,
            ...answers,
            expDate: answers.expDateRaw,
        });

        console.log(
            chalk.cyan(
                `\n  Pembayaran siap dipakai: ${paymentData.label || maskCardNumber(paymentData.cardNumber)} | ${maskCardNumber(paymentData.cardNumber)} | exp ${paymentData.expDate}${paymentData.postalCode ? ` | zip ${paymentData.postalCode}` : ''}\n`,
            ),
        );

        return paymentData;
    }

    async function promptSelectStoredVcc(message = 'Pilih VCC dari vcc.json:') {
        const entries = await loadVccEntries();
        if (entries.length === 0) {
            console.log(chalk.yellow('\n  vcc.json masih kosong. Isi dulu dari menu Kelola VCC.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return null;
        }

        const { vccId } = await inquirer.prompt([
            {
                type: 'list',
                name: 'vccId',
                message: chalk.bold(message),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: '__back__' },
                    ...entries.map((entry) => ({
                        name: formatVccLine(entry),
                        value: entry.id,
                    })),
                ],
            },
        ]);

        if (vccId === '__back__') return null;
        const selected = entries.find((entry) => entry.id === vccId);
        return selected ? buildPaymentData(selected) : null;
    }

    async function showVccFlow() {
        const entries = await loadVccEntries();
        if (entries.length === 0) {
            console.log(chalk.yellow('\n  Belum ada VCC di vcc.json.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const table = new Table({
            head: [
                chalk.bold.cyan('#'),
                chalk.bold.cyan('Label'),
                chalk.bold.cyan('Kartu'),
                chalk.bold.cyan('Exp'),
                chalk.bold.cyan('Holder'),
                chalk.bold.cyan('ZIP'),
                chalk.bold.cyan('Updated'),
            ],
            colWidths: [5, 20, 24, 12, 22, 12, 24],
            style: { border: ['gray'] },
        });

        entries.forEach((entry, index) => {
            table.push([
                index + 1,
                entry.label || '-',
                maskCardNumber(entry.cardNumber),
                entry.expDate || '-',
                entry.cardholderName || '-',
                entry.postalCode || '-',
                entry.updated_at ? new Date(entry.updated_at).toLocaleString('id-ID') : '-',
            ]);
        });

        console.log('\n' + table.toString() + '\n');
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function saveVccFlow(existingEntry = null) {
        const shouldProceed = existingEntry
            ? true
            : await promptProceedOrBack('Tambah VCC baru ke vcc.json?', 'Isi VCC');
        if (!shouldProceed) return;

        const paymentData = await promptPaymentDetails({
            title: existingEntry ? 'EDIT DATA VCC' : 'INPUT DATA VCC',
            initialValues: existingEntry || {},
        });
        if (!paymentData) return;

        const result = await saveVccEntry({
            ...existingEntry,
            ...paymentData,
        });

        console.log(
            chalk.green(
                `\n  VCC ${result.updated ? 'berhasil diperbarui' : 'berhasil disimpan'} ke vcc.json.\n`,
            ),
        );
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function editVccFlow() {
        const entries = await loadVccEntries();
        if (entries.length === 0) {
            console.log(chalk.yellow('\n  Belum ada VCC di vcc.json.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const { vccId } = await inquirer.prompt([
            {
                type: 'list',
                name: 'vccId',
                message: chalk.bold('Pilih VCC yang ingin diedit:'),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: '__back__' },
                    ...entries.map((entry) => ({
                        name: formatVccLine(entry),
                        value: entry.id,
                    })),
                ],
            },
        ]);

        if (vccId === '__back__') return;
        const selected = entries.find((entry) => entry.id === vccId);
        if (!selected) return;
        await saveVccFlow(selected);
    }

    async function deleteVccFlow() {
        const entries = await loadVccEntries();
        if (entries.length === 0) {
            console.log(chalk.yellow('\n  Belum ada VCC di vcc.json.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const { selectedIds } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedIds',
                message: chalk.bold('Pilih VCC yang ingin dihapus:'),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: '__back__' },
                    new inquirer.Separator(),
                    ...entries.map((entry) => ({
                        name: formatVccLine(entry),
                        value: entry.id,
                    })),
                ],
                validate: (value) => {
                    if (value.includes('__back__') && value.length === 1) return true;
                    if (value.includes('__back__')) return 'Pilih Kembali saja, atau pilih VCC yang ingin dihapus';
                    return value.length > 0 ? true : 'Pilih minimal 1 VCC';
                },
            },
        ]);

        if (selectedIds.includes('__back__')) return;

        const { confirmed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmed',
                message: chalk.red(`Hapus ${selectedIds.length} VCC dari vcc.json?`),
                default: false,
            },
        ]);

        if (!confirmed) return;

        const result = await deleteVccEntries(selectedIds);
        console.log(chalk.green(`\n  ${result.removedCount} VCC berhasil dihapus.\n`));
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function manageVccFlow() {
        while (true) {
            const entries = await loadVccEntries();
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: chalk.bold(`Kelola VCC (${entries.length} tersimpan):`),
                    choices: [
                        { name: '📋  Lihat daftar VCC', value: 'list' },
                        { name: '➕  Tambah VCC', value: 'add' },
                        { name: '✏️  Edit VCC', value: 'edit' },
                        { name: '🗑  Hapus VCC', value: 'delete' },
                        { name: '↩️  Kembali', value: 'back' },
                    ],
                },
            ]);

            if (action === 'back') return;
            if (action === 'list') {
                await showVccFlow();
                continue;
            }
            if (action === 'add') {
                await saveVccFlow();
                continue;
            }
            if (action === 'edit') {
                await editVccFlow();
                continue;
            }
            if (action === 'delete') {
                await deleteVccFlow();
            }
        }
    }

    async function promptProceedOrBack(message, proceedLabel = 'Lanjut') {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: chalk.bold(message),
                choices: [
                    { name: proceedLabel, value: 'proceed' },
                    { name: 'Kembali', value: 'back' },
                ],
            },
        ]);

        return action === 'proceed';
    }

    function printBanner() {
        const browserLabel = String(config.browser || 'chromium').trim().toLowerCase() === 'chrome-stable'
            ? 'Chrome Stable (Playwright)'
            : 'Chromium (Playwright)';
        console.clear();
        console.log(chalk.bold.green('╔══════════════════════════════════════════════╗'));
        console.log(chalk.bold.green('║') + chalk.bold.white('   DUOLINGO LOGIN AUTOMATION                   ') + chalk.bold.green('║'));
        console.log(chalk.bold.green('║') + chalk.gray('   Source: sign-in-account.json                ') + chalk.bold.green('║'));
        console.log(chalk.bold.green('║') + chalk.gray(`   Browser: ${browserLabel.padEnd(31, ' ')}║`));
        console.log(chalk.bold.green('╚══════════════════════════════════════════════╝'));
        console.log();
        console.log(chalk.bold('  Config yang dipakai:'));
        console.log(chalk.cyan(`    • browser       : ${config.browser || 'chromium'}`));
        console.log(chalk.cyan(`    • profile       : ${config.profile_dir || '.profiles/duolingo-chromium'}`));
        console.log(chalk.cyan(`    • persistent    : ${config.persistent_profile !== false}`));
        console.log(chalk.cyan(`    • headless      : ${config.headless}`));
        console.log(chalk.cyan(`    • login headed  : ${config.force_headed_login === true}`));
        console.log(chalk.cyan(`    • pointer       : ${config.show_pointer !== false}`));
        console.log(chalk.cyan(`    • manual pass   : ${config.manual_password === true}`));
        console.log(chalk.cyan(`    • slow_mo       : ${config.slow_mo}ms`));
        console.log(chalk.cyan(`    • timeout       : ${config.timeout}ms`));
        console.log(chalk.cyan(`    • submit wait   : ${formatSubmitWaitLabel(config.submit_wait_seconds ?? 4)}`));
        console.log(chalk.cyan(`    • retry login   : ${config.login_retry_attempts ?? 5}`));
        console.log(chalk.cyan(`    • max_workers   : ${config.max_workers}`));
        console.log(chalk.cyan(`    • fallback pass : ${maskValue(config.password)}`));
        console.log(chalk.cyan(`    • proxy         : ${config?.proxy?.server || 'off'}`));
        console.log();
    }

    async function mainMenu() {
        while (true) {
            printBanner();

            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: chalk.bold('Pilih aksi:'),
                    choices: [
                        { name: '🔐  Login 1 akun dari sign-in-account.json', value: 'login-one' },
                        { name: '⚡  Login beberapa akun terbaru', value: 'login-batch' },
                        { name: '➕  Input / simpan akun login', value: 'save-account' },
                        { name: '💳  Kelola VCC di vcc.json', value: 'manage-vcc' },
                        { name: '🗑  Hapus akun dari sign-in-account.json', value: 'delete-account' },
                        { name: '📋  Lihat daftar akun di sign-in-account.json', value: 'list' },
                        { name: '🧹  Hapus sesi login tersimpan', value: 'clear-session' },
                        { name: '❌  Keluar', value: 'exit' },
                    ],
                },
            ]);

            if (action === 'exit') {
                console.log(chalk.yellow('\n  Sampai jumpa!\n'));
                process.exit(0);
            }

            if (action === 'list') {
                await showAccounts();
                continue;
            }

            if (action === 'save-account') {
                await saveAccountFlow();
                continue;
            }

            if (action === 'manage-vcc') {
                await manageVccFlow();
                continue;
            }

            if (action === 'delete-account') {
                await deleteAccountFlow();
                continue;
            }

            if (action === 'clear-session') {
                await clearSessionFlow();
                continue;
            }

            if (action === 'login-one') {
                await loginOneAccountFlow();
                continue;
            }

            if (action === 'login-batch') {
                await loginBatchFlow();
            }
        }
    }

    async function showAccounts() {
        const accounts = decorateAccounts(await loadSignInAccounts());

        if (accounts.length === 0) {
            console.log(chalk.yellow('\n  Belum ada akun login di sign-in-account.json.\n'));
        } else {
            const table = new Table({
                head: [
                    chalk.bold.cyan('#'),
                    chalk.bold.cyan('Login'),
                    chalk.bold.cyan('Trial'),
                    chalk.bold.cyan('Sesi'),
                    chalk.bold.cyan('Username'),
                    chalk.bold.cyan('Email'),
                    chalk.bold.cyan('Password'),
                    chalk.bold.cyan('Dibuat'),
                ],
                colWidths: [5, 14, 14, 14, 18, 33, 18, 24],
                style: { border: ['gray'] },
            });

            accounts.forEach((acc, i) => {
                table.push([
                    i + 1,
                    acc.login_badge,
                    acc.trial_badge,
                    acc.has_session
                        ? chalk.green('✔ Tersimpan')
                        : (config.persistent_profile === false ? chalk.gray('off') : chalk.gray('-')),
                    acc.username || '-',
                    acc.email || '-',
                    acc.password || '-',
                    acc.created_at ? new Date(acc.created_at).toLocaleString('id-ID') : '-',
                ]);
            });

            console.log('\n' + table.toString() + '\n');
        }

        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    function printLoginSummary(title, results) {
        console.log('\n' + chalk.bold.green('═'.repeat(80)));
        console.log(chalk.bold.white(`  ${title}`));
        console.log(chalk.bold.green('═'.repeat(80)));

        const table = new Table({
            head: [
                chalk.bold.cyan('#'),
                chalk.bold.cyan('Status'),
                chalk.bold.cyan('Email'),
                chalk.bold.cyan('Username'),
                chalk.bold.cyan('Info'),
            ],
            colWidths: [5, 12, 35, 20, 30],
            style: { border: ['gray'] },
        });

        results.forEach((row, index) => {
            const trialInfo = row.after_login_action && row.after_login_action !== 'none'
                ? ` | trial=${row.trial_status || row.after_login_status || '-'}`
                : '';
            table.push([
                index + 1,
                row.success ? chalk.green('✔ Sukses') : chalk.red('✘ Gagal'),
                row.email || '-',
                row.username || '-',
                row.success
                    ? `${row.current_url || 'Logged in'}${trialInfo}`
                    : (row.error || '-'),
            ]);
        });

        console.log(table.toString() + '\n');
    }

    async function saveAccountFlow() {
        const shouldProceed = await promptProceedOrBack('Input akun login baru?', 'Isi akun');
        if (!shouldProceed) return;

        const storedAccounts = decorateAccounts(await loadSignInAccounts());
        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'email',
                message: chalk.bold('Email:'),
                validate: (value) => {
                    const email = String(value || '').trim();
                    return /.+@.+\..+/.test(email) ? true : 'Email tidak valid';
                },
            },
            {
                type: 'password',
                name: 'password',
                mask: '*',
                message: chalk.bold('Password:'),
                validate: (value) => (String(value || '').trim() ? true : 'Password wajib diisi'),
            },
            {
                type: 'input',
                name: 'username',
                message: chalk.bold('Username (opsional):'),
            },
        ]);

        const email = String(answers.email || '').trim();
        const password = String(answers.password || '').trim();
        const username = String(answers.username || '').trim();
        const existing = storedAccounts.find((account) => String(account?.email || '').trim().toLowerCase() === email.toLowerCase());

        if (existing) {
            const { confirmed } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirmed',
                    message: chalk.yellow(`Akun ${email} sudah ada. Update data akun ini?`),
                    default: true,
                },
            ]);

            if (!confirmed) return;
        }

        const result = await saveSignInAccount({
            email,
            password,
            username,
        });

        console.log(
            chalk.green(
                `\n  Akun ${email} ${result.updated ? 'berhasil diperbarui' : 'berhasil disimpan'} ke sign-in-account.json.\n`,
            ),
        );

        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function deleteAccountFlow() {
        const accounts = decorateAccounts(await loadSignInAccounts());

        if (accounts.length === 0) {
            console.log(chalk.yellow('\n  Belum ada akun di sign-in-account.json.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const { selectedIndexes } = await inquirer.prompt([
            {
                type: 'checkbox',
                name: 'selectedIndexes',
                message: chalk.bold('Pilih akun yang ingin dihapus:'),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: '__back__' },
                    new inquirer.Separator(),
                    ...accounts.map((account, index) => ({
                        name: formatAccountLine(account),
                        value: index,
                    })),
                ],
                validate: (value) => {
                    if (value.includes('__back__') && value.length === 1) return true;
                    if (value.includes('__back__')) return 'Pilih Kembali saja, atau pilih akun yang ingin dihapus';
                    return value.length > 0 ? true : 'Pilih minimal 1 akun';
                },
            },
        ]);

        if (selectedIndexes.includes('__back__')) return;

        const selectedAccounts = selectedIndexes.map((index) => accounts[index]).filter(Boolean);
        const selectedEmails = selectedAccounts
            .map((account) => String(account?.email || '').trim())
            .filter(Boolean);

        const { confirmed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmed',
                message: chalk.red(`Hapus ${selectedEmails.length} akun dari sign-in-account.json?`),
                default: false,
            },
        ]);

        if (!confirmed) return;

        const { removedCount } = await deleteSignInAccounts(selectedEmails);
        const sessionAccounts = selectedAccounts.filter((account) => account.has_session);

        if (sessionAccounts.length > 0) {
            const { removeSessions } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'removeSessions',
                    message: chalk.yellow(`Ikut hapus ${sessionAccounts.length} sesi login tersimpan akun terpilih?`),
                    default: true,
                },
            ]);

            if (removeSessions) {
                for (const account of sessionAccounts) {
                    rmSync(account.session_dir, { recursive: true, force: true });
                }
            }
        }

        console.log(chalk.green(`\n  ${removedCount} akun berhasil dihapus.\n`));
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function clearSessionFlow() {
        if (config.persistent_profile === false) {
            console.log(chalk.yellow('\n  Persistent profile sedang off, jadi tidak ada sesi tersimpan yang bisa dihapus.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const accounts = await getLoginAccounts();
        const storedAccounts = accounts.filter((account) => account.has_session);
        const loginBaseDir = resolve(resolveBaseProfileDir(config), 'login');

        const { scope } = await inquirer.prompt([
            {
                type: 'list',
                name: 'scope',
                message: chalk.bold('Sesi mana yang ingin dihapus?'),
                choices: [
                    { name: `1 akun (${storedAccounts.length} sesi tersimpan)`, value: 'one' },
                    { name: 'Semua sesi login', value: 'all' },
                    { name: 'Kembali', value: 'back' },
                ],
            },
        ]);

        if (scope === 'back') return;

        if (scope === 'all') {
            const hadAnySession = hasStoredSessionDir(loginBaseDir);
            if (!hadAnySession) {
                console.log(chalk.yellow('\n  Belum ada folder sesi login yang tersimpan.\n'));
                await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
                return;
            }

            const { confirmed } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirmed',
                    message: chalk.red(`Hapus semua sesi login di ${loginBaseDir}?`),
                    default: false,
                },
            ]);

            if (!confirmed) return;

            rmSync(loginBaseDir, { recursive: true, force: true });
            await resetSignInAccountLoginState(storedAccounts.map((account) => account.email)).catch(() => { });
            console.log(chalk.green('\n  Semua sesi login berhasil dihapus.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        if (storedAccounts.length === 0) {
            console.log(chalk.yellow('\n  Belum ada akun yang punya sesi tersimpan.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const { accountIndex } = await inquirer.prompt([
            {
                type: 'list',
                name: 'accountIndex',
                message: chalk.bold('Pilih akun yang sesi-nya ingin dihapus:'),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: -1 },
                    ...storedAccounts.map((account, index) => ({
                        name: formatAccountLine(account),
                        value: index,
                    })),
                ],
            },
        ]);

        if (accountIndex < 0) return;

        const account = storedAccounts[accountIndex];
        const { confirmed } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmed',
                message: chalk.red(`Hapus sesi login untuk ${account.email}?`),
                default: false,
            },
        ]);

        if (!confirmed) return;

        rmSync(account.session_dir, { recursive: true, force: true });
        await resetSignInAccountLoginState([account.email]).catch(() => { });
        console.log(chalk.green(`\n  Sesi login ${account.email} berhasil dihapus.\n`));
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
    }

    async function loginOneAccountFlow() {
        const passwordMode = await promptPasswordMode();
        if (passwordMode === 'back') return;

        const runtimeConfig = buildRuntimeLoginConfig(config, passwordMode);
        const accounts = await getLoginAccounts(runtimeConfig);
        if (accounts.length === 0) {
            console.log(chalk.yellow('\n  Belum ada akun login yang cocok dengan mode ini di sign-in-account.json.\n'));
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const afterLoginAction = await promptAfterLoginAction();
        if (afterLoginAction === 'back') return;
        runtimeConfig.after_login_action = afterLoginAction;

        if (afterLoginAction === 'trial-auto-vcc') {
            const paymentData = await promptSelectStoredVcc('Pilih VCC dari vcc.json untuk claim trial:');
            if (!paymentData) return;
            runtimeConfig.vccData = paymentData;
        }

        const { accountIndex } = await inquirer.prompt([
            {
                type: 'list',
                name: 'accountIndex',
                message: chalk.bold('Pilih akun yang ingin di-login:'),
                pageSize: 15,
                choices: [
                    { name: 'Kembali', value: -1 },
                    ...accounts.map((account, index) => ({
                        name: formatAccountLine(account),
                        value: index,
                    })),
                ],
            },
        ]);

        if (accountIndex < 0) return;

        const account = accounts[accountIndex];
        const spinner = ora({
            text: chalk.gray(`[1/1] Login ${account.email}...`),
            color: 'cyan',
        }).start();

        let result;
        try {
            result = await loginDuolingo(account, runtimeConfig);
            if (result.success) {
                spinner.succeed(
                    chalk.green('[1/1] ✔ Login sukses') +
                    chalk.gray(` | ${result.email} | ${result.current_url || '-'}`)
                );
            } else {
                spinner.fail(chalk.red(`[1/1] Gagal login: ${result.error}`));
            }
        } catch (error) {
            result = {
                success: false,
                email: account.email,
                username: account.username,
                error: error.message,
            };
            spinner.fail(chalk.red(`[1/1] Error: ${error.message}`));
        }

        await updateSignInAccountLoginResult(account.email, result).catch(() => { });
        printLoginSummary('HASIL LOGIN', [result]);
        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali ke menu...' }]);
    }

    async function loginBatchFlow() {
        const runtimeConfig = buildRuntimeLoginConfig(config, 'auto');
        const submitWaitSeconds = await promptSubmitWaitSeconds(runtimeConfig.submit_wait_seconds ?? 10);
        if (submitWaitSeconds === null) return;
        runtimeConfig.submit_wait_seconds = submitWaitSeconds;
        const accounts = (await getLoginAccounts(runtimeConfig)).filter((account) => hasUsablePassword(account, runtimeConfig));
        if (accounts.length === 0) {
            console.log(
                chalk.yellow(
                    runtimeConfig.manual_password === true
                        ? '\n  Tidak ada akun valid di sign-in-account.json.\n'
                        : '\n  Tidak ada akun yang punya password tersimpan / fallback untuk mode otomatis.\n',
                ),
            );
            await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali...' }]);
            return;
        }

        const shouldProceed = await promptProceedOrBack('Masuk ke pengaturan login batch?', 'Lanjut login batch');
        if (!shouldProceed) return;

        const afterLoginAction = await promptAfterLoginAction();
        if (afterLoginAction === 'back') return;
        runtimeConfig.after_login_action = afterLoginAction;

        if (afterLoginAction === 'trial-auto-vcc') {
            const paymentData = await promptSelectStoredVcc('Pilih VCC dari vcc.json untuk semua akun batch:');
            if (!paymentData) return;
            runtimeConfig.vccData = paymentData;
        }

        const orderedAccounts = [...accounts].reverse();
        const { count } = await inquirer.prompt([
            {
                type: 'number',
                name: 'count',
                message: chalk.bold(`Berapa akun terbaru yang ingin di-login? (maks ${orderedAccounts.length})`),
                default: 1,
                validate: (value) => (
                    value >= 1 && value <= orderedAccounts.length
                        ? true
                        : `Masukkan angka antara 1 - ${orderedAccounts.length}`
                ),
            },
        ]);

        console.log();
        console.log(
            chalk.bold.green(
                `  Memulai login ${count} akun dengan ${runtimeConfig.max_workers} worker | password ${runtimeConfig.manual_password === true ? 'manual' : 'otomatis'}...\n`,
            ),
        );

        const result = await loginAccountsBatch({
            count,
            baseConfig: runtimeConfig,
            accounts: orderedAccounts.slice(0, count),
        });

        printLoginSummary('HASIL LOGIN BATCH', result.results || []);

        console.log(
            chalk.bold('  Total: ') +
            chalk.green(`${result.successCount || 0} sukses`) +
            chalk.gray(' / ') +
            chalk.red(`${result.failedCount || 0} gagal`)
        );
        console.log();

        await inquirer.prompt([{ type: 'input', name: 'back', message: 'Tekan Enter untuk kembali ke menu...' }]);
    }

    mainMenu().catch((err) => {
        console.error(chalk.red('\n  Fatal error:'), err.message);
        process.exit(1);
    });
