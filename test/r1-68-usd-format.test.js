'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { byClass, mountGrid, walk: walkAgents } = require('./helpers/r1-36');
const { click, control, element, hiddenDeep, install, lanes, mountSwarm, options, walk } = require('./helpers/r1-63');
const { runRecord, swarm } = require('./helpers/r1-65');

const customer = { signedIn: true, systemAdmin: false };
const range = (min, max) => `${min} \u2013 ${max}`;

function visibleText(root, text) {
    return walk(root).some(node => !hiddenDeep(node) && node.textContent === text);
}

function fact(root, term) {
    const label = walk(root).find(node => node.tag === 'dt' && node.textContent === term && !hiddenDeep(node));
    assert.ok(label, term);
    return label.parent.children[label.parent.children.indexOf(label) + 1].textContent;
}

function rowCells(root, name) {
    const row = walk(root).find(node => node.tag === 'tr' && !hiddenDeep(node)
        && node.children.some(cell => cell.textContent === name));
    assert.ok(row, name);
    return row.children.filter(cell => cell.tag === 'td').map(cell => cell.textContent);
}

function agentCells(root, role) {
    const row = walk(root).find(node => node.tag === 'tr' && !hiddenDeep(node)
        && node.children.some(cell => cell.textContent === role));
    assert.ok(row, role);
    return row.children.filter(cell => cell.tag === 'td').map(cell => cell.textContent);
}

function customerFetch(swarms, runs, onWrite) {
    return call => {
        if (call.path === '/api/swarm/access' && call.method === 'GET') return Response.json({ enabled: true });
        if (call.path === '/api/swarms' && call.method === 'GET') return Response.json({ swarms });
        if (call.path === '/api/managed-agents/options' && call.method === 'GET') return Response.json(options);
        if (call.path === '/api/swarm-runs' && call.method === 'GET') return Response.json({ runs });
        if (call.path.startsWith('/api/swarm-runs/') && call.method === 'GET') {
            const id = call.path.slice('/api/swarm-runs/'.length);
            return Response.json({ run: runs.find(run => run.id === id) });
        }
        if (onWrite) return onWrite(call);
        return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
    };
}

async function openReview(container, { spend, slots = '4', min = '20.5', max = '1350.75', laneSlots = '2' }) {
    await click(container, 'New swarm');
    control(container, 'Name').value = 'Review';
    control(container, 'Instructions').value = 'Hold course';
    await click(container, 'Next');
    control(container, 'Total spend cap (USD)').value = spend;
    control(container, 'Total slots cap').value = slots;
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Next');
    const row = lanes(container)[0];
    const booking = control(row, 'Allow booking');
    booking.checked = true;
    booking.events.change();
    control(row, 'Min price (USD)').value = min;
    control(row, 'Max price (USD)').value = max;
    control(row, 'Slots').value = laneSlots;
    await click(container, 'Next');
}

test('formatDollars rounds to whole dollars and returns the caller fallback', async () => {
    const { formatDollars } = await import('../public/js/money.js');
    assert.equal(formatDollars(12574), '$12,574');
    assert.equal(formatDollars(1350.5), '$1,351');
    assert.equal(formatDollars(1350.75), '$1,351');
    assert.equal(formatDollars(0), '$0');
    assert.equal(formatDollars('12574'), '$12,574');
    assert.equal(formatDollars('1350.75'), '$1,351');
    assert.equal(formatDollars(null, 'None'), 'None');
    assert.equal(formatDollars('', ''), '');
    assert.equal(formatDollars('   ', 'blank'), 'blank');
    assert.equal(formatDollars('not-money', 'keep'), 'keep');
    assert.equal(formatDollars('1,351', 'keep'), 'keep');
    for (const value of [null, '', 'not-money', Number.NaN, Number.POSITIVE_INFINITY]) {
        const shown = formatDollars(value, 'fallback');
        assert.equal(shown, 'fallback');
        assert.equal(shown.includes('NaN'), false);
        assert.notEqual(shown, '$0');
    }
});

test('agent detail shows a whole-dollar price range', async t => {
    const root = await mountGrid(t, [
        {
            id: 'whole', status: 'completed', createdAt: '2026-11-23T00:00:00.000Z',
            originPort: 'Shanghai', destinationPort: 'Long Beach', allowBookingRequest: true,
            bookingSlots: 2, priceMin: 1500, priceMax: 2000
        },
        {
            id: 'fraction', status: 'completed', createdAt: '2026-11-23T00:00:00.000Z',
            originPort: 'Busan', destinationPort: 'Tacoma', allowBookingRequest: true,
            bookingSlots: 1, priceMin: 1350.75, priceMax: 2000
        }
    ]);
    for (const button of walkAgents(root).filter(node => byClass(node, 'agent-expand'))) button.events.click();
    assert.ok(walkAgents(root).some(node => node.textContent === range('$1,500', '$2,000')));
    assert.ok(walkAgents(root).some(node => node.textContent === range('$1,351', '$2,000')));
    assert.equal(walkAgents(root).some(node => String(node.textContent).includes('$1,350.75')), false);
    assert.equal(walkAgents(root).some(node => String(node.textContent).includes('.00')), false);
});

test('swarm list formats the spend cap and leaves the slots cap plain', async t => {
    const priced = swarm({
        id: 'priced', name: 'Priced', totalSpendCap: 12574, totalSlotsCap: 12574
    });
    const open = swarm({
        id: 'open', name: 'Open cap', totalSpendCap: null, totalSlotsCap: 5
    });
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([priced, open], [])
    });
    assert.deepEqual(rowCells(container, 'Priced').slice(3, 5), ['$12,574', '12574']);
    assert.deepEqual(rowCells(container, 'Open cap').slice(3, 5), ['None', '5']);
    assert.equal(visibleText(container, '$5'), false);
    assert.equal(visibleText(container, '$12,574.00'), false);
});

test('run table and detail format spend and price, and leave slots and a missing price plain', async t => {
    const moneyRun = runRecord({
        id: 'run-money',
        swarmName: 'Money',
        totalSpendCap: 75000,
        totalSlotsCap: 10,
        spendBooked: 62870,
        slotsBooked: 5,
        agents: [
            {
                id: 'priced', role: 'booking', lanePosition: 1, attempt: 1, status: 'completed',
                originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-23',
                report: 'booked', rateId: 'rate-1', price: 1350.75, slots: 4, bookingRequestId: null
            },
            {
                id: 'blank', role: 'search', lanePosition: 2, attempt: 1, status: 'completed',
                originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-23',
                report: 'looked', rateId: null, price: null, slots: 2, bookingRequestId: null
            },
            {
                id: 'text', role: 'master', lanePosition: null, attempt: 1, status: 'completed',
                report: 'note', rateId: null, price: 'not-money', slots: null, bookingRequestId: null
            }
        ]
    });
    const openRun = runRecord({
        id: 'run-open',
        swarmName: 'Open',
        totalSpendCap: null,
        totalSlotsCap: null,
        spendBooked: 0,
        slotsBooked: 0,
        agents: []
    });
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([swarm()], [moneyRun, openRun])
    });
    assert.deepEqual(rowCells(container, 'Money').slice(5, 7), ['$62,870 / $75,000', '5 / 10']);
    assert.deepEqual(rowCells(container, 'Open').slice(5, 7), ['$0 / None', '0 / None']);
    const moneyRow = walk(container).find(node => node.tag === 'tr' && node.children.some(cell => cell.textContent === 'Money'));
    await moneyRow.children.find(node => node.tag === 'td' && walk(node).some(child => child.textContent === 'Open')).children
        .find(node => node.tag === 'button').events.click();
    assert.equal(fact(container, 'Spend'), '$62,870 / $75,000');
    assert.equal(fact(container, 'Slots'), '5 / 10');
    assert.equal(agentCells(container, 'booking')[8], '$1,351');
    assert.equal(agentCells(container, 'booking')[9], '4');
    assert.equal(agentCells(container, 'search')[8], '');
    assert.equal(agentCells(container, 'search')[9], '2');
    assert.equal(agentCells(container, 'master')[8], '');
    assert.equal(visibleText(container, '$4'), false);
    assert.equal(visibleText(container, '$2'), false);
    assert.equal(visibleText(container, '$NaN'), false);
});

test('wizard review formats money and the save body keeps the typed numbers', async t => {
    const writes = [];
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([], [], call => {
            writes.push(call);
            return Response.json({
                swarm: { id: 'swarm-new', canEdit: true, updatedAt: '2026-11-23T02:00:00.000Z', ...call.body }
            });
        })
    });
    await openReview(container, { spend: '' });
    assert.equal(fact(container, 'Total spend cap'), '');
    assert.equal(fact(container, 'Total slots cap'), '4');
    assert.equal(visibleText(container, '$0'), false);
    await click(container, 'Back');
    await click(container, 'Back');
    await click(container, 'Back');
    control(container, 'Total spend cap (USD)').value = '20.5';
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    assert.equal(fact(container, 'Total spend cap'), '$21');
    assert.equal(fact(container, 'Total slots cap'), '4');
    const summary = fact(container, 'Lane 1');
    assert.equal(summary.includes('Min $21'), true);
    assert.equal(summary.includes('Max $1,351'), true);
    assert.equal(summary.includes('Slots 2'), true);
    assert.equal(/Slots \$/.test(summary), false);
    const typed = label => {
        const labels = walk(container).filter(node => node.tag === 'label'
            && node.children.some(child => child.textContent === label));
        const laneLabel = labels.find(node => {
            for (let item = node; item; item = item.parent) {
                if (String(item.className || '').split(' ').includes('swarm-lane')) return true;
            }
            return false;
        });
        const labelNode = laneLabel || labels[0];
        assert.ok(labelNode, label);
        return labelNode.children.find(node => node.tag === 'input').value;
    };
    assert.equal(typed('Total spend cap (USD)'), '20.5');
    assert.equal(typed('Min price (USD)'), '20.5');
    assert.equal(typed('Max price (USD)'), '1350.75');
    await click(container, 'Save');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.totalSpendCap, 20.5);
    assert.equal(writes[0].body.totalSlotsCap, 4);
    assert.equal(writes[0].body.lanes[0].priceMin, 20.5);
    assert.equal(writes[0].body.lanes[0].priceMax, 1350.75);
    assert.equal(writes[0].body.lanes[0].bookingSlots, 2);
});

test('admin swarm runs show the same whole-dollar spend and price', async t => {
    install(t);
    const run = runRecord({
        swarmName: 'Admin money',
        totalSpendCap: 75000,
        totalSlotsCap: 10,
        spendBooked: 62870,
        slotsBooked: 5,
        inputTokens: 111,
        outputTokens: 222,
        agents: [{
            id: 'priced', role: 'booking', lanePosition: 1, attempt: 1, status: 'completed',
            originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-23',
            report: 'booked', rateId: 'rate-1', price: 1350.75, slots: 4, bookingRequestId: null
        }]
    });
    const company = { companyId: 'c1', name: 'Alpha Synthetic', runCount: 1, lastStartedAt: run.startedAt, running: false };
    t.mock.method(global, 'fetch', path => {
        if (path === '/api/admin/swarm-runs/companies') return Response.json({ companies: [company] });
        if (path === '/api/admin/swarm-runs?companyId=c1') return Response.json({ runs: [run] });
        if (path === '/api/admin/swarm-runs/run-1') return Response.json({ run });
        return Response.json({ error: `unexpected ${path}` }, { status: 500 });
    });
    const container = element('main');
    const { mount, unmount } = await import('../public/js/admin/swarm-runs.js');
    t.after(unmount);
    await mount(container);
    await click(container, 'Alpha Synthetic');
    assert.deepEqual(rowCells(container, 'Admin money').slice(5, 7), ['$62,870 / $75,000', '5 / 10']);
    await click(container, 'Open');
    assert.equal(fact(container, 'Spend'), '$62,870 / $75,000');
    assert.equal(fact(container, 'Slots'), '5 / 10');
    assert.equal(fact(container, 'Input tokens'), '111');
    assert.equal(fact(container, 'Output tokens'), '222');
    assert.equal(agentCells(container, 'booking')[8], '$1,351');
    assert.equal(agentCells(container, 'booking')[9], '4');
});
