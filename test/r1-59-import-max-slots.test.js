'use strict';

const { crc32 } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { RATE_TARGETS } = require('../lib/imports/fields');
const { mappingPrompt } = require('../lib/imports/schema');
const { projectRows } = require('../lib/imports/convert');
const { RATE_FIELDS } = require('../lib/record-validation');
const { startApp } = require('./helpers/app');
const { insertRate } = require('./helpers/r1-12');
const { ratePatch } = require('./helpers/r1-08');

const MESSAGE = 'Must be a whole number of 0 or more.';
const RATE_FIELD_LIST = [
    'rateType',
    'originPort',
    'destinationPort',
    'inlandDeliveryLocation',
    'commodityType',
    'carrier',
    'contractOwner',
    'contractNumber',
    'rate20D',
    'rate40D',
    'rate40HC',
    'rateEffectiveDate',
    'rateExpirationDate',
    'notes1',
    'rateView'
];

const BASE_HEADERS = [
    'Rate Type',
    'Origin Port',
    'Destination Port/Via Port',
    'Carrier',
    '20D Rate',
    'Effective Date',
    'Expiry Date'
];

function readJson(response) {
    return response.text().then(text => {
        let body = null;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = { error: text };
            }
        }
        return { status: response.status, body, text };
    });
}

function csvField(value) {
    const text = value == null ? '' : String(value);
    if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function csvFile(headers, rows) {
    return [headers, ...rows].map(row => row.map(csvField).join(',')).join('\n');
}

function rateMapping(headers, slotsHeader) {
    const targets = {
        'Rate Type': 'rateType',
        'Origin Port': 'originPort',
        'Destination Port/Via Port': 'destinationPort',
        Carrier: 'carrier',
        '20D Rate': 'rate20D',
        'Effective Date': 'rateEffectiveDate',
        'Expiry Date': 'rateExpirationDate'
    };
    if (slotsHeader) targets[slotsHeader] = 'maxSlotsAllowed';
    return headers.map(header => ({ source: header, target: targets[header] || null }));
}

function rateRow(origin, slots) {
    const row = ['FAK', origin, 'North Quay', 'Slot Line', '100', '2026-06-01', '2026-06-30'];
    if (slots !== undefined) row.push(slots);
    return row;
}

async function uploadBuffer(app, filename, body) {
    return readJson(await app.request('/api/admin/imports/uploads', {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-import-filename': filename,
            'x-import-dataset': 'rates'
        },
        body
    }));
}

async function commitImport(app, jobId, sheetName, mapping, { excludedRows = [], submissionId }) {
    const validated = await readJson(await app.request(`/api/admin/imports/${jobId}/validate`, {
        method: 'POST',
        body: JSON.stringify({
            companyId: app.company.id,
            sheetName,
            mapping,
            dateOrder: null,
            excludedRows
        })
    }));
    const committed = await readJson(await app.request(`/api/admin/imports/${jobId}/commit`, {
        method: 'POST',
        body: JSON.stringify({
            companyId: app.company.id,
            sheetName,
            mapping,
            dateOrder: null,
            excludedRows,
            submissionId,
            acknowledgeAppend: true
        })
    }));
    return { validated, committed };
}

function slotsFor(db, origin) {
    const row = db.prepare(`SELECT max_slots_allowed AS slots FROM rates WHERE origin_port = ?`).get(origin);
    assert.ok(row, origin);
    return row.slots;
}

function assertTriggerValue(value) {
    assert.equal(typeof value, 'number');
    assert.equal(Number.isInteger(value), true);
    assert.ok(value >= 0 && value <= 5, `trigger value ${value}`);
}

describe('r1-59 import max slots', { concurrency: 1 }, () => {
    let app;

    before(async () => {
        app = await startApp({ companyName: 'Slot Importer', username: 'slot-importer' });
    });

    after(async () => {
        if (app) await app.close();
    });

    it('stores supplied whole numbers and leaves a blank cell to the trigger', async () => {
        const headers = [...BASE_HEADERS, 'Max Slots Allowed'];
        const rows = [
            rateRow('Slot Three', '3'),
            rateRow('Slot Zero', '0'),
            rateRow('Slot Blank', ''),
            rateRow('Slot Four', ' 4 '),
            rateRow('Slot Integral', '3.0')
        ];
        for (let index = 1; index <= 60; index += 1) {
            rows.push(rateRow(`Blank-${String(index).padStart(2, '0')}`, ''));
        }
        const mapping = rateMapping(headers, 'Max Slots Allowed');
        const uploaded = await uploadBuffer(app, 'slots.csv', Buffer.from(csvFile(headers, rows)));
        assert.equal(uploaded.status, 201, uploaded.text);
        const selected = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'CSV', companyId: app.company.id })
        }));
        assert.equal(selected.status, 200, selected.text);
        const ids = selected.body.targets.map(target => target.id);
        assert.equal(ids[ids.indexOf('rate40HC') + 1], 'maxSlotsAllowed');
        const { validated, committed } = await commitImport(app, uploaded.body.jobId, 'CSV', mapping, {
            submissionId: 'r159-supplied'
        });
        assert.equal(validated.status, 200, validated.text);
        assert.equal(validated.body.rejectedCount, 0, JSON.stringify(validated.body.errors));
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.acceptedCount, rows.length);
        assert.equal(slotsFor(app.db, 'Slot Three'), 3);
        assert.equal(slotsFor(app.db, 'Slot Zero'), 0);
        assertTriggerValue(slotsFor(app.db, 'Slot Blank'));
        assert.equal(slotsFor(app.db, 'Slot Four'), 4);
        assert.equal(slotsFor(app.db, 'Slot Integral'), 3);
        const blanks = app.db.prepare(`
            SELECT max_slots_allowed AS slots FROM rates WHERE origin_port LIKE 'Blank-%' ORDER BY origin_port
        `).all().map(row => row.slots);
        assert.equal(blanks.length, 60);
        for (const value of blanks) assertTriggerValue(value);
        assert.ok(new Set(blanks).size > 1);
        assert.equal(blanks.every(value => value === 0), false);
    });

    it('stores a numeric xlsx cell', async () => {
        const headers = [...BASE_HEADERS, 'Max Slots Allowed'];
        const workbook = xlsxBuffer([{
            name: 'Rates',
            rows: [
                headers.map(textCell),
                [textCell('FAK'), textCell('Numeric Two'), textCell('North Quay'), textCell('Slot Line'), numberCell(100), textCell('2026-06-01'), textCell('2026-06-30'), numberCell(2)]
            ]
        }]);
        const mapping = rateMapping(headers, 'Max Slots Allowed');
        const uploaded = await uploadBuffer(app, 'slots.xlsx', workbook);
        assert.equal(uploaded.status, 201, uploaded.text);
        await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'Rates', companyId: app.company.id })
        }));
        const { committed } = await commitImport(app, uploaded.body.jobId, 'Rates', mapping, {
            submissionId: 'r159-xlsx'
        });
        assert.equal(committed.status, 200, committed.text);
        assert.equal(slotsFor(app.db, 'Numeric Two'), 2);
    });

    it('reports a bad cell on that row and still imports the other rows', async () => {
        const headers = [...BASE_HEADERS, 'Max Slots Allowed'];
        const rows = [
            rateRow('Kept Harbor', '7'),
            rateRow('Bad Negative', '-1'),
            rateRow('Bad Fraction', '2.5'),
            rateRow('Bad Text', 'lots'),
            rateRow('Bad Scientific', '1e2')
        ];
        const mapping = rateMapping(headers, 'Max Slots Allowed');
        const uploaded = await uploadBuffer(app, 'slots-bad.csv', Buffer.from(csvFile(headers, rows)));
        assert.equal(uploaded.status, 201, uploaded.text);
        await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'CSV', companyId: app.company.id })
        }));
        const open = await commitImport(app, uploaded.body.jobId, 'CSV', mapping, {
            submissionId: 'r159-bad-open'
        });
        assert.equal(open.validated.status, 200, open.validated.text);
        assert.equal(open.validated.body.acceptedCount, 1);
        assert.equal(open.validated.body.rejectedCount, 4);
        const slotErrors = open.validated.body.errors.filter(error => error.field === 'maxSlotsAllowed');
        assert.deepEqual(slotErrors.map(error => error.row), [3, 4, 5, 6]);
        assert.deepEqual(slotErrors.map(error => error.message), [MESSAGE, MESSAGE, MESSAGE, MESSAGE]);
        assert.equal(open.committed.status, 409, open.committed.text);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE origin_port = 'Kept Harbor'`).get().count, 0);
        const saved = await commitImport(app, uploaded.body.jobId, 'CSV', mapping, {
            excludedRows: [3, 4, 5, 6],
            submissionId: 'r159-bad-kept'
        });
        assert.equal(saved.committed.status, 200, saved.committed.text);
        assert.equal(saved.committed.body.acceptedCount, 1);
        assert.equal(slotsFor(app.db, 'Kept Harbor'), 7);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE origin_port LIKE 'Bad %'`).get().count, 0);
    });

    it('draws more than one trigger value when the column is absent', async () => {
        const rows = [];
        for (let index = 1; index <= 62; index += 1) {
            rows.push(rateRow(`Miss-${String(index).padStart(2, '0')}`));
        }
        const mapping = rateMapping(BASE_HEADERS, null);
        const uploaded = await uploadBuffer(app, 'slots-missing.csv', Buffer.from(csvFile(BASE_HEADERS, rows)));
        assert.equal(uploaded.status, 201, uploaded.text);
        await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'CSV', companyId: app.company.id })
        }));
        const { committed } = await commitImport(app, uploaded.body.jobId, 'CSV', mapping, {
            submissionId: 'r159-missing'
        });
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.acceptedCount, 62);
        const values = app.db.prepare(`
            SELECT max_slots_allowed AS slots FROM rates WHERE origin_port LIKE 'Miss-%'
        `).all().map(row => row.slots);
        assert.equal(values.length, 62);
        for (const value of values) assertTriggerValue(value);
        assert.ok(new Set(values).size > 1);
        assert.equal(values.every(value => value === 0), false);
    });

    it('lists maxSlotsAllowed after rate40HC and keeps it off the rate edit fields', () => {
        const ids = RATE_TARGETS.map(target => target.id);
        const target = RATE_TARGETS[ids.indexOf('rate40HC') + 1];
        assert.equal(target.id, 'maxSlotsAllowed');
        assert.equal(target.label, 'Max slots allowed');
        assert.equal(target.required, false);
        assert.equal(target.kind, 'integer');
        const prompt = mappingPrompt('{}');
        assert.match(prompt, /rate40HC, maxSlotsAllowed, rateEffectiveDate/);
        assert.deepEqual(RATE_FIELDS, RATE_FIELD_LIST);
        const columns = ['Origin Port', 'Max Slots Allowed', '20D Rate', 'Carrier', 'Destination Port/Via Port', 'Effective Date', 'Expiry Date']
            .map((name, index) => ({ name, index }));
        const projected = projectRows({
            dataset: 'rates',
            columns,
            rows: [
                columns.map(column => column.name),
                ['Harbor', '', 100, 'Slot Line', 'North Quay', '2026-06-01', '2026-06-30'],
                ['Harbor', '0', 100, 'Slot Line', 'North Quay', '2026-06-01', '2026-06-30']
            ],
            mapping: columns.map(column => ({
                source: column.name,
                target: {
                    'Origin Port': 'originPort',
                    'Max Slots Allowed': 'maxSlotsAllowed',
                    '20D Rate': 'rate20D',
                    Carrier: 'carrier',
                    'Destination Port/Via Port': 'destinationPort',
                    'Effective Date': 'rateEffectiveDate',
                    'Expiry Date': 'rateExpirationDate'
                }[column.name]
            })),
            dateOrder: null,
            excludedRows: []
        });
        assert.equal(projected.accepted.length, 2);
        assert.equal(Object.hasOwn(projected.accepted[0].value, 'maxSlotsAllowed'), false);
        assert.equal(projected.accepted[0].maxSlotsAllowed, null);
        assert.equal(projected.accepted[1].maxSlotsAllowed, 0);
    });

    it('puts Max Slots Allowed after 40HC Rate in the template, with sample 3', () => {
        const text = fs.readFileSync(path.join(__dirname, '..', 'public', 'templates', 'rates.csv'), 'utf8').trim();
        const [header, sample] = text.split(/\r?\n/);
        const headers = header.split(',');
        const values = sample.split(',');
        const index = headers.indexOf('Max Slots Allowed');
        assert.equal(headers[index - 1], '40HC Rate');
        assert.equal(headers[index + 1], 'Validity');
        assert.equal(values[index], '3');
    });

    it('keeps an existing max when an edit omits it, and stores one when the edit sends it', async () => {
        insertRate(app.db, {
            id: 'slot-edit',
            origin: 'Edit Harbor',
            destination: 'LAX',
            carrier: 'MSC',
            d20: 1000,
            d40: 1800,
            d40hc: 1900,
            owner: app.company.id,
            expiration: '2026-12-01'
        });
        app.db.prepare(`UPDATE rates SET max_slots_allowed = 4 WHERE id = 'slot-edit'`).run();
        const session = { cookie: app.cookie, csrf: app.csrf };
        const saved = await readJson(await app.request('/api/admin/data/rates/slot-edit', {
            method: 'PATCH',
            headers: {
                'content-type': 'application/json',
                cookie: session.cookie,
                'x-csrf-token': session.csrf
            },
            body: JSON.stringify(ratePatch(app.company.id, 1, { carrier: 'EDITED SLOTS' }))
        }));
        assert.equal(saved.status, 200, saved.text);
        const row = app.db.prepare(`SELECT carrier, max_slots_allowed, row_version FROM rates WHERE id = 'slot-edit'`).get();
        assert.equal(row.carrier, 'EDITED SLOTS');
        assert.equal(row.max_slots_allowed, 4);
        const edited = await readJson(await app.request('/api/admin/data/rates/slot-edit', {
            method: 'PATCH',
            headers: {
                'content-type': 'application/json',
                cookie: session.cookie,
                'x-csrf-token': session.csrf
            },
            body: JSON.stringify(ratePatch(app.company.id, row.row_version, { maxSlotsAllowed: 9 }))
        }));
        assert.equal(edited.status, 200, edited.text);
        const stored = app.db.prepare(`SELECT max_slots_allowed, row_version FROM rates WHERE id = 'slot-edit'`).get();
        assert.equal(stored.max_slots_allowed, 9);
        assert.equal(stored.row_version, row.row_version + 1);
        assert.deepEqual(RATE_FIELDS, RATE_FIELD_LIST);
    });
});

function textCell(value) {
    return { kind: 's', v: value };
}

function numberCell(value) {
    return { kind: 'n', v: value };
}

function colName(index) {
    let n = index;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sheetXml(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
    const body = rows.map((row, rowIndex) => {
        const cells = row.map((cell, column) => {
            const ref = `${colName(column + 1)}${rowIndex + 1}`;
            if (cell.kind === 's') return `<c r="${ref}" t="str"><v>${escapeXml(cell.v)}</v></c>`;
            return `<c r="${ref}"><v>${cell.v}</v></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colName(width)}${rows.length}"/><sheetData>${body}</sheetData></worksheet>`;
}

function xlsxBuffer(sheets) {
    const files = [
        {
            name: '[Content_Types].xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`
        },
        {
            name: '_rels/.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
        },
        {
            name: 'xl/workbook.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
        },
        {
            name: 'xl/styles.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="12"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
        }
    ];
    sheets.forEach((sheet, index) => {
        files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet.rows) });
    });
    return zipStored(files);
}

function u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return buffer;
}

function u32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0);
    return buffer;
}

function zipStored(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name);
        const data = Buffer.from(file.data);
        const crc = crc32(data) >>> 0;
        const local = Buffer.concat([
            u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x0021),
            u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
        ]);
        locals.push(local);
        centrals.push(Buffer.concat([
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x0021),
            u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
            u32(0), u32(offset), name
        ]));
        offset += local.length;
    }
    const central = Buffer.concat(centrals);
    const end = Buffer.concat([
        u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)
    ]);
    return Buffer.concat([...locals, central, end]);
}
