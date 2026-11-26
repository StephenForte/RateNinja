'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { test } = require('node:test');
const { click, install, mountSwarm, options, runRecord, swarm, tags, walk } = require('./helpers/r1-65');

const zone = { locale: 'en-US', timeZone: 'America/New_York' };
const started = '2026-11-23T15:04:17.000Z';
const finished = '2026-11-23T16:09:17.000Z';
const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const customer = { signedIn: true, systemAdmin: false };

function shown(node) {
    if (node.children && node.children.length) return node.children.map(shown).join('');
    return node.textContent || '';
}

function laneRows(root) {
    const table = walk(root).find(node => String(node.className || '').split(' ').includes('swarm-lane-table'));
    assert.ok(table, 'lane table');
    const body = table.children.find(node => node.tag === 'tbody');
    return body.children.map(row => row.children.map(shown));
}

function factNode(root, term) {
    const label = walk(root).find(node => node.tag === 'dt' && node.textContent === term);
    assert.ok(label, term);
    return label.parent.children[label.parent.children.indexOf(label) + 1];
}

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

async function draw(t, run, time) {
    install(t);
    const { renderRunDetail, renderRunTable } = await import('../public/js/swarm/run-view.js');
    const detail = document.createElement('div');
    const list = document.createElement('div');
    renderRunDetail(detail, run, { time });
    renderRunTable(list, [run], { time });
    return { detail, list };
}

function customerReady(swarms, runs, onWrite) {
    return call => {
        if (call.path === '/api/swarm/access' && call.method === 'GET') return Response.json({ enabled: true });
        if (call.path === '/api/swarms' && call.method === 'GET') return Response.json({ swarms });
        if (call.path === '/api/managed-agents/options' && call.method === 'GET') return Response.json(options);
        if (call.path === '/api/swarm-runs' && call.method === 'GET') return Response.json({ runs });
        if (onWrite) return onWrite(call);
        return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
    };
}

test('every search state uses the latest attempt for that lane', async t => {
    const cases = [
        ['Waiting', 'running', [], 'Waiting'],
        ['Searching', 'running', [agent({ status: 'running', report: 'looking' })], 'Searching'],
        ['Rate found', 'completed', [agent({ rateId: 'rate-1', price: 1350.75, report: 'found' })], 'Rate found'],
        ['No rate', 'completed', [agent({ report: 'none' })], 'No rate'],
        ['Failed', 'failed', [agent({ status: 'failed', report: 'broke' })], 'Failed'],
        ['Cancelled', 'cancelled', [agent({ status: 'cancelled', report: 'stopped' })], 'Cancelled'],
        ['Not searched', 'completed', [], 'Not searched']
    ];
    for (const [name, status, agents, search] of cases) {
        const { detail } = await draw(t, runRecord({
            status, finishedAt: status === 'running' ? null : finished, lanes: [lane(1)], agents
        }), zone);
        const row = laneRows(detail)[0];
        assert.equal(row[5], search, name);
        if (name === 'Rate found') {
            assert.equal(row[6], '$1,351');
            assert.equal(row[8], 'found');
        }
        if (name === 'No rate') assert.equal(row[6], '');
    }

    const replaced = await draw(t, runRecord({
        lanes: [lane(1)],
        agents: [
            agent({ attempt: 1, rateId: 'rate-old', price: 10, report: 'first try' }),
            agent({ attempt: 2, rateId: 'rate-new', price: 1350.75, report: 'second try' })
        ]
    }), zone);
    const row = laneRows(replaced.detail)[0];
    assert.equal(row[5], 'Rate found');
    assert.equal(row[6], '$1,351');
    assert.equal(row[8], 'second try');
    assert.equal(row[8].includes('first try'), false);
});

test('every booking state is labeled from the latest booking attempt', async t => {
    const lanes = [
        lane(1, { allowBookingRequest: false }),
        lane(2),
        lane(3),
        lane(4),
        lane(5),
        lane(6),
        lane(7)
    ];
    const agents = [
        agent({ role: 'booking', lanePosition: 1, status: 'completed', bookingRequestId: 'br-hidden', slots: 9, report: 'hidden' }),
        agent({ role: 'booking', lanePosition: 3, status: 'running', report: 'asking' }),
        agent({ role: 'booking', lanePosition: 4, attempt: 1, status: 'completed', bookingRequestId: 'br-old', slots: 1, report: 'old request' }),
        agent({ role: 'booking', lanePosition: 4, attempt: 2, status: 'completed', bookingRequestId: 'br-new', slots: 3, report: 'new request' }),
        agent({ role: 'booking', lanePosition: 5, status: 'completed', report: 'declined' }),
        agent({ role: 'booking', lanePosition: 6, status: 'failed', report: 'failed booking' }),
        agent({ role: 'booking', lanePosition: 7, status: 'cancelled', report: 'cancelled booking' })
    ];
    const { detail } = await draw(t, runRecord({ lanes, agents }), zone);
    const rows = laneRows(detail);
    assert.deepEqual(rows.map(row => row[7]), [
        'Not allowed',
        'Not attempted',
        'Booking',
        'Requested, 3 slots Booking requests',
        'Not booked',
        'Failed',
        'Cancelled'
    ]);
    assert.equal(rows[3][8], 'new request');
    const table = walk(detail).find(node => String(node.className || '').split(' ').includes('swarm-lane-table'));
    const bookingCell = table.children.find(node => node.tag === 'tbody').children[3].children[7];
    const links = walk(bookingCell).filter(node => node.tag === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].attributes.href, '/profile/booking-requests');
    assert.equal(links[0].textContent, 'Booking requests');
});

test('a search-only run shows the rate, the price, the report, and Not allowed', async t => {
    const { detail } = await draw(t, runRecord({
        lanes: [
            lane(1, { allowBookingRequest: false }),
            lane(2, { allowBookingRequest: false, rateType: 'FCL', originPort: 'NGB', destinationPort: 'NYC' })
        ],
        agents: [
            agent({ lanePosition: 1, rateId: 'rate-1', price: 1350.75, report: 'found the rate' }),
            agent({ lanePosition: 2, report: 'nothing there' })
        ]
    }), zone);
    const rows = laneRows(detail);
    assert.deepEqual(rows[0].slice(5), ['Rate found', '$1,351', 'Not allowed', 'found the rate']);
    assert.deepEqual(rows[1].slice(5), ['No rate', '', 'Not allowed', 'nothing there']);
    assert.equal(walk(detail).some(node => node.textContent === 'Lane results (2 lanes)'), true);
});

test('a 25-lane run shows one row per lane, including lanes with no agent', async t => {
    const lanes = Array.from({ length: 25 }, (_, index) => lane(index + 1, { destinationPort: `P${index + 1}` }));
    const agents = [1, 2, 3].map(position => agent({
        lanePosition: position, rateId: `rate-${position}`, price: 100, report: `lane ${position}`
    }));
    const { detail } = await draw(t, runRecord({ lanes, agents }), zone);
    const rows = laneRows(detail);
    assert.equal(rows.length, 25);
    assert.equal(walk(detail).some(node => node.textContent === 'Lane results (25 lanes)'), true);
    assert.equal(rows[0][5], 'Rate found');
    assert.equal(rows[24][0], '25');
    assert.equal(rows[24][5], 'Not searched');
    assert.equal(walk(detail).some(node => node.textContent === 'Agent activity'), true);
});

test('hostile lane text and reports stay text and a missing lanes array skips the lane table', async t => {
    const { detail } = await draw(t, runRecord({
        lanes: [lane(1, { rateType: hostile, originPort: hostile, destinationPort: hostile })],
        agents: [agent({ report: hostile }), agent({ role: 'booking', report: hostile, bookingRequestId: 'br-1', slots: 2 })]
    }), zone);
    const row = laneRows(detail)[0];
    assert.equal(row[1].includes(hostile), true);
    assert.equal(row[8], `${hostile}\n${hostile}`);
    assert.equal(tags(detail).includes('script'), false);
    assert.equal(tags(detail).includes('img'), false);

    const bare = await draw(t, runRecord({
        agents: [agent({ role: 'master', lanePosition: null, report: 'master note' })]
    }), zone);
    assert.equal(walk(bare.detail).some(node => String(node.className || '').includes('swarm-lane-table')), false);
    assert.equal(walk(bare.detail).some(node => node.textContent === 'Lane results (0 lanes)'), false);
    assert.equal(walk(bare.detail).some(node => node.textContent === 'Agent activity'), true);
    assert.equal(walk(bare.detail).some(node => node.textContent === 'master note'), true);
});

test('times render in the injected zone, keep the ISO title, and duration covers finished and running runs', async t => {
    const { formatDuration, formatWhen } = await import('../public/js/swarm/time.js');
    const when = formatWhen(started, zone);
    assert.equal(when.text, '11/23/26, 10:04 AM');
    assert.equal(when.title, started);
    assert.equal(formatDuration(started, finished), '1h 5m');
    assert.equal(formatDuration(started, null, { now: '2026-11-23T15:06:00.000Z' }), '1m 43s');

    const done = runRecord({
        startedAt: started,
        finishedAt: finished,
        lanes: [lane(1, { allowBookingRequest: false })],
        agents: [agent({ startedAt: started, finishedAt: '2026-11-23T15:10:17.000Z', report: 'done' })]
    });
    const drawn = await draw(t, done, zone);
    const startedFact = factNode(drawn.detail, 'Started');
    assert.equal(startedFact.textContent, '11/23/26, 10:04 AM');
    assert.equal(startedFact.attributes.title, started);
    assert.equal(factNode(drawn.detail, 'Duration').textContent, '1h 5m');
    const listDuration = walk(drawn.list).find(node => node.className === 'swarm-run-duration');
    assert.equal(listDuration.textContent, '1h 5m');
    const agentTime = walk(drawn.detail).find(node => node.tag === 'td' && node.attributes && node.attributes.title === started);
    assert.equal(agentTime.textContent, '11/23/26, 10:04 AM');

    const running = await draw(t, runRecord({
        status: 'running', startedAt: started, finishedAt: null, lanes: [lane(1)]
    }), { ...zone, now: '2026-11-23T15:06:00.000Z' });
    assert.equal(factNode(running.detail, 'Duration').textContent, '1m 43s');
    assert.equal(laneRows(running.detail)[0][5], 'Waiting');
});

test('the swarm page names Swarms and Runs and cuts long instructions into the title', async t => {
    const instructions = `Keep the whole instruction. ${'lane '.repeat(40)}`;
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm({ instructions })], [])
    });
    const titles = walk(container).filter(node => node.tag === 'h2').map(node => node.textContent);
    assert.ok(titles.indexOf('Swarms') >= 0);
    assert.ok(titles.indexOf('Runs') > titles.indexOf('Swarms'));
    const cell = walk(container).find(node => node.className === 'swarm-instructions');
    assert.ok(cell);
    assert.equal(cell.attributes.title, instructions);
    assert.equal(cell.textContent.endsWith('…'), true);
    assert.equal(cell.textContent.length, 80);
    assert.notEqual(cell.textContent, instructions);
    assert.equal(tags(container).includes('script'), false);
    const scrolls = walk(container).filter(node => String(node.className || '').split(' ').includes('agent-grid-scroll'));
    assert.ok(scrolls.length >= 2);
});

test('the lane table updates when a poll returns a new agent', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let reads = 0;
    const running = runRecord({ status: 'running', finishedAt: null, summary: 'In progress', lanes: [lane(1)] });
    const withAgent = {
        ...running,
        agents: [agent({ status: 'running', report: 'looking now' })]
    };
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm()], [running], call => {
            if (call.path === '/api/swarm-runs/run-1' && call.method === 'GET') {
                reads += 1;
                return Response.json({ run: reads === 1 ? running : withAgent });
            }
            return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
        })
    });
    await click(container, 'Open');
    assert.equal(laneRows(container)[0][5], 'Waiting');
    t.mock.timers.tick(2000);
    for (let count = 0; count < 6; count += 1) await settle();
    assert.equal(reads, 2);
    assert.equal(laneRows(container)[0][5], 'Searching');
    assert.equal(laneRows(container)[0][8], 'looking now');
});
