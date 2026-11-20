'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { it } = require('node:test');
const { byClass, mountGrid, walk } = require('./helpers/r1-36');

const listPath = '/api/managed-agents';
const latestPath = `${listPath}/runs/latest`;
const queued = {
    id: 'first', originPort: 'SHA', destinationPort: 'LAX', containerType: '20D',
    status: 'queued', canDelete: true
};
const second = { ...queued, id: 'second', destinationPort: 'OAK' };

function find(container, className) {
    return walk(container).find(node => byClass(node, className));
}

function statuses(container) {
    return walk(container).filter(node => byClass(node, 'agent-status')).map(node => node.textContent);
}

function run(status, disabledReason = 'A run is already in progress.') {
    return {
        run: { id: 'run-1', status },
        readiness: { queuedCount: 2, nextPostAt: '2026-11-21T00:17:00.000Z', disabledReason }
    };
}

async function poll(t, ms = 2000) {
    t.mock.timers.tick(ms);
    await settle();
}

async function fixture(t, agents, runs, onRequest, formOptions) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const container = await mountGrid(t, agents, onRequest, runs, formOptions);
    const requests = path => global.fetch.mock.calls.filter(call => call.arguments[0] === path).length;
    return { container, requests };
}

it('refreshes on each running poll and on the terminal poll, then stops', async t => {
    let rows = [queued, second];
    let runStatus = 'running';
    const { container, requests } = await fixture(t, () => rows, () => run(runStatus));

    assert.deepEqual(statuses(container), ['queued', 'queued']);
    rows = [{ ...queued, status: 'running' }, second];
    await poll(t);
    assert.deepEqual(statuses(container), ['running', 'queued']);
    assert.equal(requests(listPath), 2);
    assert.equal(requests(latestPath), 2);

    rows = [{ ...queued, status: 'completed' }, { ...second, status: 'running' }];
    await poll(t);
    assert.deepEqual(statuses(container), ['completed', 'running']);
    assert.equal(requests(listPath), 3);
    assert.equal(requests(latestPath), 3);

    runStatus = 'succeeded';
    rows = [rows[0], { ...second, status: 'completed' }];
    await poll(t);
    assert.deepEqual(statuses(container), ['completed', 'completed']);
    assert.equal(find(container, 'agent-run-status').textContent, 'Status: succeeded');
    assert.equal(requests(listPath), 4);
    assert.equal(requests(latestPath), 4);
    await poll(t, 10000);
    assert.equal(requests(listPath), 4);
    assert.equal(requests(latestPath), 4);
});

it('preserves expanded rows, search, filters, sort and the open form', async t => {
    let rows = [queued, second];
    const { container } = await fixture(t, () => rows, run('running'));
    const filters = find(container, 'agent-filters');
    const search = walk(filters).find(node => node.type === 'search');
    const containerFilter = walk(filters).filter(node => node.tag === 'select')[1];
    search.value = 'SHA';
    search.events.input();
    containerFilter.value = '20D';
    containerFilter.events.change();
    const sort = walk(container).find(node => node.textContent === 'Destination');
    sort.events.click();
    sort.events.click();
    walk(container).find(node => node.attributes['aria-controls'] === 'agent-detail-first').events.click();
    walk(container).find(node => node.textContent === 'New agent').events.click();
    const form = find(container, 'agent-form-host').children[0];

    rows = [{ ...queued, status: 'running' }, second, { ...queued, id: 'other', originPort: 'NGB' }];
    await poll(t);
    assert.equal(search.value, 'SHA');
    assert.equal(containerFilter.value, '20D');
    assert.equal(sort.attributes['aria-label'], 'Sort by Destination, currently descending');
    assert.deepEqual(statuses(container), ['queued', 'running']);
    assert.equal(walk(container).find(node => node.attributes['aria-controls'] === 'agent-detail-first')
        .attributes['aria-expanded'], 'true');
    assert.equal(find(container, 'agent-form-host').children[0], form);
});

it('discards a list response that arrives after a local delete', async t => {
    const stale = Promise.withResolvers();
    let reads = 0;
    const { container, requests } = await fixture(t, () => ++reads === 1 ? [queued, second] : stale.promise,
        run('running'), (path, options) => {
            assert.equal(path, `${listPath}/first`);
            assert.equal(options.method, 'DELETE');
            return new Response(null, { status: 204 });
        });

    await poll(t);
    assert.equal(requests(listPath), 2);
    await poll(t);
    assert.equal(requests(listPath), 2);
    assert.equal(requests(latestPath), 2);
    find(container, 'agent-expand').events.click();
    await find(container, 'agent-delete').events.click();
    await settle();
    assert.deepEqual(statuses(container), ['queued']);

    stale.resolve([queued, { ...second, status: 'running' }]);
    await settle();
    assert.deepEqual(statuses(container), ['queued']);
});

it('keeps a local delete and applies other final statuses from the same terminal poll', async t => {
    const finalRows = Promise.withResolvers();
    let listReads = 0;
    let runReads = 0;
    const { container, requests } = await fixture(t,
        () => ++listReads === 1 ? [queued, second] : finalRows.promise,
        () => ++runReads === 1 ? run('running') : run('succeeded', null),
        (path, options) => {
            assert.equal(path, `${listPath}/first`);
            assert.equal(options.method, 'DELETE');
            return new Response(null, { status: 204 });
        });

    await poll(t);
    assert.equal(requests(listPath), 2);
    find(container, 'agent-expand').events.click();
    await find(container, 'agent-delete').events.click();
    finalRows.resolve([{ ...queued, status: 'completed' }, { ...second, status: 'completed' }]);
    await settle();

    assert.deepEqual(statuses(container), ['completed']);
    assert.equal(find(container, 'agent-run-status').textContent, 'Status: succeeded');
    await poll(t, 10000);
    assert.equal(requests(listPath), 2);
    assert.equal(requests(latestPath), 3);
});

it('keeps one copy when a poll sees a newly queued agent before the create response', async t => {
    const pending = Promise.withResolvers();
    const formOptions = {
        rateTypes: ['FAK'],
        containerTypes: ['20D'],
        today: '2026-11-20',
        lanes: [{
            rateType: 'FAK', originPort: 'SHA', destinationPort: 'LAX',
            windows: [{ start: '2026-11-20', end: '2026-11-30' }]
        }]
    };
    let rows = [];
    const { container } = await fixture(t, () => rows, run('running'), (path, options) => {
        assert.equal(path, listPath);
        assert.equal(options.method, 'POST');
        return pending.promise;
    }, formOptions);
    walk(container).find(node => node.textContent === 'New agent').events.click();
    const form = find(container, 'agent-form-host').children[0];
    const submitting = form.events.submit({ preventDefault() {} });

    rows = [{ ...queued, status: 'running' }];
    await poll(t);
    assert.deepEqual(statuses(container), ['running']);

    pending.resolve(Response.json({ agents: [queued] }, { status: 201 }));
    await submitting;
    assert.deepEqual(statuses(container), ['running']);
});

it('keeps rows and reports a failed list read in the run panel until recovery', async t => {
    const error = 'Temporary list failure.';
    let rows = [queued];
    const { container, requests } = await fixture(t, () => rows, run('running'));
    rows = Response.json({ error }, { status: 503 });

    await poll(t);
    assert.deepEqual(statuses(container), ['queued']);
    assert.equal(find(container, 'agent-run-alert').textContent, error);
    assert.equal(find(container, 'error').hidden, true);

    rows = [{ ...queued, status: 'running' }];
    await poll(t);
    assert.deepEqual(statuses(container), ['running']);
    assert.equal(find(container, 'agent-run-alert').textContent, '');
    assert.equal(find(container, 'error').hidden, true);
    assert.equal(requests(listPath), 3);
});

it('does not poll for a non-admin after the initial run access check', async t => {
    const { container, requests } = await fixture(t, [queued], null);

    await poll(t, 10000);
    assert.equal(find(container, 'agent-run'), undefined);
    assert.equal(requests(latestPath), 1);
    assert.equal(requests(listPath), 1);
});

it('stops polling on unmount and ignores an in-flight list response', async t => {
    const pending = Promise.withResolvers();
    let reads = 0;
    const { container, requests } = await fixture(t, () => ++reads === 1 ? [queued] : pending.promise,
        run('running'));
    const { unmount } = await import('../public/js/agents/managed-agents.js');

    await poll(t);
    assert.equal(requests(listPath), 2);
    unmount();
    pending.resolve([{ ...queued, status: 'running' }]);
    await poll(t, 10000);
    assert.deepEqual(statuses(container), ['queued']);
    assert.equal(requests(listPath), 2);
    assert.equal(requests(latestPath), 2);
});
