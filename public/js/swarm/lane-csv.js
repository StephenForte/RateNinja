const COLUMNS = [
    { key: 'rateType', name: 'Rate Type', required: true },
    { key: 'originPort', name: 'Origin Port', required: true },
    { key: 'destinationPort', name: 'Destination Port', required: true },
    { key: 'sailingDate', name: 'Sailing Date', required: true },
    { key: 'containerType', name: 'Container Type', required: true },
    { key: 'priority', name: 'Priority' },
    { key: 'allowAlternatives', name: 'Allow Alternatives' },
    { key: 'dateFlexDays', name: 'Date Flex Days' },
    { key: 'allowBooking', name: 'Allow Booking' },
    { key: 'priceMin', name: 'Min Price' },
    { key: 'priceMax', name: 'Max Price' },
    { key: 'slots', name: 'Slots' },
    { key: 'acceptMaxSlots', name: 'AI Slot Selection' }
];

const PRIORITIES = ['high', 'normal', 'low'];
const YES = ['yes', 'y', 'true'];
const NO = ['no', 'n', 'false'];

export const CSV_BYTE_LIMIT = 100000;
export const CSV_LANE_LIMIT = 25;
export const DATE_FORMAT_MESSAGE = 'Enter the sailing date as YYYY-MM-DD.';
export const CSV_MESSAGES = {
    name: 'Choose a .csv file.',
    size: 'Choose a CSV file of at most 100000 bytes.',
    read: 'Could not read that file.',
    parse: 'The file is not valid CSV.',
    none: 'The file has no lane rows.',
    tooMany: 'A file can have at most 25 lanes.',
    priority: 'Priority must be high, normal or low.',
    wide: 'This row has more cells than the header.',
    confirm: 'Replace the lanes already in this swarm?'
};

function fold(value) {
    return String(value ?? '').trim().toLowerCase();
}

function missingColumns(names) {
    return `The file is missing required columns: ${names.join(', ')}.`;
}

function unknownColumns(names) {
    return `The file has an unknown column: ${names.join(', ')}.`;
}

function repeatedColumns(names) {
    return `The file repeats a column: ${names.join(', ')}.`;
}

function yesNoMessage(name) {
    return `${name} must be yes or no.`;
}

function badCsv() {
    return { ok: false, messages: [CSV_MESSAGES.parse] };
}

function parseCsv(text) {
    const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : String(text ?? '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let closed = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (quoted) {
            if (char === '"') {
                if (source[index + 1] === '"') {
                    field += '"';
                    index += 1;
                    continue;
                }
                quoted = false;
                closed = true;
                continue;
            }
            field += char;
            continue;
        }
        if (char === ',') {
            row.push(field);
            field = '';
            closed = false;
            continue;
        }
        if (char === '\n' || char === '\r') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            closed = false;
            if (char === '\r' && source[index + 1] === '\n') index += 1;
            continue;
        }
        if (char === '"') {
            if (field !== '' || closed) return badCsv();
            quoted = true;
            continue;
        }
        if (closed) return badCsv();
        field += char;
    }
    if (quoted) return badCsv();
    if (field.length > 0 || closed || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return { ok: true, rows };
}

function blankRow(cells) {
    return cells.every(cell => String(cell ?? '').trim() === '');
}

export function parseLaneCsv(text) {
    const parsed = parseCsv(String(text ?? ''));
    if (!parsed.ok) return parsed;
    if (!parsed.rows.length || blankRow(parsed.rows[0])) {
        return { ok: false, messages: [missingColumns(COLUMNS.filter(column => column.required).map(column => column.name))] };
    }
    const header = parsed.rows[0];
    const located = new Map();
    const unknown = [];
    const repeated = [];
    header.forEach((cell, index) => {
        const label = String(cell ?? '').trim();
        const column = COLUMNS.find(item => item.name.toLowerCase() === label.toLowerCase());
        if (!column) {
            unknown.push(label || '(blank)');
            return;
        }
        if (located.has(column.key)) {
            if (!repeated.includes(column.name)) repeated.push(column.name);
            return;
        }
        located.set(column.key, index);
    });
    const missing = COLUMNS.filter(column => column.required && !located.has(column.key)).map(column => column.name);
    const messages = [];
    if (missing.length) messages.push(missingColumns(missing));
    if (unknown.length) messages.push(unknownColumns(unknown));
    if (repeated.length) messages.push(repeatedColumns(repeated));
    if (messages.length) return { ok: false, messages };

    const records = [];
    for (let index = 1; index < parsed.rows.length; index += 1) {
        const cells = parsed.rows[index];
        if (blankRow(cells)) continue;
        if (cells.length > header.length) {
            records.push({ rowNumber: index + 1, extra: true, values: {} });
            continue;
        }
        const values = {};
        for (const column of COLUMNS) {
            const at = located.get(column.key);
            values[column.key] = at == null ? '' : String(cells[at] ?? '').trim();
        }
        records.push({ rowNumber: index + 1, extra: false, values });
    }
    if (!records.length) return { ok: false, messages: [CSV_MESSAGES.none] };
    if (records.length > CSV_LANE_LIMIT) return { ok: false, messages: [CSV_MESSAGES.tooMany] };
    return { ok: true, records };
}

function isCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function matchText(left, right) {
    return fold(left) === fold(right);
}

function canonLane(options, rateType, origin, destination) {
    const found = (options?.lanes || []).find(item => matchText(item.rateType, rateType)
        && matchText(item.originPort, origin)
        && matchText(item.destinationPort, destination));
    if (!found) {
        return {
            rateType: String(rateType ?? '').trim(),
            originPort: String(origin ?? '').trim(),
            destinationPort: String(destination ?? '').trim()
        };
    }
    return {
        rateType: found.rateType,
        originPort: found.originPort,
        destinationPort: found.destinationPort
    };
}

function canonContainer(options, value) {
    const found = (options?.containerTypes || []).find(item => matchText(item, value));
    return found || String(value ?? '').trim();
}

function yesNo(value) {
    const token = fold(value);
    if (!token) return { ok: true, value: false };
    if (YES.includes(token)) return { ok: true, value: true };
    if (NO.includes(token)) return { ok: true, value: false };
    return { ok: false };
}

function plainNumber(value) {
    return /^-?\d+(?:\.\d+)?$/.test(value);
}

function priceCell(value) {
    if (!value) return '';
    // "x" is not a plain number, so the wizard's own price and slot checks refuse it.
    return plainNumber(value) ? value : 'x';
}

export function laneFromRecord(record, options) {
    if (record?.extra) return { lane: null, messages: [CSV_MESSAGES.wide] };
    const values = record?.values || {};
    const messages = [];
    const lane = {
        ...canonLane(options, values.rateType, values.originPort, values.destinationPort),
        sailingDate: values.sailingDate || '',
        containerType: canonContainer(options, values.containerType),
        priority: 'normal',
        allowAlternativeRoutes: false,
        dateFlexDays: 0,
        allowBookingRequest: false,
        priceMin: '',
        priceMax: '',
        bookingSlots: '',
        acceptMaxSlots: false
    };
    if (lane.sailingDate && !isCalendarDate(lane.sailingDate)) messages.push(DATE_FORMAT_MESSAGE);
    const priority = fold(values.priority);
    if (!priority) lane.priority = 'normal';
    else if (PRIORITIES.includes(priority)) lane.priority = priority;
    else messages.push(CSV_MESSAGES.priority);
    const alternatives = yesNo(values.allowAlternatives);
    if (!alternatives.ok) messages.push(yesNoMessage('Allow Alternatives'));
    else lane.allowAlternativeRoutes = alternatives.value;
    const flex = values.dateFlexDays || '';
    if (!flex) lane.dateFlexDays = 0;
    else if (/^\d+$/.test(flex)) lane.dateFlexDays = Number(flex);
    else lane.dateFlexDays = Number.NaN;
    const booking = yesNo(values.allowBooking);
    if (!booking.ok) messages.push(yesNoMessage('Allow Booking'));
    else lane.allowBookingRequest = booking.value;
    if (booking.ok && booking.value) {
        lane.priceMin = priceCell(values.priceMin || '');
        lane.priceMax = priceCell(values.priceMax || '');
        lane.bookingSlots = priceCell(values.slots || '');
        const slots = yesNo(values.acceptMaxSlots);
        if (!slots.ok) messages.push(yesNoMessage('AI Slot Selection'));
        else lane.acceptMaxSlots = slots.value;
    }
    return { lane, messages };
}

function csvField(value) {
    const text = value == null ? '' : String(value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function currentWindow(lane, today) {
    return (lane?.windows || []).find(window => {
        const end = window?.end;
        return typeof end === 'string' && end !== '' && (!today || end >= today);
    });
}

export function templateCsv(options) {
    const header = COLUMNS.map(column => csvField(column.name)).join(',');
    const today = options?.today || '';
    const lane = (options?.lanes || []).find(item => currentWindow(item, today));
    if (!lane) return `${header}\n`;
    const window = currentWindow(lane, today);
    let date = typeof window.start === 'string' ? window.start : '';
    if (today && (!date || date < today)) date = today;
    const container = (options?.containerTypes || [])[0] || '';
    const row = [
        lane.rateType, lane.originPort, lane.destinationPort, date, container,
        'normal', 'no', '0', 'no', '', '', '', 'no'
    ];
    return `${header}\n${row.map(csvField).join(',')}\n`;
}

export function problemLines(messages) {
    const lines = messages.slice(0, 10);
    const rest = messages.length - lines.length;
    if (rest > 0) lines.push(`and ${rest} more`);
    return lines;
}
