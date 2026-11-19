'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { applyAdminKey } = require('./helpers/r1-25');
const { utcDay } = require('./helpers/r1-19');
const { customerPrice } = require('../lib/pricing');
const { leaksBasePrice } = require('./helpers/no-base-price');
const {
    ADMIN_KEY, ROOT, PASSWORD_HASH, EMAIL, BASE_LOW, BASE_HIGH, EXPIRED_BASE, MARGIN, seedSampleWorld
} = require('./helpers/r1-42');

const CUSTOMER_FIELDS = ['id', 'username', 'displayName', 'companyId', 'companyName'];
let app;
let world;
let agents;
let loadActor;

function countAgents(userId) {
    const sql = userId
        ? 'SELECT COUNT(*) AS count FROM managed_agents WHERE created_by_user_id = ?'
        : 'SELECT COUNT(*) AS count FROM managed_agents';
    return app.db.prepare(sql).get(...(userId ? [userId] : [])).count;
}

async function admin(suffix = '', { key = ADMIN_KEY, method = 'GET', body } = {}) {
    const headers = {};
    if (key !== null) headers['x-admin-api-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(ROOT + suffix, {
        method,
        headers,
        cookie: false,
        csrf: false,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = {};
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = { error: text };
    }
    return { status: response.status, json, text };
}

before(async () => {
    app = await startApp();
    world = seedSampleWorld(app.db);
    agents = require('../lib/managed-agents');
    ({ loadActor } = require('../lib/permissions'));
    applyAdminKey(ADMIN_KEY);
});

beforeEach(() => {
    app.db.exec('DELETE FROM managed_agents; DELETE FROM audit_events;');
    applyAdminKey(ADMIN_KEY);
});

after(async () => { await app?.close(); });

it('lists only active customer-company users and requires the admin key', async () => {
    const missing = await admin('/customers', { key: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, 'invalid_admin_key');
    assert.equal((await admin('/customers', { key: 'wrong' })).status, 401);
    applyAdminKey('');
    assert.equal((await admin('/customers')).status, 503);
    applyAdminKey(ADMIN_KEY);

    const { status, json, text } = await admin('/customers');
    assert.equal(status, 200);
    const ids = json.customers.map(row => row.id);
    assert.ok(ids.includes(world.users.alan.id));
    assert.ok(ids.includes(world.users.bob.id));
    assert.ok(ids.includes(world.users.testBuyer.id));
    assert.equal(ids.includes(world.users.owner.id), false);
    assert.equal(ids.includes(world.users.disabled.id), false);
    for (const row of json.customers) {
        assert.deepEqual(Object.keys(row), CUSTOMER_FIELDS);
        assert.equal(typeof row.username, 'string');
        assert.equal(typeof row.companyName, 'string');
    }
    assert.equal(text.includes(PASSWORD_HASH), false);
    assert.equal(text.includes(EMAIL), false);
    assert.equal(text.includes('password'), false);
    assert.equal(text.includes('token'), false);
    assert.equal(leaksBasePrice(json, BASE_HIGH), false);
    assert.equal(leaksBasePrice(json, BASE_LOW), false);
});

it('creates three customer-priced sample agents or nothing', async () => {
    const userId = world.users.alan.id;
    assert.equal((await admin('/samples')).status, 400);
    assert.equal((await admin('/samples', { method: 'POST', body: {} })).status, 400);
    assert.equal((await admin('/samples', { key: null, method: 'POST', body: { userId } })).status, 401);

    const preview = await admin(`/samples?userId=${encodeURIComponent(userId)}`);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(countAgents(), 0);
    const repeated = await admin(`/samples?userId=${encodeURIComponent(userId)}&seed=${encodeURIComponent(preview.json.seed)}`);
    assert.deepEqual(repeated.json.agents, preview.json.agents);
    assert.equal(leaksBasePrice(preview.json, BASE_HIGH), false);
    assert.equal(leaksBasePrice(preview.json, BASE_LOW), false);
    assert.equal(leaksBasePrice(preview.json, EXPIRED_BASE), false);

    const created = await admin('/samples', { method: 'POST', body: { userId, seed: preview.json.seed } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.userId, userId);
    assert.equal(created.json.companyId, world.companies.blackwater);
    assert.equal(created.json.agents.length, 3);
    assert.deepEqual(created.json.agents.map(agent => agent.sampleKind), ['lowball', 'regular', 'no_booking']);
    assert.equal(leaksBasePrice(created.json, BASE_HIGH), false);
    assert.equal(leaksBasePrice(created.json, BASE_LOW), false);
    assert.equal(leaksBasePrice(created.json, EXPIRED_BASE), false);

    const rows = app.db.prepare('SELECT * FROM managed_agents WHERE created_by_user_id = ? ORDER BY rowid').all(userId);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map(row => row.batch_id)).size, 1);
    assert.ok(rows.every(row => row.company_id === world.companies.blackwater));
    const today = new Date().toISOString().slice(0, 10);
    const lowCustomer = customerPrice(BASE_LOW, { marginPercent: MARGIN.percent, marginNumber: MARGIN.number });
    const highCustomer = customerPrice(BASE_HIGH, { marginPercent: MARGIN.percent, marginNumber: MARGIN.number });
    assert.notEqual(lowCustomer, BASE_LOW);
    assert.notEqual(highCustomer, BASE_HIGH);
    const byKind = Object.fromEntries(created.json.agents.map(agent => [agent.sampleKind, agent]));
    assert.equal(byKind.lowball.allowBookingRequest, true);
    assert.equal(byKind.lowball.allowAlternativeRoutes, false);
    assert.equal(byKind.lowball.priceMin, 0);
    assert.equal(byKind.lowball.containerType, '40D');
    assert.equal(byKind.lowball.priceMax, Math.floor(0.5 * lowCustomer));
    assert.equal(byKind.regular.allowBookingRequest, true);
    assert.equal(byKind.regular.priceMin, 0);
    assert.equal(byKind.regular.containerType, '40D');
    assert.equal(byKind.regular.priceMax, Math.ceil(1.25 * highCustomer));
    assert.equal(byKind.no_booking.allowBookingRequest, false);
    assert.equal(byKind.no_booking.priceMin, null);
    assert.equal(byKind.no_booking.priceMax, null);
    assert.equal(byKind.no_booking.bookingSlots, null);
    for (const agent of created.json.agents) {
        assert.equal(agent.createdByUserId, userId);
        assert.ok(agent.sailingDate >= today);
        assert.ok(agent.sailingDate <= utcDay(20));
        assert.equal(['20D', '40D', '40HC'].includes(agent.containerType), true);
        if (agent.allowBookingRequest) {
            assert.equal(Number.isInteger(agent.bookingSlots) && agent.bookingSlots >= 1 && agent.bookingSlots <= 3, true);
            for (const base of [BASE_LOW, BASE_HIGH, EXPIRED_BASE]) {
                assert.notEqual(agent.priceMax, base);
                assert.notEqual(agent.priceMax, Math.floor(0.5 * base));
                assert.notEqual(agent.priceMax, Math.ceil(1.25 * base));
            }
        }
    }

    const lowMatches = await admin(`/${byKind.lowball.id}/matches`);
    assert.equal(lowMatches.status, 200, lowMatches.text);
    assert.ok(lowMatches.json.matches.length >= 2);
    assert.ok(lowMatches.json.matches.every(match => match.withinPriceRange === false));
    assert.ok(lowMatches.json.matches.every(match => byKind.lowball.priceMax < match.price));
    const regularMatches = await admin(`/${byKind.regular.id}/matches`);
    assert.ok(regularMatches.json.matches.some(match => match.withinPriceRange === true));
    assert.ok(regularMatches.json.matches.every(match => byKind.regular.priceMax >= match.price));
    assert.equal(leaksBasePrice(lowMatches.json, BASE_HIGH), false);
    assert.equal(leaksBasePrice(regularMatches.json, BASE_LOW), false);

    const audits = app.db.prepare(`
        SELECT actor_user_id, detail FROM audit_events
        WHERE event_type = 'managed_agent_created' AND actor_user_id = ?
    `).all(userId);
    assert.equal(audits.length, 3);
    const details = audits.map(row => JSON.parse(row.detail));
    assert.ok(details.every(detail => detail.adminSample === true));
    assert.deepEqual(details.map(detail => detail.sampleKind).sort(), ['lowball', 'no_booking', 'regular']);
    assert.deepEqual(details.map(detail => detail.agentId).sort(), created.json.agents.map(agent => agent.id).sort());

    const plain = agents.create(loadActor(userId), [{
        rateType: world.rateType,
        originPort: 'SHA',
        destinationPort: 'LAX',
        sailingDate: utcDay(1),
        savedQueryId: null,
        containerType: '40D',
        allowAlternativeRoutes: false,
        allowBookingRequest: false
    }]);
    const plainAudit = app.db.prepare(`
        SELECT detail FROM audit_events
        WHERE event_type = 'managed_agent_created' AND json_extract(detail, '$.agentId') = ?
    `).get(plain[0].id);
    assert.equal(JSON.parse(plainAudit.detail).adminSample, undefined);
});

it('refuses a user with no priced lane, a disabled user, or a company that cannot book', async () => {
    const before = countAgents();
    const empty = await admin('/samples', { method: 'POST', body: { userId: world.users.empty.id } });
    assert.equal(empty.status, 422, empty.text);
    assert.match(empty.json.error, /no lane with a matching customer price/);
    const disabled = await admin('/samples', { method: 'POST', body: { userId: world.users.disabled.id } });
    assert.equal(disabled.status, 422);
    assert.match(disabled.json.error, /disabled/);
    const owner = await admin('/samples', { method: 'POST', body: { userId: world.users.owner.id } });
    assert.equal(owner.status, 422, owner.text);
    assert.match(owner.json.error, /cannot request bookings/);
    assert.equal((await admin('/samples', { method: 'POST', body: { userId: 'missing-user' } })).status, 404);
    assert.equal(countAgents(), before);
    assert.equal(leaksBasePrice(empty.json, EXPIRED_BASE), false);
    assert.equal(leaksBasePrice(owner.json, BASE_HIGH), false);
});

it('repeats a fixed draw and keeps the sailing date on the window edge', () => {
    const actor = loadActor(world.users.edge.id);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const random = () => 0;
    const first = agents.buildSampleAgents(actor, { random, now });
    const second = agents.buildSampleAgents(actor, { random, now });
    assert.deepEqual(first, second);
    assert.equal(first.length, 3);
    for (const item of first) {
        assert.equal(item.input.sailingDate, today);
        assert.equal(item.input.sailingDate, utcDay(0));
        assert.equal(item.input.originPort, 'EDGE');
        assert.equal(item.input.destinationPort, 'DAY');
        assert.ok(item.input.sailingDate >= today);
    }
    const created = agents.createSampleAgents(world.users.edge.id, { random, now });
    assert.equal(created.agents.length, 3);
    assert.ok(created.agents.every(agent => agent.sailingDate === today));
    assert.equal(countAgents(world.users.edge.id), 3);
});
