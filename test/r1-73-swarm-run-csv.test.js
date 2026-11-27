'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { install, walk } = require('./helpers/r1-65');
const { downloadButtons, labelText, parseRunCsv } = require('./helpers/r1-73');

const HEADER = [
    '#', 'Rate Type', 'Origin', 'Destination', 'Sailing Date', 'Container', 'Priority',
    'Search', 'Price USD', 'Booking', 'Slots Requested', 'Booking Request Id', 'Result'
];
const started = '2026-11-23T15:04:17.000Z';

function lane(position, overrides = {}) {
    return {
        position,
        rateType: 'Port',
        originPort: 'SHA',
        destinationPort: 'LAX',
        sailingDate: '2026-12-01',
        containerType: '40HC',
        priority: 'normal',
        allowBookingRequest: true,
        ...overrides
    };
}

function agent(overrides) {
    return {
        role: 'search',
        lanePosition: 1,
        attempt: 1,
        status: 'completed',
        report: '',
        rateId: null,
        price: null,
        slots: null,
        bookingRequestId: null,
        ...overrides
    };
}

function run(overrides = {}) {
    return {
        id: 'run-1',
        swarmName: 'North',
        status: 'completed',
        startedAt: started,
        agents: [],
        lanes: [lane(1)],
        ...overrides
    };
}

function rowsOf(text) {
    const rows = parseRunCsv(text);
    assert.equal(rows[0].join('|'), HEADER.join('|'));
    return rows.slice(1);
}

function tableRows(detail) {
    const table = walk(detail).find(node => String(node.className || '').split(' ').includes('swarm-lane-table'));
    const body = table.children.find(node => node.tag === 'tbody');
    return body.children;
}

function endsWithCrlf(text) {
    assert.equal(text.charCodeAt(0), 0xFEFF);
    const body = text.slice(1);
    assert.equal(body.endsWith('\r\n'), true);
    let quoted = false;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (quoted) {
            if (char === '"') {
                if (body[index + 1] === '"') {
                    index += 1;
                    continue;
                }
                quoted = false;
            }
            continue;
        }
        if (char === '"') {
            quoted = true;
            continue;
        }
        if (char === '\n') assert.fail('row ended with a bare LF');
        if (char === '\r') {
            assert.equal(body[index + 1], '\n');
            index += 1;
        }
    }
}

test('the file has the 13 columns and one row per lane in table order', async () => {
    const { laneResultsCsv } = await import('../public/js/swarm/run-csv.js');
    const lanes = Array.from({ length: 25 }, (_, index) => lane(25 - index, {
        originPort: `O${index}`,
        destinationPort: `D${index}`
    }));
    const text = laneResultsCsv(run({ lanes }));
    endsWithCrlf(text);
    const data = rowsOf(text);
    assert.equal(data.length, 25);
    assert.deepEqual(data.map(row => row[0]), lanes.map(item => String(item.position)));
    assert.equal(data[0][2], 'O0');
    assert.equal(data[24][2], 'O24');
});

test('search, booking and result in the file match the lane table', async t => {
    install(t);
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const { laneResultsCsv } = await import('../public/js/swarm/run-csv.js');
    const lanes = [
        lane(1, { allowBookingRequest: true }),
        lane(2, { allowBookingRequest: true }),
        lane(3, { allowBookingRequest: false }),
        lane(4, { allowBookingRequest: true }),
        lane(5, { allowBookingRequest: true })
    ];
    const agents = [
        agent({ lanePosition: 1, rateId: 'rate-1', price: 12574.25, report: 'found 12574.25' }),
        agent({ role: 'booking', lanePosition: 1, bookingRequestId: 'br-1', slots: 2, report: 'booked it' }),
        agent({ lanePosition: 2, rateId: 'rate-2', price: 100, report: 'second rate' }),
        agent({ role: 'booking', lanePosition: 2, status: 'completed', report: 'left open' }),
        agent({ lanePosition: 3, status: 'failed', report: 'search broke' }),
        agent({ lanePosition: 4, report: 'nothing' })
    ];
    const record = run({ lanes, agents });
    const detail = document.createElement('div');
    renderRunDetail(detail, record, {});
    const fileRows = rowsOf(laneResultsCsv(record));
    const shown = tableRows(detail);
    assert.equal(fileRows.length, shown.length);
    shown.forEach((row, index) => {
        assert.equal(fileRows[index][7], row.children[5].textContent);
        assert.equal(fileRows[index][9], labelText(row.children[7]).trim());
        assert.equal(fileRows[index][12], row.children[8].textContent);
    });
    assert.equal(fileRows[0][7], 'Rate found');
    assert.equal(fileRows[0][8], '12574.25');
    assert.equal(shown[0].children[6].textContent, '$12,574');
    assert.equal(fileRows[0][9], 'Requested, 2 slots');
    assert.equal(fileRows[0][10], '2');
    assert.equal(fileRows[0][11], 'br-1');
    assert.equal(fileRows[0][12], 'found 12574.25\nbooked it');
    assert.equal(fileRows[1][9], 'Not booked');
    assert.equal(fileRows[2][7], 'Failed');
    assert.equal(fileRows[2][9], 'Not allowed');
    assert.equal(fileRows[3][7], 'No rate');
    assert.equal(fileRows[4][7], 'Not searched');
    assert.equal(fileRows[4][9], 'Not attempted');
    assert.equal(fileRows[4][8], '');
    assert.equal(fileRows[4][10], '');
    assert.equal(fileRows[4][11], '');
    assert.equal(HEADER.includes('Input tokens'), false);
    assert.equal(laneResultsCsv(record).includes('token'), false);
});

test('formula characters gain a leading apostrophe before quoting', async () => {
    const { laneResultsCsv } = await import('../public/js/swarm/run-csv.js');
    const cases = ['=1+1', '+cmd', '-cmd', '@cmd', '\tcmd'];
    for (const result of cases) {
        const [row] = rowsOf(laneResultsCsv(run({
            lanes: [lane(1, { originPort: '=SHA' })],
            agents: [agent({ report: result })]
        })));
        assert.equal(row[12], `'${result}`);
        assert.equal(row[2], "'=SHA");
    }
    const quoted = 'Say "hello", then\ncontinue';
    const [row] = rowsOf(laneResultsCsv(run({
        agents: [agent({ report: quoted })]
    })));
    assert.equal(row[12], quoted);
    const text = laneResultsCsv(run({
        lanes: [lane(1, { originPort: '=SHA' })],
        agents: [agent({ report: '=HYPERLINK("http://example.test")' })]
    }));
    endsWithCrlf(text);
    assert.equal(text.includes("'=HYPERLINK"), true);
    assert.equal(text.includes('"\'=SHA"'), false);
});

test('file names keep a short slug and a start date, or fall back to swarm-run.csv', async () => {
    const { laneResultsFilename } = await import('../public/js/swarm/run-csv.js');
    assert.equal(
        laneResultsFilename(run({ swarmName: 'CSV Swarm #1 / Test', startedAt: started })),
        'swarm-run-csv-swarm-1-test-2026-11-23.csv'
    );
    const longName = 'Abcdefghij'.repeat(6);
    assert.equal(longName.length, 60);
    assert.equal(
        laneResultsFilename(run({ swarmName: longName, startedAt: null })),
        `swarm-run-${'abcdefghij'.repeat(4)}.csv`
    );
    assert.equal(laneResultsFilename({ swarmName: '', startedAt: '' }), 'swarm-run.csv');
    assert.equal(laneResultsFilename({}), 'swarm-run.csv');
});

test('Download CSV is present only when the run has at least one lane', async t => {
    install(t);
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const one = document.createElement('div');
    renderRunDetail(one, run({ lanes: [lane(1)] }), { showTokens: true });
    assert.equal(downloadButtons(one, walk).length, 1);
    assert.equal(walk(one).some(node => node.textContent === 'Input tokens'), true);

    const empty = document.createElement('div');
    renderRunDetail(empty, run({ lanes: [] }), {});
    assert.equal(downloadButtons(empty, walk).length, 0);
    assert.equal(walk(empty).some(node => node.textContent === 'Lane results (0 lanes)'), true);

    const missing = document.createElement('div');
    renderRunDetail(missing, run({ lanes: undefined }), {});
    assert.equal(downloadButtons(missing, walk).length, 0);
    assert.equal(walk(missing).some(node => String(node.className || '').includes('swarm-lane-table')), false);
});

test('Download CSV builds a text/csv blob in the browser and does not fetch', async t => {
    install(t);
    const blobs = [];
    const fetches = [];
    const previousCreate = URL.createObjectURL;
    const previousRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: blob => {
            blobs.push(blob);
            return 'blob:lane-results';
        }
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: () => {}
    });
    t.mock.method(global, 'fetch', async (...args) => {
        fetches.push(args);
        throw new Error('download must not fetch');
    });
    t.after(() => {
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            writable: true,
            value: previousCreate
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            writable: true,
            value: previousRevoke
        });
    });
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const detail = document.createElement('div');
    renderRunDetail(detail, run({
        swarmName: 'CSV Swarm #1 / Test',
        lanes: [lane(1)],
        agents: [agent({ rateId: 'rate-1', price: 12574.25, report: 'found' })]
    }), {});
    const [button] = downloadButtons(detail, walk);
    await button.events.click();
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0] instanceof Blob, true);
    assert.equal(blobs[0].type, 'text/csv');
    assert.equal(fetches.length, 0);
    const bytes = new Uint8Array(await blobs[0].arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.equal(parseRunCsv(text)[1][8], '12574.25');
});
