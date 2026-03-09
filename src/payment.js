// Semua normalisasi VCC/payment dikumpulkan di sini supaya format input dari
// CLI, API, file JSON, dan flow Stripe mengikuti aturan yang sama.
export function normalizeCardNumber(value) {
    return String(value || '').replace(/\D+/g, '');
}

export function normalizeExpParts(value) {
    const digits = String(value || '').replace(/\D+/g, '');

    if (digits.length === 4) {
        return {
            expMonth: digits.slice(0, 2),
            expYear: `20${digits.slice(2)}`,
        };
    }

    if (digits.length >= 6) {
        return {
            expMonth: digits.slice(0, 2),
            expYear: digits.slice(2, 6),
        };
    }

    return {
        expMonth: digits.slice(0, 2),
        expYear: digits.slice(2),
    };
}

export function formatExpDate(value) {
    const { expMonth, expYear } = normalizeExpParts(value);

    if (!expMonth && !expYear) return '';
    if (!expMonth || !expYear) return `${expMonth}${expYear ? `/${expYear}` : ''}`;

    return `${expMonth}/${expYear.slice(-2)}`;
}

export function formatStoredExpDate(value) {
    const { expMonth, expYear } = normalizeExpParts(value);
    if (!expMonth || !expYear) return '-';
    return `${expMonth}/${expYear}`;
}

export function buildPaymentData(input = {}) {
    const sourceExpDate = input.expDate || `${input.expMonth || ''}${input.expYear || ''}`;
    const { expMonth, expYear } = normalizeExpParts(sourceExpDate);

    return {
        id: String(input.id || '').trim() || null,
        label: String(input.label || '').trim(),
        cardNumber: normalizeCardNumber(input.cardNumber),
        expMonth,
        expYear,
        expDate: expMonth && expYear ? `${expMonth}/${expYear.slice(-2)}` : '',
        cvc: String(input.cvc || '').replace(/\D+/g, '').slice(0, 4),
        cardholderName: String(input.cardholderName || '').trim(),
        postalCode: String(input.postalCode || '').trim(),
    };
}

export function maskCardNumber(value) {
    const digits = normalizeCardNumber(value);
    if (!digits) return '-';
    return `**** **** **** ${digits.slice(-4).padStart(4, '*')}`;
}

export function formatVccLine(vcc) {
    const label = String(vcc?.label || '').trim() || maskCardNumber(vcc?.cardNumber);
    const holder = String(vcc?.cardholderName || '').trim();

    return `${label} | ${maskCardNumber(vcc?.cardNumber)} | exp ${formatStoredExpDate(vcc?.expDate || `${vcc?.expMonth || ''}/${vcc?.expYear || ''}`)}${holder ? ` | ${holder}` : ''}`;
}

export function decorateVccEntries(entries = []) {
    return entries.map((entry) => ({
        ...entry,
        masked_card: maskCardNumber(entry.cardNumber),
        display_label: entry.label || maskCardNumber(entry.cardNumber),
    }));
}

export function normalizeTrialPaymentData(rawValue = {}) {
    const payment = buildPaymentData(rawValue);
    if (!payment.cardNumber || !payment.expMonth || !payment.expYear || !payment.cvc) {
        return null;
    }

    return {
        id: payment.id,
        label: payment.label,
        cardNumber: payment.cardNumber,
        expDate: `${payment.expMonth}${payment.expYear.slice(-2)}`,
        cvc: payment.cvc,
        cardholderName: payment.cardholderName,
        postalCode: payment.postalCode,
    };
}

export function normalizeTrialPaymentCandidates(primaryValue = null, candidateValues = []) {
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (value) => {
        const normalized = normalizeTrialPaymentData(value);
        if (!normalized) return;

        const key = [
            normalized.cardNumber,
            normalized.expDate,
            normalized.cvc,
            normalized.cardholderName,
            normalized.postalCode,
        ].join('|');

        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(normalized);
    };

    pushCandidate(primaryValue);
    for (const candidate of Array.isArray(candidateValues) ? candidateValues : []) {
        pushCandidate(candidate);
    }

    return candidates;
}
