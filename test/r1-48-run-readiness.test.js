'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { it } = require('node:test');
const { byClass, mountGrid, walk } = require('./helpers/r1-36');

const listPath = '/api/managed-agents';
const runsPath = `${listPath}/runs`;
const latestPath = `${runsPath}/latest`;
const emptyReason = 'No queued managed agents.';
const queued = {
    id: 'first', rateType: 'FAK', originPort: 'SHA', destinationPort: 'LAX',
    containerType: '20D', sailingDate: '2026-11-20', status: 'queued', canEdit: true, canDelete: true
};
const formOptions = {
    canManageAgents: true, rateTypes: ['FAK'], containerTypes: ['20D'], savedQueries: [], today: '2026-11-20',
    lanes: [{
        rateType: 'FAK', originPort: 'SHA', destinationPort: 'LAX',
        windows: [{ start: '2026-11-20', end: '2026-11-30' }]
    }]
};
const acceptedRun = { id: 'run-1', status: 'running', startedAt: '2026-11-20T12:00:00.000Z' };

function readiness(queuedCount) {
    return {
        run: null,
        readiness: { queuedCount, nextPostAt: '2026-11-21T00:17:00.000Z', disabledReason: queuedCount ? null : emptyReason }
    };
}

function button(container, label) {
    return walk(container).find(node => node.tag === 'button' && node.textContent === label);
}

function selectRateType(container) {
    const label = walk(container).find(node => node.tag === 'label' && node.children[0]?.textContent === 'Rate type');
    const select = label.children[1];
    select.value = 'FAK';
    select.events.change();
}

async function fixture(t, latest, initial = []) {
    let creates = 0;
    const container = await mountGrid(t, initial, (path, options) => {
        if (path === listPath && options.method === 'POST') {
            creates += 1;
            return Response.json({ agents: [{ ...queued, id: `created-${creates}` }] }, { status: 201 });
        }
        if (path === `${listPath}/options?agentId=first` && !options?.method) return Response.json(formOptions);
        if (path === `${listPath}/first` && options.method === 'PUT') return Response.json({ agent: queued });
        if (path === `${listPath}/first` && options.method === 'DELETE') return new Response(null, { status: 204 });
        if (path === runsPath && options.method === 'POST') return Response.json({ run: acceptedRun }, { status: 202 });
        assert.fail(`Unexpected request to ${path}`);
    }, latest, formOptions);
    const find = name => walk(container).find(node => byClass(node, name));
    const requests = (path, method) => global.fetch.mock.calls.filter(({ arguments: [url, options] }) =>
        url === path && (options?.method ?? 'GET') === method).length;
    return {
        container, find, requests,
        runButton: button(container, 'Run queued agents'),
        submit: label => find('agent-form-host').children[0].events.submit({
            preventDefault() {}, submitter: button(container, label)
        })
    };
}

function confirmText(control) {
    let message;
    window.confirm = text => {
        message = text;
        return false;
    };
    control.events.click();
    return message;
}

it('enables the idle run button after creating an agent without reading the list or starting a timer', async t => {
    const timer = t.mock.method(global, 'setInterval');
    let count = 0;
    const { container, find, requests, runButton, submit } = await fixture(t, () => readiness(count));
    assert.equal(runButton.disabled, true);
    assert.equal(find('agent-run-reason').textContent, emptyReason);

    button(container, 'New agent').events.click();
    count = 1;
    await submit('Queue agent');
    await settle();

    assert.equal(requests(latestPath, 'GET'), 2);
    assert.equal(requests(listPath, 'GET'), 1);
    assert.equal(timer.mock.callCount(), 0);
    assert.equal(runButton.disabled, false);
    assert.equal(find('agent-run-reason').textContent, '');
    assert.match(confirmText(runButton), /Run 1 queued agent\?/);
});

it('reads again after an in-flight readiness read when a second create succeeds', async t => {
    const first = Promise.withResolvers();
    const responses = [readiness(0), first.promise, readiness(2)];
    const { container, requests, runButton, submit } = await fixture(t, () => responses.shift());
    button(container, 'New agent').events.click();
    await submit('Queue and add another');
    assert.equal(requests(latestPath, 'GET'), 2);
    selectRateType(container);
    await submit('Queue and add another');
    assert.equal(requests(listPath, 'POST'), 2);
    assert.equal(requests(latestPath, 'GET'), 2);

    first.resolve(readiness(1));
    await settle();
    assert.equal(requests(latestPath, 'GET'), 3);
    assert.equal(runButton.disabled, false);
    assert.match(confirmText(runButton), /Run 2 queued agents\?/);
});

it('coalesces multiple successful writes during a failed read into one follow-up', async t => {
    const first = Promise.withResolvers();
    const responses = [readiness(0), first.promise, readiness(3)];
    const { container, find, requests, runButton, submit } = await fixture(t, () => responses.shift());
    button(container, 'New agent').events.click();
    await submit('Queue and add another');
    selectRateType(container);
    await submit('Queue and add another');
    selectRateType(container);
    await submit('Queue and add another');
    assert.equal(requests(listPath, 'POST'), 3);
    assert.equal(requests(latestPath, 'GET'), 2);

    first.resolve(Response.json({ error: 'Temporary readiness failure.' }, { status: 503 }));
    await settle();
    assert.equal(requests(latestPath, 'GET'), 3);
    assert.equal(find('agent-run-alert').textContent, '');
    assert.match(confirmText(runButton), /Run 3 queued agents\?/);
});

it('keeps an accepted run when an older readiness response arrives and the start refresh fails', async t => {
    const first = Promise.withResolvers();
    const message = 'Temporary start refresh failure.';
    const responses = [readiness(1), first.promise, Response.json({ error: message }, { status: 503 })];
    const { container, find, requests, runButton, submit } = await fixture(t, () => responses.shift(), [queued]);
    button(container, 'New agent').events.click();
    await submit('Queue agent');
    runButton.events.click();
    await settle();
    assert.equal(requests(runsPath, 'POST'), 1);
    assert.equal(requests(latestPath, 'GET'), 2);
    assert.equal(find('agent-run-status').textContent, 'Status: running');

    first.resolve(readiness(2));
    await settle();
    assert.equal(requests(latestPath, 'GET'), 3);
    assert.equal(requests(listPath, 'GET'), 2);
    assert.equal(find('agent-run-status').textContent, 'Status: running');
    assert.equal(find('agent-run-alert').textContent, message);
    assert.equal(runButton.disabled, true);
});

it('disables the run button with the server reason after deleting the last queued agent', async t => {
    let count = 1;
    const { find, requests, runButton } = await fixture(t, () => readiness(count), [queued]);
    assert.equal(runButton.disabled, false);
    find('agent-expand').events.click();
    count = 0;
    await find('agent-delete').events.click();
    await settle();

    assert.equal(requests(`${listPath}/first`, 'DELETE'), 1);
    assert.equal(requests(latestPath, 'GET'), 2);
    assert.equal(runButton.disabled, true);
    assert.equal(find('agent-run-reason').textContent, emptyReason);
});

it('does not read readiness after editing an existing agent', async t => {
    const { container, find, requests, submit } = await fixture(t, readiness(1), [queued]);
    find('agent-expand').events.click();
    await button(container, 'Edit').events.click();
    await submit('Save changes');
    await settle();

    assert.equal(requests(`${listPath}/first`, 'PUT'), 1);
    assert.equal(requests(latestPath, 'GET'), 1);
});

it('does not read readiness after a non-admin creates an agent', async t => {
    const { container, requests, runButton, submit } = await fixture(t, null);
    assert.equal(runButton, undefined);
    button(container, 'New agent').events.click();
    await submit('Queue agent');
    await settle();

    assert.equal(requests(listPath, 'POST'), 1);
    assert.equal(requests(latestPath, 'GET'), 1);
});

it('reports a failed refresh in the run panel and retains the last readiness', async t => {
    const message = 'Temporary readiness failure.';
    const responses = [readiness(1), Response.json({ error: message }, { status: 503 })];
    const { container, find, requests, runButton, submit } = await fixture(t, () => responses.shift(), [queued]);
    button(container, 'New agent').events.click();
    await submit('Queue agent');
    await settle();

    assert.equal(requests(latestPath, 'GET'), 2);
    assert.equal(find('agent-run-alert').textContent, message);
    assert.equal(find('error').hidden, true);
    assert.equal(runButton.disabled, false);
    assert.equal(find('agent-run-reason').textContent, '');
    assert.match(confirmText(runButton), /Run 1 queued agent\?/);
});
