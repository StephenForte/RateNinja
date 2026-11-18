'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { PAYLOAD } = require('./helpers/r1-35');
const { byClass, mountGrid, walk } = require('./helpers/r1-36');

it('renders a completed summary as text, links to booking requests, and omits both for a queued agent', async t => {
    const created = '2026-11-18T21:30:00.000Z';
    const shared = { createdAt: created, originPort: 'SHA', destinationPort: 'LAX' };
    const agents = [
        { ...shared, id: 'done', status: 'completed', finishedAt: created, resultSummary: PAYLOAD, bookingRequestId: 'synthetic-booking' },
        { ...shared, id: 'waiting', status: 'queued', finishedAt: null, resultSummary: null, bookingRequestId: null }
    ];
    const container = await mountGrid(t, agents);
    for (const expand of walk(container).filter(node => byClass(node, 'agent-expand'))) expand.events.click();
    const [completed, queued] = walk(container).filter(node => byClass(node, 'agent-grid-detail'));
    assert.equal(completed.hidden, false);
    assert.equal(queued.hidden, false);
    const done = walk(completed);
    assert.equal(done.find(node => node.className === 'agent-result-summary').textContent, PAYLOAD);
    assert.equal(done.some(node => node.tag === 'img'), false);
    assert.ok(done.some(node => node.textContent === 'Finished'));
    assert.equal(done.find(node => node.tag === 'a').href, '/profile/booking-requests');
    assert.ok(walk(queued).every(node => node.tag !== 'a' && node.textContent !== 'Finished'
        && node.className !== 'agent-result-summary'));
});
