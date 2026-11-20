'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after, afterEach } = require('node:test');
const { startApp } = require('./helpers/app');
const { serveProviders } = require('./helpers/r1-35');
const { call, insertCompany, insertUser, login } = require('./helpers/r1-19');
const { COMPANY_TYPE_CUSTOMER } = require('../lib/constants');
const { KEYS, NOON, assertNoSecrets, insertAgent, until } = require('./helpers/r1-45');

process.env.NODE_ENV = 'test';
process.env.RATE_NINJA_ADMIN_API_KEY = KEYS.admin;
process.env.ANTHROPIC_API_KEY = KEYS.claude;
process.env.CLOUDBBS_AGENT_TOKEN = KEYS.cloud;
process.env.RATE_NINJA_BASE_URL = 'http://127.0.0.1:9';
process.env.CLOUDBBS_URL = 'http://127.0.0.1:9';
process.env.CLIENT_AGENT_ANTHROPIC_URL = 'http://127.0.0.1:9';
process.env.CLIENT_AGENT_MODEL = 'synthetic-claude';

let app;
let providers;
let runs;
let runManagedAgents;
let setPasswordByUsername;

function post(session = null) {
    if (!session) return app.request('/api/managed-agents/runs', { method: 'POST', body: '{}' });
    return call(app.baseUrl, session, 'POST', '/api/managed-agents/runs', {});
}

function runRow() {
    return app.db.prepare('SELECT * FROM managed_agent_runs ORDER BY rowid DESC LIMIT 1').get();
}

describe('r1-45 managed agent runs', () => {
    before(async () => {
        app = await startApp({ username: 'r145-admin' });
        app.db.prepare('UPDATE users SET is_system_admin = 1, display_name = ? WHERE username = ?')
            .run('Synthetic Admin', app.username);
        providers = await serveProviders({ judge: () => ({ rateId: null, summary: 'Synthetic findings.' }) });
        process.env.RATE_NINJA_BASE_URL = app.baseUrl;
        process.env.CLOUDBBS_URL = providers.baseUrl;
        process.env.CLIENT_AGENT_ANTHROPIC_URL = providers.baseUrl;
        ({ setPasswordByUsername } = require('../lib/accounts'));
        runs = require('../lib/managed-agent-runs');
        ({ runManagedAgents } = require('../lib/managed-agent-runner'));
        runs.setTestClock(() => NOON);
    });

    after(async () => {
        runs?.setTestRunner(null);
        runs?.setTestClock(null);
        await providers?.close();
        await app?.close();
    });

    afterEach(() => {
        runs.setTestRunner(null);
        runs.setTestClock(() => NOON);
        runs.resetInvocationCount();
    });

    it('refuses anyone who is not a signed-in system admin', async () => {
        insertCompany(app.db, { id: 'r145-buyer', name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, { id: 'r145-member', username: 'r145-member', companyId: app.company.id, role: 'member' });
        insertUser(app.db, {
            id: 'r145-company-admin', username: 'r145-company-admin', companyId: app.company.id, role: 'company_admin'
        });
        insertUser(app.db, {
            id: 'r145-customer', username: 'r145-customer', companyId: 'r145-buyer', role: 'member'
        });
        for (const username of ['r145-member', 'r145-company-admin', 'r145-customer']) {
            assert.equal(setPasswordByUsername(username, 'sail-the-ocean').ok, true);
        }
        const member = await login(app.baseUrl, 'r145-member');
        const companyAdmin = await login(app.baseUrl, 'r145-company-admin');
        const customer = await login(app.baseUrl, 'r145-customer');
        for (const session of [member, companyAdmin, customer]) {
            assert.equal((await call(app.baseUrl, session, 'GET', '/api/managed-agents/runs/latest')).status, 403);
            const denied = await post(session);
            assert.equal(denied.status, 403);
            assert.equal(denied.json.code, 'forbidden');
        }
        assert.equal((await call(app.baseUrl, null, 'GET', '/api/managed-agents/runs/latest')).status, 401);
        assert.equal((await call(app.baseUrl, null, 'POST', '/api/managed-agents/runs', {})).status, 401);
        const csrf = await app.request('/api/managed-agents/runs', { method: 'POST', body: '{}', csrf: false });
        assert.equal(csrf.status, 403);
        assert.notEqual((await csrf.json()).code, 'run_in_progress');
    });

    it('reports missing settings, an empty queue, and the post window', async () => {
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const latest = await app.request('/api/managed-agents/runs/latest');
            const body = await latest.json();
            assert.equal(latest.status, 200);
            assert.equal(body.readiness.disabledReason, 'Set ANTHROPIC_API_KEY to run managed agents.');
            const refused = await post();
            assert.equal(refused.status, 503);
            assert.equal((await refused.json()).code, 'runner_not_configured');
            assertNoSecrets(JSON.stringify(body));
        } finally {
            process.env.ANTHROPIC_API_KEY = KEYS.claude;
        }

        delete process.env.CLOUDBBS_AGENT_TOKEN;
        try {
            const refused = await post();
            assert.equal(refused.status, 503);
            assert.match((await refused.json()).error, /CLOUDBBS_AGENT_TOKEN/);
        } finally {
            process.env.CLOUDBBS_AGENT_TOKEN = KEYS.cloud;
        }

        const empty = await (await app.request('/api/managed-agents/runs/latest')).json();
        assert.equal(empty.readiness.queuedCount, 0);
        assert.equal(empty.readiness.disabledReason, 'No queued managed agents.');
        assert.equal(empty.run, null);

        runs.setTestClock(() => Date.parse('2026-11-20T00:17:00.000Z'));
        const closed = await post();
        assert.equal(closed.status, 423);
        assert.equal((await closed.json()).code, 'post_window');
        runs.setTestClock(() => Date.parse('2026-11-20T00:15:00.000Z'));
        assert.equal((await post()).status, 423);
        runs.setTestClock(() => Date.parse('2026-11-20T00:18:59.000Z'));
        assert.equal((await post()).status, 423);
        runs.setTestClock(() => Date.parse('2026-11-20T00:19:00.000Z'));
        const open = await (await app.request('/api/managed-agents/runs/latest')).json();
        assert.equal(open.readiness.windowClosed, false);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM managed_agent_runs').get().n, 0);
    });

    it('accepts one of two simultaneous starts', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let calls = 0;
        runs.setTestRunner(() => {
            calls += 1;
            return gate;
        });
        const [first, second] = await Promise.all([post(), post()]);
        const statuses = [first.status, second.status].sort();
        assert.deepEqual(statuses, [202, 409]);
        const conflict = first.status === 409 ? first : second;
        assert.equal((await conflict.json()).code, 'run_in_progress');
        assert.equal(calls, 1);
        assert.equal(runs.invocationCount(), 1);
        assert.equal(runRow().status, 'running');
        release(0);
        const done = await until(() => {
            const row = runRow();
            return row.status === 'succeeded' ? row : null;
        });
        assert.equal(done.exit_code, 0);
    });

    it('returns before the runner finishes, then records the same outcome as the CLI', async () => {
        const adminId = app.db.prepare('SELECT id FROM users WHERE username = ?').get(app.username).id;
        insertAgent(app.db, { id: 'r145-one', companyId: app.company.id, userId: adminId });
        insertAgent(app.db, { id: 'r145-two', companyId: app.company.id, userId: adminId });
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        runs.setTestRunner(options => gate.then(() => runManagedAgents(options)));
        const response = await post();
        const accepted = await response.json();
        assert.equal(response.status, 202);
        assert.equal(accepted.run.status, 'running');
        assert.equal(runRow().status, 'running');
        assert.deepEqual(JSON.parse(runRow().started_agent_ids), []);
        const pending = release();
        await pending;
        const done = await until(() => {
            const row = runRow();
            return row.status === 'running' ? null : row;
        });
        assert.equal(done.status, 'succeeded');
        assert.equal(done.exit_code, 0);
        assert.deepEqual(JSON.parse(done.started_agent_ids), ['r145-one', 'r145-two']);
        assert.match(done.summary, /r145-one/);
        assert.match(done.summary, /completed/);
        assertNoSecrets(done.summary);
        const agents = app.db.prepare(
            "SELECT id, status FROM managed_agents WHERE id IN ('r145-one', 'r145-two') ORDER BY id"
        ).all().map(row => ({ id: row.id, status: row.status }));
        assert.deepEqual(agents, [
            { id: 'r145-one', status: 'completed' },
            { id: 'r145-two', status: 'completed' }
        ]);
        assert.equal(providers.posts.length, 1);
        const latest = await (await app.request('/api/managed-agents/runs/latest')).json();
        assert.equal(latest.run.status, 'succeeded');
        assert.equal(latest.run.startedBy, 'Synthetic Admin');
        assertNoSecrets(JSON.stringify(latest));
    });

    it('keeps serving when the background runner throws, and stores no secrets', async () => {
        runs.setTestRunner(async options => {
            options.stdout.write(`${KEYS.claude}${'Y'.repeat(40000)}ENDMARK ${KEYS.admin} ${KEYS.cloud}`);
            throw new Error(`boom ${KEYS.claude} ${KEYS.cloud} ${KEYS.admin}`);
        });
        const response = await post();
        assert.equal(response.status, 202);
        const done = await until(() => {
            const row = runRow();
            return row.status === 'failed' ? row : null;
        });
        assert.equal(done.exit_code, null);
        assert.equal(done.summary.length <= 32768, true);
        assert.match(done.summary, /Earlier output omitted/);
        assert.match(done.summary, /ENDMARK/);
        assert.match(done.summary, /boom/);
        assertNoSecrets(done.summary);
        const health = await app.request('/api/health');
        assert.equal(health.status, 200);
        const latest = await (await app.request('/api/managed-agents/runs/latest')).json();
        assertNoSecrets(JSON.stringify(latest));
    });
});
