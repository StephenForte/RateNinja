const dollars = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    roundingMode: 'halfExpand'
});

function asNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
}

export function formatDollars(value, fallback = '') {
    const number = asNumber(value);
    return number == null ? fallback : dollars.format(number);
}
