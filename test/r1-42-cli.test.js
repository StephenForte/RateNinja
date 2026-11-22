'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { applyAdminKey } = require('./helpers/r1-25');
const { ADMIN_KEY, seedSampleWorld, runSampleCli } = require('./helpers/r1-42');

let app;
let world;

function compact(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function preset(user) {
    const names = [compact(user.displayName), compact(user.username)];
    const firstWord = String(user.displayName || '').trim().split(/\s+/)[0].toLowerCase();
    return ['alan', 'bob', 'testbuyer'].some(target => names.includes(target) || firstWord === target);
}

function agentCount(userId) {
    if (!userId) return app.db.prepare('SELECT COUNT(*) AS count FROM managed_agents').get().count;
    return app.db.prepare('SELECT COUNT(*) AS count FROM managed_agents WHERE created_by_user_id = ?').get(userId).count;
}

function cli(args, input = '') {
    return runSampleCli(args, {
        input,
        baseUrl: app.baseUrl,
        dbPath: app.dbPath,
        env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
    });
}

before(async () => {
    app = await startApp();
    world = seedSampleWorld(app.db);
    applyAdminKey(ADMIN_KEY);
});

beforeEach(() => {
    app.db.exec('DELETE FROM managed_agents; DELETE FROM audit_events;');
    applyAdminKey(ADMIN_KEY);
});

after(async () => { await app?.close(); });

it('pre-selects Alan, Bob and TestBuyer and writes nothing without confirmation', async () => {
    const listed = await cli(['list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^13\. Queue sample managed agents$/m);
    assert.equal(listed.stdout.includes(ADMIN_KEY), false);

    const customers = await (await app.request('/api/admin/v1/managed-agents/customers', {
        headers: { 'x-admin-api-key': ADMIN_KEY },
        cookie: false,
        csrf: false
    })).json();
    const menu = await cli([], '13\n\nn\n8\n');
    assert.equal(menu.status, 0, menu.stderr + menu.stdout);
    assert.match(menu.stdout, /Cancelled/);
    assert.equal(agentCount(), 0);
    for (const user of customers.customers) {
        const line = menu.stdout.split('\n').find(row => row.includes(`(${user.username})`));
        assert.ok(line, user.username);
        assert.equal(line.includes(preset(user) ? '[x]' : '[ ]'), true);
    }
    assert.equal(menu.stdout.includes('Alan Owner'), false);
    assert.equal(menu.stdout.includes('Bob Disabled'), false);
    assert.equal(menu.stdout.includes(ADMIN_KEY), false);
    assert.equal(menu.stderr.includes(ADMIN_KEY), false);

    const dry = await cli(['managed-agents-samples']);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stderr, /Not created/);
    assert.match(dry.stdout, /A lan/);
    assert.match(dry.stdout, /Test Buyer/);
    assert.match(dry.stdout, /ceiling /);
    assert.equal(dry.stdout.includes('Nora'), false);
    assert.equal(dry.stdout.includes('Bobby'), false);
    assert.equal(agentCount(), 0);
    assert.equal(`${dry.stdout}${dry.stderr}`.includes(ADMIN_KEY), false);
});

it('creates one batch per selected user with --yes and continues after a per-user failure', async () => {
    const created = await cli(['managed-agents-samples', '--yes']);
    assert.equal(created.status, 0, created.stderr + created.stdout);
    assert.equal(agentCount(), 15);
    assert.equal(agentCount(world.users.alan.id), 5);
    assert.equal(agentCount(world.users.bob.id), 5);
    assert.equal(agentCount(world.users.testBuyer.id), 5);
    assert.equal(agentCount(world.users.nora.id), 0);
    assert.equal(agentCount(world.users.bobby.id), 0);
    const ids = app.db.prepare('SELECT id FROM managed_agents').all().map(row => row.id);
    for (const id of ids) assert.match(created.stdout, new RegExp(id));
    assert.equal(`${created.stdout}${created.stderr}`.includes(ADMIN_KEY), false);

    app.db.exec('DELETE FROM managed_agents; DELETE FROM audit_events;');
    const partial = await cli([
        'managed-agents-samples', '--yes', '--json',
        '--user', world.users.alan.id,
        '--user', world.users.empty.id,
        '--user', world.users.owner.id
    ]);
    assert.equal(partial.status, 1, partial.stdout);
    assert.match(partial.stderr, /no lane with a matching customer price/);
    assert.match(partial.stderr, /not an active customer user/);
    assert.equal(agentCount(world.users.alan.id), 5);
    assert.equal(agentCount(world.users.empty.id), 0);
    assert.equal(agentCount(world.users.owner.id), 0);
    const body = JSON.parse(partial.stdout);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].agentIds.length, 5);
    assert.equal(`${partial.stdout}${partial.stderr}`.includes(ADMIN_KEY), false);
});

it('lets the operator change the selection and still waits for confirmation', async () => {
    const customers = await (await app.request('/api/admin/v1/managed-agents/customers', {
        headers: { 'x-admin-api-key': ADMIN_KEY },
        cookie: false,
        csrf: false
    })).json();
    const nora = customers.customers.findIndex(user => user.id === world.users.nora.id) + 1;
    assert.ok(nora > 0);
    const menu = await cli([], `13\n${nora}\n\nn\n8\n`);
    assert.equal(menu.status, 0, menu.stderr + menu.stdout);
    assert.match(menu.stdout, /^Nora \(nora\) — Test Buyer Co$/m);
    assert.match(menu.stdout, /Cancelled/);
    assert.equal(agentCount(), 0);
    assert.equal(menu.stdout.includes(ADMIN_KEY), false);
});
