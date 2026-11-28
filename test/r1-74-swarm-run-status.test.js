'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { click, control, hiddenDeep, install, element, mountSwarm, runRecord, swarm, tags, walk } = require('./helpers/r1-65');
const { clickToolbarAdd } = require('./helpers/r1-71');
const { laneActivityRun, laneActivityTail, shape } = require('./helpers/r1-74');

const customer = { signedIn: true, systemAdmin: false };
const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';

function customerReady(swarms, runs, onWrite) {
    return call => {
        if (call.path === '/api/swarm/access' && call.method === 'GET') return Response.json({ enabled: true });
        if (call.path === '/api/swarms' && call.method === 'GET') return Response.json({ swarms });
        if (call.path === '/api/managed-agents/options' && call.method === 'GET') return Response.json(require('./helpers/r1-65').options);
        if (call.path === '/api/swarm-runs' && call.method === 'GET') return Response.json({ runs });
        if (onWrite) return onWrite(call);
        return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
    };
}

function byClass(root, className) {
    const item = walk(root).find(node => String(node.className || '').split(/\s+/).includes(className));
    assert.ok(item, className);
    return item;
}

function labels(host) {
    return byClass(host, 'swarm-run-facts').children.map(pair => pair.children[0].textContent);
}

function visible(root, text) {
    return walk(root).some(node => !hiddenDeep(node) && node.textContent === text);
}

function chrome(container) {
    return {
        bar: byClass(container, 'agent-bar'),
        swarms: byClass(container, 'swarm-section')
    };
}

function shown(node) {
    return node.hidden !== true;
}

async function draw(t, run, options) {
    install(t);
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const host = element('div');
    renderRunDetail(host, run, options);
    return host;
}

test('a running run header leads with the name, badge, updating text and Cancel', async t => {
    const host = await draw(t, runRecord({
        status: 'running', finishedAt: null, summary: null, failureReason: null, swarmName: 'North'
    }), { showSwarmName: true, onCancel() {} });
    const header = host.children[0];
    assert.equal(header.className, 'swarm-run-header');
    assert.deepEqual(header.children.map(node => node.tag), ['h2', 'span', 'p', 'button']);
    assert.equal(header.children[0].className, 'swarm-run-title');
    assert.equal(header.children[0].textContent, 'North');
    assert.equal(header.children[1].className, 'agent-status agent-status-running');
    assert.equal(header.children[1].textContent, 'running');
    assert.equal(header.children[2].className, 'swarm-run-updating');
    assert.equal(header.children[2].textContent, 'Updating every 2 seconds');
    assert.equal(header.children[3].textContent, 'Cancel');
});

test('completed, cancel-requested and unknown statuses stay in the header', async t => {
    const completed = await draw(t, runRecord({ status: 'completed', swarmName: 'North' }), { showSwarmName: true });
    const completedHeader = completed.children[0];
    assert.deepEqual(completedHeader.children.map(node => node.tag), ['h2', 'span']);
    assert.equal(completedHeader.children[1].className, 'agent-status agent-status-completed');
    assert.equal(completedHeader.children[1].textContent, 'completed');
    assert.equal(walk(completed).some(node => node.textContent === 'Updating every 2 seconds'), false);
    assert.equal(walk(completed).some(node => node.tag === 'button' && node.textContent === 'Cancel'), false);

    const requested = await draw(t, runRecord({
        status: 'running', finishedAt: null, cancelRequested: true
    }), { showSwarmName: true });
    assert.equal(walk(requested.children[0]).some(node => node.textContent === 'Cancel requested'), true);
    assert.equal(byClass(requested, 'swarm-cancel-requested').textContent, 'Cancel requested');

    const unknown = await draw(t, runRecord({ status: 'not-a-status' }), {});
    const badge = unknown.children[0].children[0];
    assert.equal(badge.tag, 'span');
    assert.equal(badge.className, 'agent-status');
    assert.equal(badge.textContent, 'not-a-status');
});

test('the swarm name is optional and markup stays text', async t => {
    const plain = await draw(t, runRecord({ swarmName: 'North' }), {});
    assert.equal(plain.children[0].children.some(node => node.tag === 'h2'), false);

    const host = await draw(t, runRecord({ swarmName: hostile, summary: hostile, failureReason: hostile }), {
        showSwarmName: true
    });
    const title = byClass(host, 'swarm-run-title');
    assert.equal(title.tag, 'h2');
    assert.equal(title.textContent, hostile);
    assert.equal(title.children.length, 0);
    assert.equal(byClass(host, 'swarm-summary').textContent, hostile);
    assert.equal(byClass(host, 'swarm-failure-reason').textContent, hostile);
    assert.equal(tags(host).includes('script'), false);
    assert.equal(tags(host).includes('img'), false);
});

test('facts omit empty narratives and keep tokens behind showTokens', async t => {
    const running = await draw(t, runRecord({
        status: 'running', finishedAt: null, summary: '', failureReason: null
    }), {});
    assert.deepEqual(labels(running), ['Started', 'Duration', 'Spend', 'Slots', 'Master turns']);

    const failed = await draw(t, runRecord({
        status: 'failed', summary: 'Broke', failureReason: 'Synthetic failure.'
    }), {});
    assert.deepEqual(labels(failed), [
        'Started', 'Finished', 'Duration', 'Summary', 'Failure reason', 'Spend', 'Slots', 'Master turns'
    ]);
    for (const className of ['swarm-summary', 'swarm-failure-reason']) {
        assert.equal(byClass(failed, className).parent.className, 'swarm-run-fact-full');
    }
    assert.equal(byClass(failed, 'swarm-run-duration').className, 'swarm-run-duration');
    assert.equal(labels(failed).includes('Input tokens'), false);

    const tokens = await draw(t, runRecord({ status: 'failed', summary: 'Broke', failureReason: 'Synthetic failure.' }), {
        showTokens: true
    });
    assert.deepEqual(labels(tokens).slice(-2), ['Input tokens', 'Output tokens']);
    assert.equal(byClass(tokens, 'swarm-input-tokens').textContent, '111');
    assert.equal(byClass(tokens, 'swarm-output-tokens').textContent, '222');
});

test('lane results and agent activity keep the af42190 nodes', async t => {
    install(t);
    const { formatDollars } = await import('../public/js/money.js');
    const { formatWhen } = await import('../public/js/swarm/time.js');
    const time = { locale: 'en-US', timeZone: 'UTC' };
    const host = await draw(t, laneActivityRun, { time });
    const started = formatWhen(laneActivityRun.startedAt, time);
    const price = formatDollars(1350.75, '');
    const facts = byClass(host, 'swarm-run-facts');
    assert.equal(host.children[host.children.indexOf(facts) + 1].className, 'swarm-lane-heading-row');
    assert.deepEqual(
        host.children.slice(host.children.indexOf(facts) + 1).map(shape),
        laneActivityTail({ startedText: started.text, finishedText: formatWhen(laneActivityRun.finishedAt, time).text, price })
    );
});

async function fillNewSwarm(container) {
    await click(container, 'New swarm');
    control(container, 'Name').value = 'Created';
    control(container, 'Instructions').value = 'Hold course';
    await click(container, 'Next');
    await click(container, 'Next');
    await clickToolbarAdd(container);
    await click(container, 'Next');
    await click(container, 'Next');
}

test('Save and run, Back to runs, and the wizard leave one chrome state', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const running = runRecord({
        id: 'run-new', swarmId: 'swarm-new', swarmName: 'Created', status: 'running',
        finishedAt: null, summary: null, failureReason: null, cancelRequested: false
    });
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.method === 'POST' && call.path === '/api/swarms') {
                return Response.json({
                    swarm: { id: 'swarm-new', canEdit: true, updatedAt: '2026-11-23T02:00:00.000Z', ...call.body }
                });
            }
            if (call.method === 'POST' && call.path === '/api/swarms/swarm-new/runs') {
                return Response.json({ run: running });
            }
            if (call.path === '/api/swarm-runs/run-new') return Response.json({ run: running });
            return customerReady([], [])(call);
        }
    });
    await fillNewSwarm(container);
    await click(container, 'Save and run');
    let shell = chrome(container);
    assert.equal(shown(shell.bar), false);
    assert.equal(shown(shell.swarms), false);
    assert.equal(visible(container, 'Updating every 2 seconds'), true);
    await click(container, 'Back to runs');
    shell = chrome(container);
    assert.equal(shown(shell.bar), true);
    assert.equal(shown(shell.swarms), true);

    const listed = runRecord({ status: 'completed', summary: 'Listed' });
    const second = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm()], [listed], call => {
            if (call.path === '/api/swarm-runs/run-1') return Response.json({ run: listed });
            return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
        })
    });
    await click(second.container, 'Open');
    shell = chrome(second.container);
    assert.equal(shown(shell.bar), false);
    assert.equal(shown(shell.swarms), false);
    await click(second.container, 'Back to runs');
    shell = chrome(second.container);
    assert.equal(shown(shell.bar), true);
    assert.equal(shown(shell.swarms), true);
    await click(second.container, 'New swarm');
    shell = chrome(second.container);
    assert.equal(shown(shell.bar), false);
    assert.equal(shown(shell.swarms), false);
    await click(second.container, 'Cancel');
    shell = chrome(second.container);
    assert.equal(shown(shell.bar), true);
    assert.equal(shown(shell.swarms), true);
});

test('a refused start stays on the list, and Open running run hides it', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const running = runRecord({
        status: 'running', finishedAt: null, summary: 'the-live-run', cancelRequested: false
    });
    const cases = [
        {
            name: 'run_active',
            body: { error: 'A swarm run is already running.', code: 'run_active', reasons: [] }
        },
        {
            name: 'swarm_not_ready',
            body: {
                error: 'Swarm run prerequisites are missing.',
                code: 'swarm_not_ready',
                reasons: ['ANTHROPIC_API_KEY']
            }
        }
    ];
    for (const item of cases) {
        let runs = [];
        const { container } = await mountSwarm(t, {
            permissions: customer,
            respond: call => {
                if (call.method === 'POST' && call.path === '/api/swarms/swarm-1/runs') {
                    runs = [running];
                    return Response.json(item.body, { status: 409 });
                }
                if (call.path === '/api/swarm-runs/run-1') return Response.json({ run: running });
                return customerReady([swarm()], runs)(call);
            }
        });
        global.window.confirm = () => true;
        await click(container, 'Run');
        const shell = chrome(container);
        assert.equal(shown(shell.bar), true, item.name);
        assert.equal(shown(shell.swarms), true, item.name);
        assert.equal(visible(container, item.body.error), true, item.name);
        for (const reason of item.body.reasons) assert.equal(visible(container, reason), true);
        if (item.name === 'run_active') {
            await click(container, 'Open running run');
            const open = chrome(container);
            assert.equal(shown(open.bar), false);
            assert.equal(shown(open.swarms), false);
            assert.equal(visible(container, 'the-live-run'), true);
            assert.equal(visible(container, item.body.error), false);
        }
    }
});
