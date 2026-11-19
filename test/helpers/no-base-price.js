'use strict';

// A customer-facing payload leaks an owner's base price when a number equals
// that price, or a string contains it as its own number. Letters and digits
// always glue, so 18123, 81234, and A8123B are different tokens. "-" and "_"
// glue only when the whole token is an id: a UUID, 8 or more hex characters,
// or prefix-hex (r101- plus 8 or more hex characters). Strings under an id
// key (id, *Id, *_id) that have that shape skip the standalone test only;
// a number under an id key still leaks. en-US grouped spellings (8,123,
// $8,123, $8,123.00) count: the booking, browse, and managed-agent screens
// format prices that way. API JSON itself does not insert separators.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{8,}$/i;
const PREFIX_HEX = /^[a-z][a-z0-9]*-[0-9a-f]{8,}$/i;

function isIdKey(key) {
    return key === 'id' || key.endsWith('Id') || key.endsWith('_id');
}

function isIdShape(value) {
    return UUID.test(value) || HEX.test(value) || PREFIX_HEX.test(value);
}

function groupedInteger(base) {
    if (!Number.isInteger(base) || base < 1000) return null;
    return String(base).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function idTokenAround(text, index, length) {
    let start = index;
    let end = index + length;
    while (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) start -= 1;
    while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end += 1;
    return isIdShape(text.slice(start, end));
}

function glued(text, index, length) {
    const before = index > 0 ? text[index - 1] : '';
    const afterIndex = index + length;
    const after = afterIndex < text.length ? text[afterIndex] : '';
    const sticks = ch => {
        if (!ch) return false;
        if (/[A-Za-z0-9]/.test(ch)) return true;
        if (ch === '-' || ch === '_') return idTokenAround(text, index, length);
        return false;
    };
    return sticks(before) || sticks(after);
}

function groupedContinues(text, index, length) {
    const after = index + length;
    if (text[after] === ',' && /^\d{3}/.test(text.slice(after + 1))) return true;
    if (index > 0 && text[index - 1] === ',' && /\d/.test(text[index - 2] || '')) return true;
    return false;
}

function hasToken(text, token, grouped) {
    let from = 0;
    while (from < text.length) {
        const at = text.indexOf(token, from);
        if (at < 0) return false;
        const continues = grouped && groupedContinues(text, at, token.length);
        if (!continues && !glued(text, at, token.length)) return true;
        from = at + 1;
    }
    return false;
}

function standaloneLeak(text, base) {
    if (hasToken(text, String(base), false)) return true;
    const grouped = groupedInteger(base);
    return grouped != null && hasToken(text, grouped, true);
}

function parseContainer(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {
        return undefined;
    }
    return undefined;
}

function walk(value, base, key, seen) {
    if (typeof value === 'number') return value === base;
    if (typeof value === 'string') {
        if (key != null && isIdKey(key) && isIdShape(value)) return false;
        const parsed = parseContainer(value);
        if (parsed && walk(parsed, base, null, seen)) return true;
        return standaloneLeak(value, base);
    }
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => walk(item, base, null, seen));
    for (const [childKey, child] of Object.entries(value)) {
        if (standaloneLeak(childKey, base)) return true;
        if (walk(child, base, childKey, seen)) return true;
    }
    return false;
}

function leaksBasePrice(value, base) {
    return walk(value, base, null, new WeakSet());
}

module.exports = {
    leaksBasePrice
};
