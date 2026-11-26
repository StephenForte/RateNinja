'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { test } = require('node:test');
const { clickToolbarAdd } = require('./helpers/r1-71');
const { click, control, hiddenDeep, install, mountSwarm, options, runRecord, swarm, tags, walk } = require('./helpers/r1-65');

const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const customer = { signedIn: true, systemAdmin: false };

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

function visibleText(root, text) {
    return walk(root).some(node => !hiddenDeep(node) && node.textContent === text);
}

function buttons(root, name) {
    return walk(root).filter(node => node.tag === 'button' && node.textContent === name && !hiddenDeep(node));
}

async function flush() {
    for (let count = 0; count < 6; count += 1) await settle();
}

async function tick(t, ms = 2000) {
    t.mock.timers.tick(ms);
    await flush();
}

test('hostile run text is shown as text and the only link is the booking requests page', async t => {
    const run = runRecord({
        swarmName: hostile,
        summary: hostile,
        failureReason: hostile,
        totalSpendCap: null,
        totalSlotsCap: null,
        spendBooked: 0,
        slotsBooked: 0,
        agents: [
            {
                id: 'master-1', role: 'master', lanePosition: null, attempt: 1, status: 'completed',
                originPort: null, destinationPort: null, sailingDate: null,
                startedAt: '2026-11-23T01:00:00.000Z', finishedAt: '2026-11-23T01:05:00.000Z',
                report: hostile, rateId: null, price: null, slots: null, bookingRequestId: null
            },
            {
                id: 'book-1', role: 'booking', lanePosition: 1, attempt: 1, status: 'completed',
                originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-23',
                startedAt: '2026-11-23T01:01:00.000Z', finishedAt: '2026-11-23T01:02:00.000Z',
                report: hostile, rateId: 'rate-1', price: 10, slots: 1, bookingRequestId: 'br-1'
            }
        ]
    });
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm()], [run], call => {
            assert.equal(call.path, '/api/swarm-runs/run-1');
            return Response.json({ run });
        })
    });
    assert.equal(visibleText(container, 'No runs yet.'), false);
    assert.equal(visibleText(container, '0 / None'), true);
    assert.equal(tags(container).includes('script'), false);
    assert.equal(tags(container).includes('img'), false);
    await click(container, 'Open');
    const exact = walk(container).filter(node => node.textContent === hostile);
    assert.ok(exact.length >= 4);
    assert.equal(tags(container).includes('script'), false);
    assert.equal(tags(container).includes('img'), false);
    assert.equal(visibleText(container, 'Input tokens'), false);
    assert.equal(visibleText(container, 'Output tokens'), false);
    const anchors = walk(container).filter(node => node.tag === 'a');
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].attributes.href, '/profile/booking-requests');
    assert.equal(anchors[0].href, '/profile/booking-requests');
    assert.equal(visibleText(container, '1, SHA to LAX, 2026-11-23'), true);
    const masterLane = walk(container).find(node => node.className === 'swarm-agent-lane' && node.textContent === '');
    assert.ok(masterLane);
});

test('Run posts once after yes, never after no, and not again while that post is in flight', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let release;
    let posts = 0;
    let asked = '';
    const running = runRecord({ status: 'running', finishedAt: null, summary: 'In progress', cancelRequested: false });
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm({ name: 'North' })], [], call => {
            if (call.method === 'GET' && call.path === '/api/swarm-runs/run-1') return Response.json({ run: running });
            assert.equal(call.method, 'POST');
            assert.equal(call.path, '/api/swarms/swarm-1/runs');
            posts += 1;
            return new Promise(resolve => {
                release = () => resolve(Response.json({ run: running }, { status: 202 }));
            });
        })
    });
    global.window.confirm = message => {
        asked = message;
        return false;
    };
    await click(container, 'Run');
    assert.equal(posts, 0);
    assert.equal(asked, 'Run North? The run may request bookings inside its caps.');

    global.window.confirm = () => true;
    const first = click(container, 'Run');
    assert.equal(posts, 1);
    assert.equal(buttons(container, 'Run')[0].disabled, true);
    click(container, 'Run');
    assert.equal(posts, 1);
    release();
    await first;
    await flush();
    assert.equal(visibleText(container, 'In progress'), true);
});

test('each start refusal shows the server message, reasons, and the running run', async t => {
    const cases = [
        {
            name: 'run_active',
            body: { error: 'Your company has an active swarm run.', code: 'run_active' },
            reasons: []
        },
        {
            name: 'swarm_not_ready',
            body: {
                error: 'Swarm run prerequisites are missing.',
                code: 'swarm_not_ready',
                reasons: ['ANTHROPIC_API_KEY', 'private CloudBBS credentials']
            },
            reasons: ['ANTHROPIC_API_KEY', 'private CloudBBS credentials']
        },
        {
            name: 'cannot_request_booking',
            body: { error: 'You cannot request a booking.', code: 'cannot_request_booking' },
            reasons: []
        }
    ];
    for (const item of cases) {
        let listGets = 0;
        const running = runRecord({ status: 'running', finishedAt: null, summary: 'the-live-run', cancelRequested: false });
        const { container } = await mountSwarm(t, {
            permissions: customer,
            respond: call => {
                if (call.path === '/api/swarm-runs' && call.method === 'GET') {
                    listGets += 1;
                    return Response.json({ runs: listGets === 1 ? [] : [running] });
                }
                if (call.path === '/api/swarm-runs/run-1' && call.method === 'GET') return Response.json({ run: running });
                if (call.method === 'POST' && call.path === '/api/swarms/swarm-1/runs') {
                    return Response.json(item.body, { status: item.body.code === 'cannot_request_booking' ? 403 : 409 });
                }
                return customerReady([swarm()], [])(call);
            }
        });
        global.window.confirm = () => true;
        await click(container, 'Run');
        assert.equal(visibleText(container, item.body.error), true, item.name);
        for (const reason of item.reasons) assert.equal(visibleText(container, reason), true, reason);
        if (item.name === 'run_active') {
            assert.equal(buttons(container, 'Open running run').length, 1);
            await click(container, 'Open running run');
            assert.equal(visibleText(container, 'the-live-run'), true);
        } else {
            assert.equal(buttons(container, 'Open running run').length, 0);
        }
    }
});

test('Save and run saves, then starts, and a refused start leaves the swarm in the list', async t => {
    const order = [];
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.method === 'POST' && call.path === '/api/swarms') {
                order.push('save');
                return Response.json({
                    swarm: { id: 'swarm-new', canEdit: true, updatedAt: '2026-11-23T02:00:00.000Z', ...call.body }
                });
            }
            if (call.method === 'POST' && call.path === '/api/swarms/swarm-new/runs') {
                order.push('start');
                return Response.json({
                    error: 'Swarm run prerequisites are missing.',
                    code: 'swarm_not_ready',
                    reasons: ['ANTHROPIC_API_KEY', 'private CloudBBS credentials']
                }, { status: 409 });
            }
            return customerReady([], [])(call);
        }
    });
    await click(container, 'New swarm');
    control(container, 'Name').value = 'Created';
    control(container, 'Instructions').value = 'Hold course';
    await click(container, 'Next');
    await click(container, 'Next');
    await clickToolbarAdd(container);
    await click(container, 'Next');
    await click(container, 'Next');
    let confirmed = 0;
    global.window.confirm = () => { confirmed += 1; return true; };
    await click(container, 'Save and run');
    assert.deepEqual(order, ['save', 'start']);
    assert.equal(confirmed, 0);
    assert.equal(visibleText(container, 'Created'), true);
    assert.equal(visibleText(container, 'Swarm run prerequisites are missing.'), true);
    assert.equal(visibleText(container, 'ANTHROPIC_API_KEY'), true);
    assert.equal(visibleText(container, 'private CloudBBS credentials'), true);
});

test('Cancel posts once for a running run and a 409 not_running reloads without an error', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const running = runRecord({ status: 'running', finishedAt: null, summary: 'Still going', cancelRequested: false });
    let posts = 0;
    let detailGets = 0;
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm()], [running], call => {
            if (call.method === 'GET' && call.path === '/api/swarm-runs/run-1') {
                detailGets += 1;
                const run = detailGets === 1 ? running : runRecord({ status: 'completed', summary: 'Reloaded' });
                return Response.json({ run });
            }
            if (call.method === 'POST' && call.path === '/api/swarm-runs/run-1/cancel') {
                posts += 1;
                return Response.json({ error: 'This swarm run has ended.', code: 'not_running' }, { status: 409 });
            }
            return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
        })
    });
    assert.equal(buttons(container, 'Run')[0].disabled, true);
    await click(container, 'Open');
    assert.equal(buttons(container, 'Cancel').length, 1);
    let asked = '';
    global.window.confirm = message => { asked = message; return true; };
    await click(container, 'Cancel');
    assert.equal(asked, 'Cancel this swarm run?');
    assert.equal(posts, 1);
    assert.equal(detailGets, 2);
    assert.equal(visibleText(container, 'Reloaded'), true);
    assert.equal(visibleText(container, 'This swarm run has ended.'), false);
    assert.equal(buttons(container, 'Cancel').length, 0);

    const requested = runRecord({ id: 'run-2', status: 'running', cancelRequested: true, summary: 'Stop asked' });
    const second = await mountSwarm(t, {
        permissions: customer,
        respond: customerReady([swarm({ id: 'swarm-2' })], [requested], call => {
            assert.equal(call.path, '/api/swarm-runs/run-2');
            return Response.json({ run: requested });
        })
    });
    await click(second.container, 'Open');
    assert.equal(buttons(second.container, 'Cancel').length, 0);
    assert.equal(visibleText(second.container, 'Cancel requested'), true);
});

test('a shown running run is re-read every 2 seconds, one request at a time, and then stops', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const running = runRecord({ status: 'running', finishedAt: null, summary: 'Watch me', cancelRequested: false });
    let detailGets = 0;
    let listGets = 0;
    let release;
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/swarm-runs' && call.method === 'GET') {
                listGets += 1;
                return Response.json({ runs: [running] });
            }
            if (call.path === '/api/swarm-runs/run-1' && call.method === 'GET') {
                detailGets += 1;
                if (detailGets === 2) {
                    return new Promise(resolve => { release = resolve; });
                }
                return Response.json({ run: running });
            }
            return customerReady([swarm()], [running])(call);
        }
    });
    await click(container, 'Open');
    assert.equal(detailGets, 1);
    const listsAfterOpen = listGets;
    await tick(t);
    assert.equal(detailGets, 2);
    assert.equal(listGets, listsAfterOpen);
    await tick(t);
    assert.equal(detailGets, 2);
    release(Response.json({ run: runRecord({ status: 'completed', summary: 'Watch me done' }) }));
    await flush();
    assert.equal(visibleText(container, 'Watch me done'), true);
    await tick(t, 10000);
    assert.equal(detailGets, 2);

    let unmountGets = 0;
    const live = runRecord({ id: 'run-live', status: 'running', finishedAt: null, summary: 'Leave' });
    const leaving = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/swarm-runs/run-live' && call.method === 'GET') {
                unmountGets += 1;
                return Response.json({ run: live });
            }
            return customerReady([swarm()], [live])(call);
        }
    });
    await click(leaving.container, 'Open');
    assert.equal(unmountGets, 1);
    await tick(t);
    assert.equal(unmountGets, 2);
    const { unmount } = await import('../public/js/swarm/page.js');
    unmount();
    await tick(t, 10000);
    assert.equal(unmountGets, 2);

    let deniedGets = 0;
    const denied = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/swarm-runs/run-1' && call.method === 'GET') {
                deniedGets += 1;
                if (deniedGets === 1) return Response.json({ run: running });
                return Response.json({ error: 'Sign in required.' }, { status: 401 });
            }
            return customerReady([swarm()], [running])(call);
        }
    });
    let replaced = 0;
    global.location.replace = () => { replaced += 1; };
    await click(denied.container, 'Open');
    await tick(t);
    assert.equal(deniedGets, 2);
    assert.equal(replaced, 1);
    assert.equal(visibleText(denied.container, 'Sign in required.'), true);
    assert.equal(visibleText(denied.container, 'Watch me'), true);
    await tick(t, 10000);
    assert.equal(deniedGets, 2);
});

test('a late read of one run does not replace the run just opened or keep Run disabled', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const running = runRecord({ id: 'run-a', status: 'running', finishedAt: null, summary: 'Still A', cancelRequested: false });
    const other = runRecord({ id: 'run-b', status: 'completed', summary: 'Run B', finishedAt: '2026-11-23T02:00:00.000Z' });
    let getsB = 0;
    let releaseA;
    const switched = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/swarm-runs' && call.method === 'GET') return Response.json({ runs: [running, other] });
            if (call.path === '/api/swarm-runs/run-a') {
                if (!releaseA) return Response.json({ run: running });
                return new Promise(resolve => { releaseA = () => resolve(Response.json({ run: running })); });
            }
            if (call.path === '/api/swarm-runs/run-b') {
                getsB += 1;
                return Response.json({ run: other });
            }
            return customerReady([swarm()], [running, other])(call);
        }
    });
    await buttons(switched.container, 'Open')[0].events.click();
    releaseA = () => {};
    await tick(t);
    await click(switched.container, 'Back to runs');
    const opening = buttons(switched.container, 'Open')[1].events.click();
    releaseA(undefined);
    await opening;
    await flush();
    assert.equal(getsB, 1);
    assert.equal(visibleText(switched.container, 'Run B'), true);
    assert.equal(visibleText(switched.container, 'Still A'), false);

    const live = runRecord({ status: 'running', finishedAt: null, summary: 'Live', cancelRequested: false });
    const done = runRecord({ status: 'completed', summary: 'Finished', finishedAt: '2026-11-23T02:00:00.000Z' });
    let listGets = 0;
    let detailGets = 0;
    let release;
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/swarm-runs' && call.method === 'GET') {
                listGets += 1;
                return Response.json({ runs: [listGets === 1 ? live : done] });
            }
            if (call.path === '/api/swarm-runs/run-1') {
                detailGets += 1;
                if (detailGets === 2) return new Promise(resolve => { release = resolve; });
                return Response.json({ run: live });
            }
            return customerReady([swarm()], [live])(call);
        }
    });
    await click(container, 'Open');
    await tick(t);
    assert.equal(detailGets, 2);
    await click(container, 'Back to runs');
    await flush();
    assert.equal(visibleText(container, 'completed'), true);
    assert.equal(buttons(container, 'Run')[0].disabled, false);
    release(Response.json({ run: live }));
    await flush();
    await tick(t, 10000);
    assert.equal(detailGets, 2);
    assert.equal(buttons(container, 'Run')[0].disabled, false);
    assert.equal(visibleText(container, 'running'), false);
    assert.equal(visibleText(container, 'Live'), false);
});

test('renderRunDetail omits Cancel and token counts unless asked', async t => {
    install(t);
    const { element } = require('./helpers/r1-65');
    const { renderRunDetail } = await import('../public/js/swarm/run-view.js');
    const view = element('div');
    const running = runRecord({ status: 'running', finishedAt: null, cancelRequested: false });
    renderRunDetail(view, running, {});
    assert.equal(walk(view).some(node => node.tag === 'button' && node.textContent === 'Cancel'), false);
    assert.equal(walk(view).some(node => node.textContent === 'Input tokens' || node.textContent === 'Output tokens'), false);
    assert.equal(walk(view).some(node => node.textContent === '111' || node.textContent === '222'), false);
    renderRunDetail(view, running, { showTokens: true, onCancel() {} });
    assert.equal(walk(view).filter(node => node.tag === 'button' && node.textContent === 'Cancel').length, 1);
    assert.equal(walk(view).some(node => node.className === 'swarm-input-tokens' && node.textContent === '111'), true);
    assert.equal(walk(view).some(node => node.className === 'swarm-output-tokens' && node.textContent === '222'), true);
});

test('a swarm write leaves fetch in place and a positioned 400 still marks that lane', async t => {
    const message = 'Select a visible lane for this rate type. <script>alert(1)</script>';
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.method === 'POST') {
                assert.equal(global.fetch, before);
                return Response.json({ error: message, position: 3 }, { status: 400 });
            }
            return customerReady([], [])(call);
        }
    });
    const before = global.fetch;
    await click(container, 'New swarm');
    control(container, 'Name').value = 'Marked';
    await click(container, 'Next');
    await click(container, 'Next');
    await clickToolbarAdd(container);
    await clickToolbarAdd(container);
    await clickToolbarAdd(container);
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(global.fetch, before);
    const row = walk(container).find(node => node.tag === 'fieldset' && node.attributes['data-position'] === '3' && !hiddenDeep(node));
    assert.equal(String(row.className).includes('swarm-lane-marked'), true);
    assert.equal(walk(row).some(node => node.textContent === message), true);
    assert.equal(tags(container).includes('script'), false);
});

test('request errors carry reasons and position only when the body has them', async t => {
    install(t);
    let payload = {
        error: 'Swarm run prerequisites are missing.',
        code: 'swarm_not_ready',
        reasons: ['ANTHROPIC_API_KEY', 'private CloudBBS credentials'],
        position: 3
    };
    let status = 409;
    t.mock.method(global, 'fetch', async () => Response.json(payload, { status }));
    const { request } = await import('../public/js/api.js');
    const ready = await request('/api/swarms/swarm-1/runs', { method: 'POST' }).then(() => null, error => error);
    assert.equal(ready.message, 'Swarm run prerequisites are missing.');
    assert.equal(ready.status, 409);
    assert.equal(ready.code, 'swarm_not_ready');
    assert.deepEqual(ready.reasons, ['ANTHROPIC_API_KEY', 'private CloudBBS credentials']);
    assert.equal(ready.position, 3);

    payload = { error: 'nope', code: 'bad' };
    status = 400;
    const plain = await request('/api/swarms').then(() => null, error => error);
    assert.equal(plain.message, 'nope');
    assert.equal(plain.status, 400);
    assert.equal(plain.code, 'bad');
    assert.deepEqual(plain.reasons, []);
    assert.equal(Object.hasOwn(plain, 'position'), false);
});
