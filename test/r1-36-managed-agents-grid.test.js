'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { byClass, mountGrid, walk } = require('./helpers/r1-36');

const createdAt = '2026-11-18T21:30:00.000Z';
const finishedAt = '2026-11-18T22:30:00.000Z';
const summary = '<img src=x onerror=alert(1)> Departure confirmed.';
const creator = '<b>x</b>';
const agents = [
    {
        id: 'done', status: 'completed', createdAt, startedAt: createdAt, finishedAt,
        originPort: 'Shanghai', destinationPort: 'Long Beach', rateType: 'Port to Port',
        sailingDate: '2026-12-05', containerType: '40HC', companyName: 'Blue Freight',
        creatorName: creator, resultSummary: summary, bookingRequestId: 'synthetic-booking',
        allowAlternativeRoutes: true, allowBookingRequest: true, bookingSlots: 2,
        priceMin: 1500, priceMax: 2000, savedQueryId: 'synthetic-saved-query'
    },
    {
        id: 'queued', status: 'queued', createdAt, creatorName: 'Jordan', originPort: 'Busan',
        destinationPort: 'Tacoma', containerType: '20D', companyName: 'Green Freight', canEdit: true
    },
    {
        id: 'failed', status: 'failed', createdAt, creatorName: 'Jordan', originPort: 'Ningbo',
        destinationPort: 'Oakland', containerType: '20D', companyName: 'Green Freight', canDelete: true
    }
];

function findAll(root, name) {
    return walk(root).filter(node => byClass(node, name));
}

function findText(root, value) {
    return walk(root).find(node => node.textContent === value);
}

function ids(root) {
    return findAll(root, 'agent-expand').map(node => node.attributes['aria-controls'].replace('agent-detail-', ''));
}

function search(root, value) {
    const input = walk(root).find(node => node.type === 'search');
    input.value = value;
    input.events.input();
}

function select(root, name) {
    return walk(root).find(node => node.tag === 'label' && findText(node, name))?.children[1];
}

function filter(root, name, value) {
    const control = select(root, name);
    assert.ok(control.children.some(option => option.value === value), value);
    control.value = value;
    control.events.change();
}

function sort(root, label) {
    const control = findAll(root, 'agent-sort').find(node => node.attributes['aria-label'].startsWith('Sort by ' + label));
    control.events.click();
}

it('renders one row per agent and opens independent keyboard-operable detail controls', async t => {
    const root = await mountGrid(t, agents);
    assert.equal(findAll(root, 'agent-grid-row').length, agents.length);
    const controls = findAll(root, 'agent-expand');
    const panels = findAll(root, 'agent-grid-detail');
    for (const [i, control] of controls.entries()) {
        assert.equal(control.tag, 'button');
        assert.equal(control.type, 'button');
        assert.equal(control.attributes['aria-expanded'], 'false');
        assert.equal(panels[i].hidden, true);
        assert.ok(walk(panels[i]).some(node => node.id === control.attributes['aria-controls']));
        control.events.click();
        assert.equal(control.attributes['aria-expanded'], 'true');
        assert.equal(panels[i].hidden, false);
    }
    assert.ok(panels.every(panel => !panel.hidden));
    controls[0].events.click();
    assert.equal(controls[0].attributes['aria-expanded'], 'false');
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);
    for (const value of ['Alternative routes', 'Booking request', 'Slots', '$1,500 – $2,000',
        'synthetic-saved-query', 'Started', 'Finished', summary]) {
        assert.ok(findText(panels[0], value), value);
    }
    assert.deepEqual(panels.map(panel => walk(panel).find(node => node.tag === 'a')?.href),
        ['/profile/booking-requests', undefined, undefined]);
    assert.deepEqual(panels.map(panel => findAll(panel, 'agent-button').map(node => node.textContent)),
        [[], ['Edit'], ['Delete']]);
});

it('searches every specified field as case-insensitive literal text and resets an empty result', async t => {
    const root = await mountGrid(t, agents);
    for (const term of ['ANGHA', 'BEACH', 'ORT TO PO', 'BLUE FREIGHT', '<B>X</B>', 'DEPARTURE CONFIRMED', '<IMG SRC=']) {
        search(root, term);
        assert.deepEqual(ids(root), ['done'], term);
        assert.equal(findAll(root, 'agent-count')[0].textContent, 'Showing 1 of 3 agents');
        assert.ok(findText(root, creator));
        assert.ok(findText(root, summary));
        assert.ok(walk(root).every(node => node.tag !== 'img' && node.tag !== 'b'));
    }
    search(root, 'unmatched');
    assert.deepEqual(ids(root), []);
    assert.equal(findText(root, 'No agents match').hidden, false);
    assert.equal(findAll(root, 'agent-count')[0].textContent, 'Showing 0 of 3 agents');
    findText(root, 'Reset filters and search').events.click();
    assert.deepEqual(ids(root), ['done', 'queued', 'failed']);
    assert.equal(findText(root, 'No agents match').hidden, true);
    assert.equal(findAll(root, 'agent-count')[0].textContent, 'Showing 3 of 3 agents');
});

it('derives filter options from loaded agents and combines every filter with search', async t => {
    const root = await mountGrid(t, agents);
    assert.deepEqual(select(root, 'Status').children.map(option => option.value), ['', 'completed', 'failed', 'queued']);
    for (const [name, value, expected] of [
        ['Status', 'failed', ['failed']], ['Container', '20D', ['queued', 'failed']],
        ['Booking', 'On', ['done']], ['Booking', 'Off', ['queued', 'failed']],
        ['Creator', creator, ['done']], ['Company', 'Green Freight', ['queued', 'failed']]
    ]) {
        filter(root, name, value);
        assert.deepEqual(ids(root), expected);
        filter(root, name, '');
    }
    filter(root, 'Booking', 'Off');
    filter(root, 'Creator', 'Jordan');
    filter(root, 'Container', '20D');
    filter(root, 'Company', 'Green Freight');
    filter(root, 'Status', 'queued');
    search(root, 'busan');
    assert.deepEqual(ids(root), ['queued']);
    search(root, 'ningbo');
    assert.deepEqual(ids(root), []);
    findText(root, 'Reset filters and search').events.click();
    assert.deepEqual(ids(root), ['done', 'queued', 'failed']);
});

it('omits the company header and filter for a payload without company names', async t => {
    const root = await mountGrid(t, agents.map(({ companyName, ...agent }) => agent));
    assert.equal(select(root, 'Company'), undefined);
    assert.equal(walk(root).some(node => node.tag === 'th' && findText(node, 'Company')), false);
    assert.equal(findAll(root, 'agent-grid-row')[0].children.length, 10);
});

it('includes the company header and filter when the server supplies company names', async t => {
    const root = await mountGrid(t, agents);
    assert.ok(select(root, 'Company'));
    assert.ok(walk(root).some(node => node.tag === 'th' && findText(node, 'Company')));
    assert.equal(findAll(root, 'agent-grid-row')[0].children.length, 11);
});

for (const [label, key, low, high] of [
    ['Created', 'createdAt', createdAt, finishedAt],
    ['Sailing date', 'sailingDate', '2026-02-01', '2026-10-01'],
    ['Finished', 'finishedAt', createdAt, finishedAt],
    ['Status', 'status', 'completed', 'queued'],
    ['Origin', 'originPort', 'Busan', 'Shanghai'],
    ['Destination', 'destinationPort', 'Oakland', 'Tacoma']
]) {
    it(`sorts by ${label} in both directions with stable ties and missing values last`, async t => {
        const root = await mountGrid(t, [
            { id: 'missing', createdAt, [key]: null },
            { id: 'low-first', createdAt, [key]: low },
            { id: 'high', createdAt, [key]: high },
            { id: 'low-second', createdAt, [key]: low },
            { id: 'empty', createdAt, [key]: '' }
        ]);
        const descending = ['high', 'low-first', 'low-second', 'missing', 'empty'];
        const ascending = ['low-first', 'low-second', 'high', 'missing', 'empty'];
        if (key === 'createdAt') assert.deepEqual(ids(root), descending);
        sort(root, label);
        assert.deepEqual(ids(root), ascending);
        sort(root, label);
        assert.deepEqual(ids(root), descending);
    });
}

it('preserves filters, search and sort when deletion rerenders the shorter list', async t => {
    const root = await mountGrid(t, agents, (path, options) => {
        assert.equal(path, '/api/managed-agents/failed');
        assert.equal(options.method, 'DELETE');
        return new Response(null, { status: 204 });
    });
    filter(root, 'Status', 'failed');
    filter(root, 'Booking', 'Off');
    search(root, 'ningbo');
    sort(root, 'Origin');
    sort(root, 'Origin');
    assert.deepEqual(ids(root), ['failed']);
    findAll(root, 'agent-expand')[0].events.click();
    await findText(root, 'Delete').events.click();
    assert.deepEqual(ids(root), []);
    assert.equal(findAll(root, 'agent-count')[0].textContent, 'Showing 0 of 2 agents');
    assert.equal(select(root, 'Status').value, 'failed');
    assert.equal(select(root, 'Booking').value, 'Off');
    assert.equal(walk(root).find(node => node.type === 'search').value, 'ningbo');
    assert.equal(findAll(root, 'agent-sort').find(node => node.attributes['aria-pressed'] === 'true').textContent, 'Origin ↓');
    findText(root, 'Reset filters and search').events.click();
    assert.deepEqual(ids(root), ['done', 'queued']);
    assert.equal(select(root, 'Status').children.some(option => option.value === 'failed'), false);
});
