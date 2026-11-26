'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { click, element, install, lane, options, runRecord, swarm, tags } = require('./helpers/r1-65');
const { byClass, factValues, openReview } = require('./helpers/r1-72');

const bookingLane = lane({
    allowBookingRequest: true, allowAlternativeRoutes: true, priceMin: 20.5, priceMax: 1350.75,
    bookingSlots: 2, acceptMaxSlots: true, priority: 'high', dateFlexDays: 3
});
const reviewTerms = ['Name', 'Total spend cap', 'Total slots cap', 'Lanes'];

test('Review pairs four facts and groups 25 ordered lanes by column', async t => {
    const origins = Array.from({ length: 25 }, (_, index) => `Port ${index + 1}`);
    const laneOptions = {
        ...options,
        lanes: origins.map(originPort => ({ ...options.lanes[0], originPort }))
    };
    const { review } = await openReview(t, swarm({
        totalSpendCap: 12574.25,
        totalSlotsCap: 125,
        lanes: origins.map((originPort, index) => ({ ...(index === 0 ? bookingLane : lane()), originPort }))
    }), laneOptions);

    const values = factValues(byClass(review, 'agent-details'), reviewTerms);
    assert.deepEqual(values.map(node => node.textContent), ['North', '$12,574', '125', '25']);
    assert.equal(values[0].className, 'swarm-name');

    const table = byClass(review, 'swarm-review-lanes');
    const [head, body] = table.children;
    assert.equal(table.parent.className, 'agent-grid-scroll');
    assert.equal(table.parent.tabIndex, 0);
    assert.equal(review.children[review.children.indexOf(table.parent) - 1].textContent, 'Lanes');
    assert.deepEqual(head.children[0].children.map(cell => cell.textContent), [
        '#', 'Lane', 'Sailing date', 'Container', 'Priority', 'Alternatives', 'Date flex',
        'Booking', 'Min', 'Max', 'Slots', 'AI slots'
    ]);
    const rows = body.children.map(row => row.children.map(cell => cell.textContent));
    assert.deepEqual(rows, origins.map((origin, index) => [
        String(index + 1), `Port ${origin} → LAX`, options.today, '40HC',
        ...(index === 0
            ? ['high', 'Yes', '3', 'Yes', '$21', '$1,351', '2', 'Yes']
            : ['normal', 'No', '0', 'No', '', '', '', ''])
    ]));
});

test('Review shows multiline instructions literally under the Instructions heading', async t => {
    const instructions = 'First line\n<img src=x onerror=alert(1)>\nFinal line';
    const { review } = await openReview(t, swarm({ instructions }));
    const content = byClass(review, 'swarm-instructions');
    const heading = review.children[review.children.indexOf(content) - 1];
    assert.equal(heading.tag, 'h4');
    assert.equal(heading.textContent, 'Instructions');
    assert.equal(content.textContent, instructions);
    assert.equal(content.children.length, 0);
    assert.equal(tags(review).includes('img'), false);
});

test('Review shows a dash for empty instructions and None for unused caps', async t => {
    const { review } = await openReview(t, swarm());
    assert.equal(byClass(review, 'swarm-instructions').textContent, '—');
    const values = factValues(byClass(review, 'agent-details'), reviewTerms);
    assert.deepEqual(values.map(node => node.textContent), ['North', 'None', 'None', '1']);
});

test('Run facts pair every value and span narrative facts across the grid', async t => {
    install(t);
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const host = element('main');
    const run = runRecord({ status: 'failed', failureReason: 'Synthetic failure.' });
    const baseTerms = ['Status', 'Started', 'Finished', 'Duration', 'Summary', 'Failure reason', 'Spend', 'Slots', 'Master turns'];
    const time = { locale: 'en-US', timeZone: 'UTC' };

    renderRunDetail(host, run, { time, showTokens: true });
    const [status, started, finished, duration, summary, failure, spend, slots, turns, input, output] =
        factValues(byClass(host, 'swarm-run-facts'), [...baseTerms, 'Input tokens', 'Output tokens']);
    assert.equal(status.textContent, 'failed');
    assert.equal(started.attributes.title, run.startedAt);
    assert.equal(finished.attributes.title, run.finishedAt);
    assert.equal(duration.className, 'swarm-run-duration');
    assert.equal(summary.className, 'swarm-summary');
    assert.equal(failure.className, 'swarm-failure-reason');
    for (const fact of [summary, failure]) assert.equal(fact.parent.className, 'swarm-run-fact-full');
    assert.equal(summary.textContent, run.summary);
    assert.equal(failure.textContent, run.failureReason);
    assert.equal(spend.textContent, '$12 / $40');
    assert.equal(slots.textContent, '1 / 3');
    assert.equal(turns.textContent, '4');
    assert.equal(input.className, 'swarm-input-tokens');
    assert.equal(output.className, 'swarm-output-tokens');
    assert.equal(input.textContent, '111');
    assert.equal(output.textContent, '222');

    renderRunDetail(host, run, { time });
    factValues(byClass(host, 'swarm-run-facts'), baseTerms);
});

test('Saving after Review sends the original policy and exact monetary amounts', async t => {
    const instructions = 'First line\nSecond line';
    const searchLane = lane({ priority: 'low', dateFlexDays: 2 });
    const { host } = await openReview(t, swarm({
        name: '  North  ', instructions, totalSpendCap: 12574.25, totalSlotsCap: 125,
        lanes: [bookingLane, searchLane]
    }));
    const fetch = t.mock.method(global, 'fetch', async () => Response.json({ swarm: { id: 'swarm-1' } }));
    await click(host, 'Save');
    assert.equal(fetch.mock.callCount(), 1);
    const [path, request] = fetch.mock.calls[0].arguments;
    assert.equal(path, '/api/swarms/swarm-1');
    assert.equal(request.method, 'PUT');
    assert.deepEqual(JSON.parse(request.body), {
        name: 'North', instructions, totalSpendCap: 12574.25, totalSlotsCap: 125,
        lanes: [bookingLane, searchLane]
    });
});
