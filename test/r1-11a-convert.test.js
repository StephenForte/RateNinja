'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseUpload, headerColumns } = require('../lib/imports/parse');
const {
    excelSerialToIso,
    dateFromUtc,
    convertPrice,
    projectRows,
    cellByHeader
} = require('../lib/imports/convert');
const { validateSuggestion } = require('../lib/imports/schema');
const { RATE_MAPPING } = require('./helpers/r1-11a');

const FIXTURES = path.join(__dirname, 'fixtures', 'imports');

function loadPriceText(name) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rates', 'browse.js'), 'utf8');
    const match = source.match(new RegExp(`function ${name}\\(value\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(match, name);
    return new Function('value', 'formatNumber', 'Number', 'Intl', match[1]);
}

describe('r1-11a conversion', () => {
    it('floors an Excel serial onto the UTC calendar date and keeps cents', () => {
        const serial = 46083.7083333333357587;
        assert.equal(excelSerialToIso(serial), '2026-03-02');
        const rounded = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
        assert.equal(new Date(rounded).toISOString().slice(0, 10), '2026-03-03');
        assert.equal(dateFromUtc(new Date('2026-03-02T17:00:00.000Z')), '2026-03-02');
        assert.equal(convertPrice(1100.5).value, 1100.5);
        assert.equal(convertPrice(2100.2500000000004).value, 2100.25);
        assert.equal(convertPrice(null).value, null);
        assert.equal(convertPrice('').value, null);
        assert.equal(convertPrice('EUR 900').ok, false);
        assert.match(convertPrice('EUR 900').message, /not USD/);
        assert.equal(convertPrice('$1,100.50').value, 1100.5);
    });

    it('reads fixture cells by header, including under a moved column', async () => {
        const buffer = fs.readFileSync(path.join(FIXTURES, 'rates.xlsx'));
        const parsed = await parseUpload(buffer, 'rates.xlsx', 'rates');
        const summary = parsed.sheets.find(sheet => sheet.name === 'Summary');
        const rates = parsed.parsed.find(sheet => sheet.name === 'Fixture_Rates');
        assert.equal(summary.ignored, true);
        assert.equal(summary.matches, false);
        assert.equal(parsed.suggestedSheet, 'Fixture_Rates');
        const columns = headerColumns(rates.rows);
        const projected = projectRows({
            dataset: 'rates',
            columns,
            rows: rates.rows,
            mapping: RATE_MAPPING,
            dateOrder: null,
            excludedRows: []
        });
        assert.equal(projected.accepted.length, 5);
        assert.equal(projected.rejected.length, 0);
        const [first, blank, padded, cents, twenty] = projected.accepted.map(row => row.value);
        assert.equal(first.rateEffectiveDate, '2026-03-02');
        assert.equal(first.rateExpirationDate, '2026-03-20');
        assert.equal(first.rate20D, 1100.5);
        assert.equal(first.rate40D, 2100.25);
        assert.equal(first.rate40HC, 2200);
        assert.equal(first.contractNumber, 'FX-1001');
        assert.equal(first.originPort, 'Fixture Harbor');
        assert.match(first.notes1, /Gate A, pier "north"/);
        assert.match(first.notes1, /Notes 2: Sample note two/);
        assert.equal(first.notes1.includes('Contract Number'), false);
        assert.equal(blank.rate20D, null);
        assert.equal(blank.rate40D, 1800.4);
        assert.equal(blank.rateEffectiveDate, '2026-04-01');
        assert.equal(padded.originPort, 'Padded Port');
        assert.equal(padded.rate20D, 999.99);
        assert.equal(padded.rate40HC, null);
        assert.equal(cents.rate40D, 1400.1);
        assert.equal(cents.rate40HC, 1450.55);
        assert.match(cents.notes1, /Notes 3: Only the third note is set/);
        assert.equal(twenty.rate20D, 750.5);
        assert.equal(twenty.rate40D, null);
        assert.equal(twenty.rate40HC, null);
        assert.equal(twenty.rateEffectiveDate, '2026-07-07');

        const swapped = {
            headers: ['Carrier', 'Origin Port', '20D Rate'],
            row: ['Fixture Line', 'Moved Harbor', 42.5]
        };
        const swappedColumns = swapped.headers.map((name, index) => ({ name, index }));
        assert.equal(cellByHeader(swapped.row, swappedColumns, 'Origin Port'), 'Moved Harbor');
        assert.equal(cellByHeader(swapped.row, swappedColumns, '20D Rate'), 42.5);
    });

    it('discards a mapping response that is not header-to-field pairs', () => {
        const headers = RATE_MAPPING.map(pair => pair.source);
        const malicious = {
            dataset: 'rates',
            mappings: headers.map(source => ({
                source,
                target: source === 'Origin Port' ? 'owner_company_id' : null,
                confidence: 'high',
                reason: 'Filled it in.',
                value: 'Invented Port'
            }))
        };
        assert.equal(validateSuggestion(malicious, 'rates', headers), null);
        const unknown = {
            dataset: 'rates',
            mappings: headers.map(source => ({
                source,
                target: source === '20D Rate' ? 'notAField' : null,
                confidence: 'high',
                reason: 'Guessed.'
            }))
        };
        assert.equal(validateSuggestion(unknown, 'rates', headers), null);
    });

    it('shows a null browse price as an em dash', () => {
        const formatNumber = loadPriceText('formatNumber');
        const priceText = loadPriceText('priceText');
        const format = value => formatNumber(value, format, Number, Intl);
        assert.equal(format(null), '—');
        assert.equal(format(undefined), '—');
        assert.equal(format(''), '—');
        assert.equal(format(0), '0');
        assert.equal(priceText(null, format, Number, Intl), '—');
        assert.equal(priceText(1100.5, format, Number, Intl), '$1,101');
    });
});
