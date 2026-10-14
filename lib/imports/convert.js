'use strict';

const { parseDateOnly } = require('../domain');
const { validateRate, validateSailing } = require('../record-validation');
const {
    ImportError,
    PRICE_TARGETS,
    NOTE_APPEND,
    FORBIDDEN_TARGETS,
    targetIds,
    targetsFor
} = require('./fields');

const DATE_SAMPLE_HEADERS = /date|expiry|effective|^departure$|^arrival$/i;

function excelSerialToIso(serial) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(serial)) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
}

function dateFromUtc(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
}

function isoFromParts(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return parseDateOnly(iso) ? iso : null;
}

function monthNameWithoutYear(value) {
    return /^[A-Za-z]{3,9}\.?\s+\d{1,2}$/.test(value) || /^\d{1,2}\s+[A-Za-z]{3,9}\.?$/.test(value);
}

function cents(value) {
    return Math.round(value * 100) / 100;
}

function convertPrice(value) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { ok: false, message: 'Must be a finite non-negative number, or empty.' };
        return { ok: true, value: cents(value) };
    }
    if (typeof value !== 'string') return { ok: false, message: 'The price is not USD.' };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: null };
    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1).trim() : trimmed;
    if (!/^\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\$?\d+(?:\.\d+)?$/.test(unsigned)) {
        return { ok: false, message: 'The price is not USD.' };
    }
    const numeric = Number(unsigned.replace(/[$,]/g, ''));
    if (!Number.isFinite(numeric)) return { ok: false, message: 'The price is not USD.' };
    if (negative) return { ok: false, message: 'Must be a finite non-negative number, or empty.' };
    return { ok: true, value: cents(numeric) };
}

function convertDate(value, dateOrder) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (value instanceof Date) {
        const iso = dateFromUtc(value);
        if (!iso) return { ok: false, message: 'Must be a valid YYYY-MM-DD date.' };
        return { ok: true, value: iso };
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { ok: true, value: excelSerialToIso(value) };
    }
    if (typeof value !== 'string') return { ok: false, message: 'Must be a valid YYYY-MM-DD date.' };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: null };
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return parseDateOnly(trimmed)
            ? { ok: true, value: trimmed }
            : { ok: false, message: 'Must be a valid YYYY-MM-DD date.' };
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return { ok: true, value: excelSerialToIso(Number(trimmed)) };
    }
    const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
        if (dateOrder !== 'mdy' && dateOrder !== 'dmy') {
            return {
                ok: false,
                ambiguous: true,
                message: 'This date is ambiguous. Choose month/day order before continuing.'
            };
        }
        const month = Number(dateOrder === 'mdy' ? slash[1] : slash[2]);
        const day = Number(dateOrder === 'mdy' ? slash[2] : slash[1]);
        const iso = isoFromParts(Number(slash[3]), month, day);
        if (!iso) return { ok: false, message: 'Must be a valid YYYY-MM-DD date.' };
        return { ok: true, value: iso };
    }
    if (monthNameWithoutYear(trimmed)) {
        return {
            ok: false,
            ambiguous: true,
            message: 'This date has no year. A year is not guessed. Exclude the row or correct the source.'
        };
    }
    return { ok: false, message: 'Must be a valid YYYY-MM-DD date.' };
}

function convertText(value) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) };
    if (value instanceof Date) {
        const iso = dateFromUtc(value);
        return iso ? { ok: true, value: iso } : { ok: false, message: 'Must be text.' };
    }
    if (typeof value !== 'string') return { ok: false, message: 'Must be text.' };
    const trimmed = value.trim();
    return { ok: true, value: trimmed || null };
}

function cellByHeader(row, columns, source) {
    const column = columns.find(item => item.name === source);
    if (!column) return null;
    const value = column.index < row.length ? row[column.index] : null;
    return value === undefined ? null : value;
}

function normalizeMapping(dataset, columns, mapping) {
    if (!Array.isArray(mapping)) {
        throw new ImportError(400, 'invalid_mapping', 'Mapping must be a list of header-to-field pairs.');
    }
    const names = new Set(columns.map(column => column.name));
    const allowed = targetIds(dataset);
    const seenSources = new Set();
    const seenTargets = new Set();
    const pairs = [];
    for (const entry of mapping) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ImportError(400, 'invalid_mapping', 'Each mapping needs a source header and a target field.');
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
            throw new ImportError(400, 'invalid_mapping', 'A mapping cannot supply a cell value.');
        }
        const source = typeof entry.source === 'string' ? entry.source : '';
        if (!source || !names.has(source) || seenSources.has(source)) {
            throw new ImportError(400, 'invalid_mapping', 'Each source header can be mapped once, and only to a header in this sheet.');
        }
        seenSources.add(source);
        const target = entry.target == null || entry.target === '' ? null : entry.target;
        if (target != null) {
            if (typeof target !== 'string' || FORBIDDEN_TARGETS.has(target) || !allowed.has(target)) {
                throw new ImportError(400, 'invalid_mapping', 'A mapping can only target a rate or sailing field.');
            }
            if (seenTargets.has(target)) {
                throw new ImportError(400, 'invalid_mapping', 'Each field can be chosen once.');
            }
            seenTargets.add(target);
        }
        pairs.push({ source, target });
    }
    return pairs;
}

function unmappedRequired(dataset, pairs) {
    const chosen = new Set(pairs.filter(pair => pair.target).map(pair => pair.target));
    const missing = targetsFor(dataset).filter(target => target.required && !chosen.has(target.id)).map(target => target.id);
    if (dataset === 'rates' && !PRICE_TARGETS.some(id => chosen.has(id))) missing.push('rate20D');
    return missing;
}

function appendNotes(row, columns, pairs) {
    const notesPair = pairs.find(pair => pair.target === 'notes1');
    const parts = [];
    if (notesPair) {
        const text = convertText(cellByHeader(row, columns, notesPair.source));
        if (text.ok && text.value) parts.push(text.value);
    }
    for (const header of NOTE_APPEND) {
        const pair = pairs.find(item => item.source === header);
        if (pair && pair.target) continue;
        if (!columns.some(column => column.name === header)) continue;
        const text = convertText(cellByHeader(row, columns, header));
        if (text.ok && text.value) parts.push(`${header}: ${text.value}`);
    }
    return parts.length ? parts.join('\n') : null;
}

function convertRow(dataset, row, columns, pairs, dateOrder) {
    const errors = [];
    const input = {};
    let ambiguous = false;
    for (const target of targetsFor(dataset)) {
        const pair = pairs.find(item => item.target === target.id);
        if (!pair) {
            input[target.id] = null;
            continue;
        }
        const raw = cellByHeader(row, columns, pair.source);
        let converted;
        if (target.kind === 'price') converted = convertPrice(raw);
        else if (target.kind === 'date') converted = convertDate(raw, dateOrder);
        else converted = convertText(raw);
        if (!converted.ok) {
            if (converted.ambiguous) ambiguous = true;
            errors.push({ field: target.id, message: converted.message });
            input[target.id] = null;
            continue;
        }
        input[target.id] = converted.value;
    }
    if (dataset === 'rates') input.notes1 = appendNotes(row, columns, pairs);
    input.rateView = null;
    const validated = dataset === 'rates' ? validateRate(input) : validateSailing(input);
    if (!validated.ok) {
        for (const error of validated.errors) {
            if (!errors.some(item => item.field === error.field)) errors.push(error);
        }
    }
    return {
        ok: errors.length === 0 && validated.ok,
        ambiguous,
        errors,
        value: validated.ok ? validated.value : null
    };
}

function projectRows({ dataset, columns, rows, mapping, dateOrder, excludedRows }) {
    const pairs = normalizeMapping(dataset, columns, mapping);
    const missing = unmappedRequired(dataset, pairs);
    const excluded = new Set((excludedRows || []).map(row => Number(row)));
    const results = [];
    let needsDateChoice = false;
    for (let index = 1; index < rows.length; index += 1) {
        const sheetRow = index + 1;
        const converted = convertRow(dataset, rows[index], columns, pairs, dateOrder);
        if (converted.ambiguous) needsDateChoice = true;
        const excludedRow = excluded.has(sheetRow);
        results.push({
            sheetRow,
            ok: converted.ok,
            excluded: excludedRow,
            errors: converted.errors,
            value: converted.value
        });
    }
    const pending = results.filter(row => !row.ok && !row.excluded);
    const accepted = results.filter(row => row.ok && !row.excluded);
    return {
        pairs,
        unmappedRequired: missing,
        blocked: missing.length > 0,
        needsDateChoice,
        accepted,
        rejected: results.filter(row => !row.ok),
        pending,
        results
    };
}

function sampleCell(header, value) {
    if (value === undefined || value === null || value === '') return null;
    if (!DATE_SAMPLE_HEADERS.test(header)) {
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return value;
        if (value instanceof Date) return dateFromUtc(value);
        return String(value);
    }
    if (value instanceof Date) return dateFromUtc(value);
    if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToIso(value);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        if (/^\d+(\.\d+)?$/.test(trimmed)) return excelSerialToIso(Number(trimmed));
        return value;
    }
    return String(value);
}

function buildSample({ dataset, columns, rows, maxRows, maxChars }) {
    const headers = columns.map(column => column.name);
    const dataRows = [];
    for (let index = 1; index < rows.length && dataRows.length < maxRows; index += 1) {
        dataRows.push(headers.map(header => sampleCell(header, cellByHeader(rows[index], columns, header))));
    }
    while (dataRows.length && JSON.stringify({ dataset, headers, rows: dataRows }).length > maxChars) {
        dataRows.pop();
    }
    return { dataset, headers, rows: dataRows };
}

module.exports = {
    excelSerialToIso,
    dateFromUtc,
    convertPrice,
    convertDate,
    convertText,
    cellByHeader,
    normalizeMapping,
    projectRows,
    buildSample,
    sampleCell
};
