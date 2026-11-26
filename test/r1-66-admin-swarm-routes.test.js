'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { startApp } = require('./helpers/app');
const { call, login } = require('./helpers/r1-19');
const { seed, CUSTOMERS, INSTRUCTIONS, PROJECT, TOKEN, THREAD, REPORT, STARTED, LATEST } = require('./helpers/r1-66');

const API = '/api/admin/swarm-runs';
const customers = [
    { companyId: 'c1', name: CUSTOMERS.c1, runCount: 52, lastStartedAt: LATEST, running: true },
    { companyId: 'c2', name: CUSTOMERS.c2, runCount: 1, lastStartedAt: STARTED, running: false },
    { companyId: 'c3', name: CUSTOMERS.c3, runCount: 1, lastStartedAt: STARTED, running: false }
];
const listIds = {
    c1: ['run-c1', ...Array.from({ length: 49 }, (_, i) => `old-${51 - i}`)],
    c2: ['run-c2'],
    c3: ['run-c3'],
    c4: []
};
const denied = { error: 'Administrator access is required.' };
const companyMissing = { error: 'Customer company not found.' };
const runMissing = { error: 'Swarm run not found.' };
let app;
let sessions;

before(async () => {
    app = await startApp();
    seed(app.db);
    sessions = {};
    for (const role of ['system', 'owner-a', 'owner-b', 'customer-admin', 'customer-member', 'owner-member']) {
        sessions[role] = await login(app.baseUrl, `r166-${role}`);
    }
    assert.equal(sessions.system.user.companyContext, null);
    sessions.selected = await login(app.baseUrl, 'r166-system');
    const selected = await call(app.baseUrl, sessions.selected, 'POST', '/api/admin/context', { companyId: 'c1' });
    assert.equal(selected.status, 200);
    assert.equal(selected.json.companyContext.id, 'c1');
});

after(async () => { await app?.close(); });

function get(role, suffix) {
    return call(app.baseUrl, sessions[role], 'GET', API + suffix);
}

const matrix = [
    ['system', 200, ['c1', 'c2', 'c3', 'c4']],
    ['selected', 200, ['c1', 'c2', 'c3', 'c4']],
    ['owner-a', 200, ['c1']],
    ['owner-b', 200, []],
    ['customer-admin', 403, []],
    ['customer-member', 403, []],
    ['owner-member', 403, []],
    ['signed-out', 401, []]
];

for (const [role, status, visible] of matrix) {
    test(`all three admin reads apply the visibility boundary for ${role}`, async () => {
        const directory = await get(role, '/companies');
        assert.equal(directory.status, status);
        if (status === 200) {
            assert.deepEqual(directory.json, { companies: customers.filter(item => visible.includes(item.companyId)) });
        } else if (status === 403) {
            assert.deepEqual(directory.json, denied);
        }
        for (const companyId of ['c1', 'c2', 'c3', 'c4', 'owner-a']) {
            const allowed = visible.includes(companyId);
            const list = await get(role, `?companyId=${companyId}`);
            assert.equal(list.status, status === 200 && !allowed ? 404 : status);
            if (list.status === 200) {
                assert.deepEqual(Object.keys(list.json), ['runs']);
                assert.deepEqual(list.json.runs.map(run => run.id), listIds[companyId]);
                for (const run of list.json.runs) {
                    assert.equal(run.companyId, companyId);
                    assert.equal(run.companyName, CUSTOMERS[companyId]);
                }
            } else if (list.status === 403) {
                assert.deepEqual(list.json, denied);
            } else if (list.status === 404) {
                assert.deepEqual(list.json, companyMissing);
            }

            const runId = companyId === 'owner-a' ? 'run-owner' : `run-${companyId}`;
            const detail = await get(role, `/${runId}`);
            assert.equal(detail.status, status === 200 && (!allowed || companyId === 'c4') ? 404 : status);
            if (detail.status === 200) {
                assert.deepEqual(Object.keys(detail.json), ['run']);
                assert.equal(detail.json.run.id, runId);
                assert.equal(detail.json.run.companyId, companyId);
                assert.equal(detail.json.run.companyName, CUSTOMERS[companyId]);
                assert.deepEqual(detail.json.run.agents.map(agent => agent.id), [`agent-${runId}`]);
            } else if (detail.status === 403) {
                assert.deepEqual(detail.json, denied);
            } else if (detail.status === 404) {
                assert.deepEqual(detail.json, runMissing);
            }
        }
    });
}

test('missing companyId is 400 and revoked, unlinked and unknown IDs have byte-identical 404s', async () => {
    assert.equal((await get('owner-a', '')).status, 400);
    assert.equal((await get('owner-a', '?companyId=')).status, 400);
    for (const prefix of ['?companyId=', '/run-']) {
        const [revoked, unlinked, missing] = await Promise.all(
            ['c2', 'c3', 'unknown'].map(id => get('owner-a', prefix + id))
        );
        assert.equal(missing.status, 404);
        assert.equal(revoked.status, 404);
        assert.equal(unlinked.status, 404);
        assert.equal(revoked.text, missing.text);
        assert.equal(unlinked.text, missing.text);
    }
});

test('admin run DTOs add only customer identity and retain the recorded agent price', async () => {
    const runKeys = [
        'id', 'swarmId', 'swarmName', 'status', 'startedByUserId', 'startedAt', 'finishedAt',
        'summary', 'failureReason', 'totalSpendCap', 'totalSlotsCap', 'spendBooked', 'slotsBooked',
        'masterTurns', 'inputTokens', 'outputTokens', 'cancelRequested', 'laneCount', 'companyId', 'companyName'
    ];
    const list = await get('owner-a', '?companyId=c1');
    const detail = await get('owner-a', '/run-c1');
    assert.deepEqual(Object.keys(list.json.runs[0]).sort(), runKeys.sort());
    const { agents, lanes, ...detailFacts } = detail.json.run;
    assert.equal(list.json.runs[0].laneCount, 0);
    assert.deepEqual(lanes, []);
    assert.deepEqual(detailFacts, list.json.runs[0]);
    assert.deepEqual(agents, [{
        id: 'agent-run-c1', role: 'booking', lanePosition: 1, attempt: 1, status: 'completed',
        originPort: null, destinationPort: null, sailingDate: null, startedAt: LATEST, finishedAt: null,
        report: REPORT, rateId: 'synthetic-rate', price: 42.5, slots: 2, bookingRequestId: 'synthetic-booking'
    }]);
    for (const response of [list, detail]) {
        for (const privateValue of [INSTRUCTIONS, PROJECT, TOKEN, THREAD, 'bbs_thread_id', '"snapshot"']) {
            assert.equal(response.text.includes(privateValue), false, privateValue);
        }
    }
    const customer = await call(app.baseUrl, sessions['customer-admin'], 'GET', '/api/swarm-runs/run-c1');
    assert.equal(customer.status, 200);
    assert.deepEqual(detail.json.run, { ...customer.json.run, companyId: 'c1', companyName: CUSTOMERS.c1 });
});

test('all three GETs leave SQLite unchanged even when a legacy company link could be backfilled', async () => {
    const link = app.db.prepare("UPDATE users SET company_record_id = ? WHERE id = 'r166-owner-a'");
    link.run(null);
    try {
        const counts = () => ['swarm_runs', 'swarm_run_agents', 'audit_events'].map(table =>
            app.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
        );
        const totalChanges = () => app.db.prepare('SELECT total_changes() AS count').get().count;
        const beforeCounts = counts();
        const beforeChanges = totalChanges();
        for (const suffix of ['/companies', '?companyId=c1', '/run-c1']) {
            assert.equal((await get('owner-a', suffix)).status, 200);
        }
        assert.deepEqual(counts(), beforeCounts);
        assert.equal(totalChanges(), beforeChanges);
        assert.equal(app.db.prepare("SELECT company_record_id FROM users WHERE id = 'r166-owner-a'").get().company_record_id, null);
    } finally {
        link.run('owner-a');
    }
});
