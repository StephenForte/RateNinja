'use strict';

// Writes the synthetic import fixtures. Values are invented. Re-running this
// script produces byte-identical files: the zip metadata uses a fixed date
// and the cell text is written from strings, not from Date or Math.random.

const { crc32 } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'imports');
const ZIP_TIME = 0;
const ZIP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

function serialText(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    const days = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
    return `${days}.7083333333333334`;
}

function text(value) {
    return { kind: 's', v: value };
}

function number(value) {
    return { kind: 'n', v: value };
}

function excelDate(iso) {
    return { kind: 'd', v: serialText(iso) };
}

function sheetXml(rows) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
    const body = rows.map((row, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cells = [];
        for (let column = 0; column < row.length; column += 1) {
            const cell = row[column];
            if (!cell) continue;
            const ref = `${colName(column + 1)}${rowNumber}`;
            if (cell.kind === 's') cells.push(`<c r="${ref}" t="str"><v>${escapeXml(cell.v)}</v></c>`);
            else if (cell.kind === 'd') cells.push(`<c r="${ref}" s="1"><v>${cell.v}</v></c>`);
            else cells.push(`<c r="${ref}"><v>${cell.v}</v></c>`);
        }
        return `<row r="${rowNumber}">${cells.join('')}</row>`;
    }).join('');
    const dimension = `A1:${colName(width)}${rows.length}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`;
}

function workbookXml(sheets) {
    const list = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list}</sheets></workbook>`;
}

function workbookRels(sheets) {
    const list = sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function contentTypes(sheets) {
    const overrides = sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="12"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

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
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(0),
            u16(ZIP_TIME),
            u16(ZIP_DATE),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(name.length),
            u16(0),
            name,
            data
        ]);
        locals.push(local);
        centrals.push(Buffer.concat([
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0),
            u16(0),
            u16(ZIP_TIME),
            u16(ZIP_DATE),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(name.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(offset),
            name
        ]));
        offset += local.length;
    }
    const central = Buffer.concat(centrals);
    const end = Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(central.length),
        u32(offset),
        u16(0)
    ]);
    return Buffer.concat([...locals, central, end]);
}

function workbookBuffer(sheets) {
    const files = [
        { name: '[Content_Types].xml', data: contentTypes(sheets) },
        { name: '_rels/.rels', data: ROOT_RELS },
        { name: 'xl/workbook.xml', data: workbookXml(sheets) },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets) },
        { name: 'xl/styles.xml', data: STYLES_XML }
    ];
    sheets.forEach((sheet, index) => {
        files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet.rows) });
    });
    return zipStored(files);
}

function csvField(value) {
    const textValue = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
    return textValue;
}

function csvBuffer(rows) {
    const lines = rows.map(row => row.map(cell => csvField(cell ? cell.v : '')).join(',')).join('\n');
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines}\n`, 'utf8')]);
}

const RATE_HEADERS = [
    'Rate Type',
    'Origin Port',
    'Destination Port/Via Port',
    'Inland Delivery Location',
    'Carrier',
    'Contract Number',
    'Contract Owner',
    '20D Rate',
    '40D rate',
    '40HC Rate',
    'Validity',
    'Effective Date',
    'Expiry Date',
    'Notes 1',
    'Notes 2',
    'Notes 3',
    'Note 4'
];

function rateRow(values) {
    return [
        text(values.rateType),
        text(values.origin),
        text(values.destination),
        values.inland ? text(values.inland) : null,
        text(values.carrier),
        values.contractNumber ? text(values.contractNumber) : null,
        text(values.contractOwner),
        values.rate20 === undefined ? null : values.rate20,
        values.rate40 === undefined ? null : values.rate40,
        values.rate40hc === undefined ? null : values.rate40hc,
        text(values.validity),
        values.effective,
        values.expiry,
        values.notes1 ? text(values.notes1) : null,
        values.notes2 ? text(values.notes2) : null,
        values.notes3 ? text(values.notes3) : null,
        values.note4 ? text(values.note4) : null
    ];
}

const RATE_ROWS = [
    rateRow({
        rateType: 'FAK Base',
        origin: 'Fixture Harbor',
        destination: 'North Quay',
        inland: 'Depot A, ZZ',
        carrier: 'Fixture Line',
        contractNumber: 'FX-1001',
        contractOwner: 'Example Owner',
        rate20: number('1100.5'),
        rate40: number('2100.25'),
        rate40hc: number('2200'),
        validity: 'Mar 2 - Mar 20',
        effective: excelDate('2026-03-02'),
        expiry: excelDate('2026-03-20'),
        notes1: 'Gate A, pier "north"',
        notes2: 'Sample note two',
        notes3: 'Sample note three',
        note4: 'Sample note four'
    }),
    rateRow({
        rateType: 'FAK Base',
        origin: 'Cedar Dock',
        destination: 'South Quay',
        carrier: 'Fixture Line',
        contractOwner: 'Example Owner',
        rate40: number('1800.4'),
        rate40hc: number('1900'),
        validity: 'Apr 1 - Apr 15',
        effective: excelDate('2026-04-01'),
        expiry: excelDate('2026-04-15'),
        notes1: 'No twenty-foot price on this row'
    }),
    rateRow({
        rateType: 'FAK Base',
        origin: '  Padded Port  ',
        destination: 'West Quay',
        inland: 'Yard B, ZZ',
        carrier: 'Fixture Line',
        contractNumber: 'FX-1002',
        contractOwner: 'Example Owner',
        rate20: number('999.99'),
        rate40: number('1500'),
        validity: 'May 4 - May 18',
        effective: excelDate('2026-05-04'),
        expiry: excelDate('2026-05-18'),
        notes1: 'Origin has surrounding spaces'
    }),
    rateRow({
        rateType: 'FAK Base',
        origin: 'East Quay',
        destination: 'North Quay',
        carrier: 'Fixture Line',
        contractOwner: 'Second Example',
        rate20: number('800'),
        rate40: number('1400.1'),
        rate40hc: number('1450.55'),
        validity: 'Jun 6 - Jun 10',
        effective: excelDate('2026-06-06'),
        expiry: excelDate('2026-06-10'),
        notes1: 'Two-decimal forty-foot high cube',
        notes3: 'Only the third note is set'
    }),
    rateRow({
        rateType: 'FAK Base',
        origin: 'Low Wharf',
        destination: 'South Quay',
        inland: 'Ramp C, ZZ',
        carrier: 'Fixture Line',
        contractOwner: 'Example Owner',
        rate20: number('750.5'),
        validity: 'Jul 7 - Jul 21',
        effective: excelDate('2026-07-07'),
        expiry: excelDate('2026-07-21'),
        notes1: 'Only a twenty-foot price'
    })
];

const SUMMARY_ROWS = [
    [text('Fixture summary')],
    [],
    [text('This sheet is not a rate table.')],
    [text('Rows'), text('5')],
    [text('Carrier'), text('Fixture Line')]
];

const SAILING_HEADERS = [
    'Transit Time',
    'Carrier',
    'Departure',
    'Arrival',
    'Departure Port',
    'Arrival Port',
    'Voyage',
    'Service',
    'Vessel'
];

function sailingRow(values) {
    return [
        number(values.transit),
        text(values.carrier),
        text(values.departure),
        text(values.arrival),
        text(values.departurePort),
        values.arrivalPort ? text(values.arrivalPort) : null,
        text(values.voyage),
        text(values.service),
        values.vessel ? text(values.vessel) : null
    ];
}

const SAILING_ROWS = [
    sailingRow({
        transit: '21',
        carrier: 'Fixture Line',
        departure: '2026-04-02',
        arrival: '2026-04-23',
        departurePort: 'Cedar Dock',
        arrivalPort: 'North Quay',
        voyage: 'FX1',
        service: 'Loop A',
        vessel: 'Fixture Star'
    }),
    sailingRow({
        transit: '22',
        carrier: 'Fixture Line',
        departure: '2026-04-09',
        arrival: '2026-05-01',
        departurePort: 'Fixture Harbor',
        arrivalPort: 'South Quay',
        voyage: 'FX2',
        service: 'Loop B',
        vessel: 'Fixture Moon'
    }),
    sailingRow({
        transit: '20',
        carrier: 'Fixture Line',
        departure: '2026-05-03',
        arrival: '2026-05-23',
        departurePort: 'East Quay',
        arrivalPort: 'West Quay',
        voyage: 'FX3',
        service: 'Loop A'
    }),
    sailingRow({
        transit: '23',
        carrier: 'Fixture Line',
        departure: '2026-05-11',
        arrival: '2026-06-03',
        departurePort: 'Low Wharf',
        voyage: 'FX4',
        service: 'Loop C',
        vessel: 'Fixture Gale'
    })
];

function badRateRow(values) {
    return [
        text('FAK Base'),
        values.origin ? text(values.origin) : null,
        text(values.destination),
        null,
        text('Fixture Line'),
        null,
        text('Example Owner'),
        values.rate20 === undefined ? null : values.rate20,
        values.rate40 === undefined ? null : values.rate40,
        values.rate40hc === undefined ? null : values.rate40hc,
        text(values.validity),
        values.effective,
        values.expiry,
        text(values.notes1),
        null,
        null,
        null
    ];
}

const BAD_ROWS = [
    badRateRow({
        destination: 'West Quay',
        rate20: number('500'),
        validity: 'May 1 - May 20',
        effective: excelDate('2026-05-01'),
        expiry: excelDate('2026-05-20'),
        notes1: 'Origin port cell is omitted'
    }),
    badRateRow({
        origin: 'East Quay',
        destination: 'North Quay',
        rate20: number('600'),
        validity: 'Jun 6 - Jun 20',
        effective: text('06/10/2026'),
        expiry: excelDate('2026-06-20'),
        notes1: 'Effective date is an ambiguous slash date'
    }),
    badRateRow({
        origin: 'Low Wharf',
        destination: 'South Quay',
        rate20: number('-40'),
        validity: 'Jul 1 - Jul 15',
        effective: excelDate('2026-07-01'),
        expiry: excelDate('2026-07-15'),
        notes1: 'Twenty-foot price is negative'
    }),
    badRateRow({
        origin: 'Cedar Dock',
        destination: 'North Quay',
        rate20: text('EUR 900'),
        validity: 'Aug 3 - Aug 17',
        effective: excelDate('2026-08-03'),
        expiry: excelDate('2026-08-17'),
        notes1: 'Twenty-foot price is non-USD text'
    })
];

const README = `# Import fixtures

Synthetic files for R1-11a. Generated by \`scripts/generate-import-fixtures.js\`. None of these values come from a customer workbook.

## rates.xlsx

Sheet \`Fixture_Rates\` has the same column names as the representative rates workbook. Sheet \`Summary\` is a non-data sheet and is not a rate table.

- Strings are inline \`t="str"\` cells. There is no shared-strings part.
- Empty cells are omitted from the XML. Sheet row 3 omits the inland location, the contract number, the twenty-foot price, and notes 2 through 4. The twenty-foot price is absent, not zero.
- Effective Date and Expiry Date are Excel serials with a fractional day of 17/24 (17:00), styled with number format 14 (\`mm-dd-yy\`).
- Prices include one decimal, two decimals, and a whole number.
- Validity is free text such as \`Mar 2 - Mar 20\`, with no year.
- Contract Number, Validity, Notes 2, Notes 3, and Note 4 have no column of their own on \`rates\`. The header is \`Note 4\`, not \`Notes 4\`. The forty-foot header is \`40D rate\`.
- Sheet row 4's origin is \`  Padded Port  \` so trimming can be tested.
- Notes 1 on row 1 contains a comma and quotation marks.

## rates.csv

The \`Fixture_Rates\` sheet as UTF-8 CSV, including a leading UTF-8 BOM. Quoting follows the usual comma-separated rules: fields that contain a comma or a quote are quoted, and a quote inside a field is doubled. Omitted cells are empty fields, so the row stays rectangular. Dates are the same serial text as the workbook.

## sailings.xlsx

Sheet \`Fixture_Sailings\`. Departure and Arrival are ISO \`YYYY-MM-DD\` text, not serial numbers. Transit Time is a number. Sheet row 4 omits Vessel. Sheet row 5 omits Arrival Port. Arrival Port has no column on \`sailings\`.

## rates-bad.xlsx

Sheet \`Fixture_Rates\`, one bad condition per row:

1. Origin Port is omitted (required field missing).
2. Effective Date is the text \`06/10/2026\` (month/day order is ambiguous). Expiry Date is a normal serial.
3. 20D Rate is \`-40\`.
4. 20D Rate is the text \`EUR 900\`.
`;

function writeFile(name, data) {
    fs.writeFileSync(path.join(OUT_DIR, name), data);
}

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const rateSheet = [RATE_HEADERS.map(text), ...RATE_ROWS];
    writeFile('rates.xlsx', workbookBuffer([
        { name: 'Fixture_Rates', rows: rateSheet },
        { name: 'Summary', rows: SUMMARY_ROWS }
    ]));
    writeFile('rates.csv', csvBuffer(rateSheet));
    writeFile('sailings.xlsx', workbookBuffer([
        { name: 'Fixture_Sailings', rows: [SAILING_HEADERS.map(text), ...SAILING_ROWS] }
    ]));
    writeFile('rates-bad.xlsx', workbookBuffer([
        { name: 'Fixture_Rates', rows: [RATE_HEADERS.map(text), ...BAD_ROWS] }
    ]));
    writeFile('README.md', README);
}

main();
