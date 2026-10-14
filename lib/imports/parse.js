'use strict';

const path = require('node:path');
const { parse } = require('csv-parse/sync');
const readXlsxFile = require('read-excel-file/node');
const { importMaxRows } = require('../config');
const { ImportError, UNSUPPORTED_MESSAGE } = require('./fields');

const RATE_HEADER_MATCH = ['Origin Port', 'Destination Port/Via Port', 'Carrier'];
const SAILING_HEADER_MATCH = ['Carrier', 'Departure Port', 'Departure'];

function extensionOf(filename) {
    return path.extname(String(filename || '')).toLowerCase();
}

function assertSupported(filename) {
    const extension = extensionOf(filename);
    if (extension !== '.csv' && extension !== '.xlsx') {
        throw new ImportError(400, 'unsupported_type', UNSUPPORTED_MESSAGE);
    }
    return extension;
}

function assertDecodable(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return;
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new ImportError(400, 'decode_failed', 'The file could not be decoded as text.');
    }
}

function padRows(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return rows.map(row => {
        const next = row.map(cell => (cell === '' ? null : cell));
        while (next.length < width) next.push(null);
        return next;
    });
}

function parseCsv(buffer) {
    assertDecodable(buffer);
    let rows;
    try {
        rows = parse(buffer, {
            bom: true,
            relax_column_count: true,
            skip_empty_lines: true
        });
    } catch {
        throw new ImportError(400, 'parse_failed', 'The CSV file could not be read.');
    }
    if (!Array.isArray(rows) || !rows.length) {
        throw new ImportError(400, 'empty_file', 'The file has no rows.');
    }
    return padRows(rows);
}

async function parseXlsx(buffer) {
    let sheets;
    try {
        sheets = await readXlsxFile(buffer, { trim: false });
    } catch {
        throw new ImportError(400, 'parse_failed', 'The Excel file could not be read.');
    }
    if (!Array.isArray(sheets) || !sheets.length) {
        throw new ImportError(400, 'empty_file', 'The file has no sheets.');
    }
    return sheets.map(sheet => ({
        name: String(sheet.sheet),
        rows: padRows(sheet.data || [])
    }));
}

function headerNames(rows) {
    const header = rows[0] || [];
    return header.map(cell => (cell == null ? '' : String(cell).trim())).filter(Boolean);
}

function isDataSheet(rows) {
    const header = rows[0] || [];
    const filled = header.filter(cell => cell != null && String(cell).trim() !== '');
    return filled.length >= 3;
}

function matchesDataset(dataset, rows) {
    const names = new Set(headerNames(rows));
    const required = dataset === 'sailings' ? SAILING_HEADER_MATCH : RATE_HEADER_MATCH;
    return required.every(name => names.has(name));
}

function describeSheets(dataset, sheets) {
    const described = sheets.map(sheet => {
        const data = isDataSheet(sheet.rows);
        return {
            name: sheet.name,
            data,
            ignored: !data,
            matches: data && matchesDataset(dataset, sheet.rows),
            dataRows: Math.max(0, sheet.rows.length - 1)
        };
    });
    const matched = described.filter(sheet => sheet.matches);
    return {
        sheets: described,
        suggestedSheet: matched.length === 1 ? matched[0].name : null,
        requireSheetChoice: matched.length !== 1
    };
}

async function parseUpload(buffer, filename, dataset) {
    const extension = assertSupported(filename);
    const parsed = extension === '.csv'
        ? [{ name: 'CSV', rows: parseCsv(buffer) }]
        : await parseXlsx(buffer);
    const description = describeSheets(dataset, parsed);
    const over = description.sheets.find(sheet => sheet.data && sheet.dataRows > importMaxRows());
    if (over && description.sheets.filter(sheet => sheet.data).every(sheet => sheet.dataRows > importMaxRows())) {
        throw new ImportError(413, 'too_many_rows', `The file has more than ${importMaxRows()} data rows.`);
    }
    return { parsed, ...description };
}

function sheetByName(parsed, name) {
    return parsed.find(sheet => sheet.name === name) || null;
}

function headerColumns(rows) {
    const header = rows[0] || [];
    const columns = [];
    const seen = new Set();
    header.forEach((cell, index) => {
        if (cell == null) return;
        const name = String(cell).trim();
        if (!name) return;
        if (seen.has(name)) {
            throw new ImportError(400, 'duplicate_header', `The header "${name}" appears more than once.`);
        }
        seen.add(name);
        columns.push({ name, index });
    });
    if (!columns.length) throw new ImportError(400, 'no_headers', 'The sheet has no header row.');
    return columns;
}

module.exports = {
    extensionOf,
    assertSupported,
    parseUpload,
    sheetByName,
    headerColumns,
    isDataSheet,
    UNSUPPORTED_MESSAGE
};
