const DEFAULT_LOCALE = 'en-US';

function instant(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

export function formatWhen(value, { locale = DEFAULT_LOCALE, timeZone } = {}) {
    const title = value == null ? '' : String(value);
    const parsed = instant(title);
    if (!title || parsed == null) return { text: '', title };
    const format = new Intl.DateTimeFormat(locale, {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone
    });
    return { text: format.format(new Date(parsed)), title };
}

export function formatDuration(startedAt, finishedAt, { now = Date.now() } = {}) {
    const start = instant(startedAt);
    const end = finishedAt == null || finishedAt === '' ? instant(now) : instant(finishedAt);
    if (start == null || end == null || end < start) return '';
    const total = Math.floor((end - start) / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}
