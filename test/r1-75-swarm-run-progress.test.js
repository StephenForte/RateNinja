'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runRecord, walk } = require('./helpers/r1-65');
const { lane } = require('./helpers/r1-70');
const { laneActivityRun } = require('./helpers/r1-74');
const { browserLikeDom, nodeWithClass, progressRun, tableRows } = require('./helpers/r1-75');

const searchCounts = ['Searching', 'Waiting', 'Rate found', 'No rate', 'Failed'];

async function view(t) {
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const dom = browserLikeDom(t);
    return { ...dom, draw: (run, options) => renderRunDetail(dom.host, run, options) };
}

function progress(host) {
    const block = nodeWithClass(host, 'swarm-run-progress');
    assert.ok(block, 'progress block');
    const [label, meter, counts] = block.children;
    assert.equal(host.children[1], block);
    assert.equal(host.children[2].tag, 'dl');
    assert.equal(meter.tag, 'progress');
    assert.equal(meter.attributes['aria-label'], label.textContent);
    return { label: label.textContent, meter, counts: counts.children.map(node => node.textContent) };
}

function assertRowCounts(host, counts) {
    const rows = tableRows(host);
    const search = rows.map(row => row.children[5].textContent);
    const bookings = rows.filter(row => row.children[7].children.some(node => node.tag === 'a'));
    assert.deepEqual(counts, [
        ...searchCounts.map(word => `${word} ${search.filter(value => value === word).length}`),
        `Bookings requested ${bookings.length}`
    ]);
}

test('running 25-lane progress shows searched lanes and the six counts in order', async t => {
    const { draw, host } = await view(t);
    draw(progressRun());
    const { label, meter, counts } = progress(host);
    assert.equal(label, 'Searched 9 of 25 lanes');
    assert.equal(meter.value, 9);
    assert.equal(meter.max, 25);
    assert.deepEqual(counts, ['Searching 3', 'Waiting 13', 'Rate found 6', 'No rate 2', 'Failed 1', 'Bookings requested 2']);
    assertRowCounts(host, counts);
});

test('completed progress includes cancelled searches and excludes untouched lanes', async t => {
    const { draw, host } = await view(t);
    const run = progressRun();
    run.status = 'completed';
    run.agents = run.agents.filter(agent => agent.status !== 'running');
    run.agents.push({ role: 'search', lanePosition: 10, attempt: 1, status: 'cancelled' });
    draw(run, { showTokens: true });
    const { label, meter, counts } = progress(host);
    assert.equal(label, 'Searched 10 of 25 lanes');
    assert.equal(meter.value, 10);
    assert.equal(meter.max, 25);
    assert.deepEqual(counts, ['Searching 0', 'Waiting 0', 'Rate found 6', 'No rate 2', 'Failed 1', 'Bookings requested 2']);
    assertRowCounts(host, counts);
    const searchLabels = tableRows(host).map(row => row.children[5].textContent);
    assert.equal(searchLabels.filter(label => label === 'Not searched').length, 15);
    assert.equal(searchLabels.filter(label => label === 'Cancelled').length, 1);
    assert.equal(nodeWithClass(host, 'swarm-input-tokens').textContent, '111');
});

test('progress counts only the latest attempt per lane and role', async () => {
    const { laneProgress } = await import('../public/js/swarm/run-csv.js');
    const run = runRecord({ lanes: [lane(1)], agents: [
        { role: 'search', lanePosition: 1, attempt: 2, status: 'completed', rateId: 'latest' },
        { role: 'search', lanePosition: 1, attempt: 1, status: 'failed' },
        { role: 'booking', lanePosition: 1, attempt: 1, status: 'completed', bookingRequestId: 'earlier' },
        { role: 'booking', lanePosition: 1, attempt: 2, status: 'failed' }
    ] });
    assert.deepEqual(laneProgress(run), {
        total: 1, searched: 1,
        counts: { Searching: 0, Waiting: 0, 'Rate found': 1, 'No rate': 0, Failed: 0 },
        bookingsRequested: 0
    });
    run.lanes[0].allowBookingRequest = false;
    run.agents[3].bookingRequestId = 'recorded';
    assert.equal(laneProgress(run).bookingsRequested, 1);
});

test('run details omit progress when lanes is missing or empty', async t => {
    const { draw, host } = await view(t);
    for (const lanes of [undefined, []]) {
        draw(runRecord({ lanes }));
        assert.equal(nodeWithClass(host, 'swarm-run-progress'), undefined);
        assert.equal(host.children[1].tag, 'dl');
        assert.equal(walk(host).some(node => node.tag === 'progress'), false);
    }
});

test('lane badges keep every label, status colour and booking link', async t => {
    const { draw, host } = await view(t);
    const searches = [
        [null, 'Waiting', ''], ['running', 'Searching', 'running'],
        ['completed', 'Rate found', 'completed', { rateId: 'rate' }], ['completed', 'No rate', ''],
        ['failed', 'Failed', 'failed'], ['cancelled', 'Cancelled', ''], ['unknown', '', ''], [null, 'Waiting', '']
    ];
    const bookings = [
        [null, 'Not allowed', ''], [null, 'Not attempted', ''], ['running', 'Booking', 'running'],
        ['completed', 'Requested, 4 slots', 'completed', { bookingRequestId: 'booking', slots: 4 }],
        ['completed', 'Not booked', ''], ['failed', 'Failed', 'failed'], ['cancelled', 'Cancelled', ''],
        ['unknown', '', '']
    ];
    const lanes = searches.map((_, index) => lane(index + 1, { allowBookingRequest: index !== 0 }));
    const agents = [[searches, 'search'], [bookings, 'booking']].flatMap(([cases, role]) => (
        cases.flatMap(([status, , , extra], index) => status ? [{ role, lanePosition: index + 1, attempt: 1, status, ...extra }] : [])
    ));
    const run = runRecord({ status: 'running', lanes, agents });
    const check = (cell, label, color, link = false) => {
        assert.equal(cell.textContent, link ? `${label} Booking requests` : label);
        assert.deepEqual(cell.children.map(node => node.tag), link ? ['span', '#text', 'a'] : label ? ['span'] : []);
        if (!label) return;
        assert.equal(cell.children[0].textContent, label);
        assert.equal(cell.children[0].className, color ? `agent-status agent-status-${color}` : 'agent-status');
        if (link) assert.equal(cell.children[2].attributes.href, '/profile/booking-requests');
    };
    draw(run);
    tableRows(host).forEach((row, index) => {
        assert.equal(row.children[5].className, 'swarm-lane-search');
        assert.equal(row.children[7].className, 'swarm-lane-booking');
        check(row.children[5], searches[index][1], searches[index][2]);
        check(row.children[7], bookings[index][1], bookings[index][2], index === 3);
    });
    draw({ ...run, status: 'completed' });
    check(tableRows(host)[0].children[5], 'Not searched', '');
});

test('refresh preserves both scroll positions and the focused action for the same run', async t => {
    const { draw, doc, host } = await view(t);
    const run = progressRun();
    const options = { onCancel() {} };
    const wrapper = name => nodeWithClass(host, `swarm-${name}-scroll`);
    const button = label => walk(host).find(node => node.tag === 'button' && node.textContent === label);
    draw(run, options);
    wrapper('lane').scrollLeft = 200;
    wrapper('agent').scrollLeft = 120;
    for (const label of ['Cancel', 'Download CSV']) {
        const previous = button(label);
        previous.focus();
        draw({ ...run }, options);
        assert.equal(wrapper('lane').scrollLeft, 200);
        assert.equal(wrapper('agent').scrollLeft, 120);
        assert.equal(doc.activeElement, button(label));
        assert.notEqual(doc.activeElement, previous);
    }
});

test('switching runs and clearing the host reset scroll and leave focus alone', async t => {
    const { draw, doc, host, root } = await view(t);
    const runA = progressRun();
    const runB = { ...runA, id: 'run-b' };
    const laneScroll = () => nodeWithClass(host, 'swarm-lane-scroll');
    const agentScroll = () => nodeWithClass(host, 'swarm-agent-scroll');
    const setPlace = (lane, agent) => {
        laneScroll().scrollLeft = lane;
        agentScroll().scrollLeft = agent;
        nodeWithClass(host, 'swarm-lane-csv').focus();
    };
    const assertReset = () => {
        assert.equal(laneScroll().scrollLeft, 0);
        assert.equal(agentScroll().scrollLeft, 0);
        assert.equal(doc.activeElement, root);
    };
    draw(runA);
    assertReset();
    setPlace(200, 120);
    draw(runA);
    draw(runB);
    assertReset();
    setPlace(90, 60);
    draw(runB);
    assert.equal(laneScroll().scrollLeft, 90);
    assert.equal(agentScroll().scrollLeft, 60);
    assert.equal(doc.activeElement, nodeWithClass(host, 'swarm-lane-csv'));
    draw(runA);
    assertReset();
    setPlace(200, 120);
    host.replaceChildren();
    draw(runA);
    assertReset();
});

test('rendering leaves fixture CSV bytes intact', async t => {
    const { draw } = await view(t);
    const { laneResultsCsv } = await import('../public/js/swarm/run-csv.js');
    const expected = '\uFEFF#,Rate Type,Origin,Destination,Sailing Date,Container,Priority,Search,Price USD,Booking,Slots Requested,Booking Request Id,Result\r\n'
        + '1,Port,SHA,LAX,2026-12-01,40HC,high,Rate found,1350.75,"Requested, 2 slots",2,br-1,"found\nbooked"\r\n';
    assert.deepEqual(Buffer.from(laneResultsCsv(laneActivityRun)), Buffer.from(expected));
    draw(laneActivityRun);
    assert.deepEqual(Buffer.from(laneResultsCsv(laneActivityRun)), Buffer.from(expected));
});

test('progress sits between the existing running and failed header and facts', async t => {
    const { draw, host } = await view(t);
    draw(progressRun(), { showSwarmName: true, onCancel() {} });
    assert.deepEqual(host.children[0].children.map(node => [node.tag, node.textContent]), [
        ['h2', 'North'], ['span', 'running'], ['p', 'Updating every 2 seconds'], ['button', 'Cancel']
    ]);
    assert.deepEqual(host.children[2].children.map(pair => pair.children[0].textContent), [
        'Started', 'Duration', 'Spend', 'Slots', 'Master turns'
    ]);
    draw({ ...laneActivityRun, status: 'failed', summary: 'Broke', failureReason: 'Synthetic failure.' }, { showSwarmName: true });
    assert.deepEqual(host.children[0].children.map(node => [node.tag, node.textContent]), [['h2', 'North'], ['span', 'failed']]);
    assert.deepEqual(host.children[2].children.map(pair => pair.children[0].textContent), [
        'Started', 'Finished', 'Duration', 'Summary', 'Failure reason', 'Spend', 'Slots', 'Master turns'
    ]);
});
