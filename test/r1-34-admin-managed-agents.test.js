'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { CODE, startCloudBbs } = require('./helpers/r1-37');
const { activate, login, call, utcDay, insertRate, COMPANY_TYPE_CUSTOMER, COMPANY_TYPE_CONTRACT_OWNER } = require('./helpers/r1-19');
const { seedManagedAgents, search, BUYER, OTHER_BUYER, RATE_TYPE } = require('./helpers/r1-33');
const { applyAdminKey } = require('./helpers/r1-25');
const { ADMIN_KEY, ROOT, hashTables } = require('./helpers/r1-34');

const BOOKING = { allowBookingRequest: true, bookingSlots: 3, priceMin: 1070, priceMax: 1070, containerType: '20D' };
const RATE_ID = 'managed-rate-1';
let app;
let cloud;
let users;
let sessions;

function sessionApi(method, suffix, body, who = 'creator') {
    return call(app.baseUrl, sessions[who], method, '/api/managed-agents' + suffix, body);
}

async function admin(suffix = '', { key = ADMIN_KEY, method = 'GET', body, cookie = false } = {}) {
    const headers = {};
    if (key !== null) headers['x-admin-api-key'] = key;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(ROOT + suffix, {
        method, headers, cookie, csrf: false, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
}

async function queue(overrides = {}, who = 'creator') {
    const result = await sessionApi('POST', '', [search(overrides)], who);
    assert.equal(result.status, 201, result.text);
    return result.json.agents[0];
}

function book(agent, rateId = RATE_ID) {
    return admin(`/${agent.id}/booking-requests`, { method: 'POST', body: { rateId, bookingCode: CODE, slots: 99, containerSize: '40HC' } });
}

function checkError(response, status, error) {
    assert.equal(response.status, status, JSON.stringify(response.json));
    assert.equal(response.json.error, error);
}

function addRate(id, options) {
    insertRate(app.db, { id, owner: 'managed-owner', effective: utcDay(2), expiration: utcDay(30), ...options });
    app.db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, id);
}

before(async () => {
    cloud = await startCloudBbs();
    cloud.configureServer();
    app = await startApp();
    users = seedManagedAgents(app.db);
    addRate('r134-private', { owner: 'managed-private-owner' });
    addRate('r134-missing-size', { rate20: null });
    addRate('r134-open-end', { expiration: null, rate20: 1200 });
    addRate('r134-alternative', { destination: 'OAK', rate20: 1200 });
    sessions = {};
    for (const who of ['creator', 'member', 'otherBuyer']) {
        activate(users[who]);
        sessions[who] = await login(app.baseUrl, users[who]);
    }
});

beforeEach(() => {
    app.db.exec('DELETE FROM booking_requests; DELETE FROM managed_agents;');
    applyAdminKey(ADMIN_KEY);
});

after(async () => { await app?.close(); await cloud?.close(); });

it('requires the configured admin key for all three routes, including with a valid browser session', async () => {
    for (const [suffix, method, body] of [['', 'GET'], ['/id/matches', 'GET'], ['/id/booking-requests', 'POST', { rateId: RATE_ID }]]) {
        checkError(await admin(suffix, { method, body, key: null }), 401, 'invalid_admin_key');
        checkError(await admin(suffix, { method, body, key: 'wrong' }), 401, 'invalid_admin_key');
        checkError(await admin(suffix, { method, body, key: null, cookie: true }), 401, 'invalid_admin_key');
        applyAdminKey('');
        checkError(await admin(suffix, { method, body }), 503, 'admin_api_disabled');
        applyAdminKey(ADMIN_KEY);
    }
});

it('lists across companies in queue order and filters D-039 status without splitting legacy ids', async () => {
    const older = await queue({}, 'otherBuyer');
    const member = await queue({}, 'member');
    const creator = await queue({}, 'creator');
    assert.deepEqual([member.companyId, creator.companyId], [BUYER, BUYER]);
    const result = await admin();
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.agents.map(({ id, companyId, companyName, companyType, creatorName }) =>
        [id, companyId, companyName, companyType, creatorName]), [
        [older.id, OTHER_BUYER, 'Synthetic Other Buyer', COMPANY_TYPE_CUSTOMER, users.otherBuyer],
        [member.id, BUYER, 'Synthetic Buyer', COMPANY_TYPE_CUSTOMER, users.member],
        [creator.id, BUYER, 'Synthetic Buyer', COMPANY_TYPE_CUSTOMER, 'Synthetic Creator']
    ]);
    app.db.prepare("UPDATE managed_agents SET status = 'running' WHERE id = ?").run(creator.id);
    assert.deepEqual((await admin('?status=running')).json.agents.map(row => row.id), [creator.id]);
    assert.deepEqual((await admin('?status=completed')).json.agents, []);
    checkError(await admin('?status=unknown'), 400, 'invalid_request');
});

it('matches customer prices, inclusive dates and range, open expiration, allowed alternatives and the first five lane sailings', async () => {
    const insert = app.db.prepare('INSERT INTO sailings (id, departure, departure_port, arrival_port, owner_company_id) VALUES (?, ?, ?, ?, ?)');
    insert.run('r134-private-sailing', utcDay(2), 'SHA', 'LAX', 'managed-private-owner');
    insert.run('r134-wrong-destination', utcDay(2), 'SHA', 'NYC', 'managed-owner');
    insert.run('r134-before', utcDay(1), 'SHA', 'LAX', 'managed-owner');
    for (let day = 2; day < 9; day += 1) insert.run(`r134-sailing-${day}`, utcDay(day), 'SHA', day % 2 ? 'lax' : null, 'managed-owner');

    const agent = await queue({ ...BOOKING, priceMax: 1284 });
    const endpoint = `/${agent.id}/matches`;
    const { status, json } = await admin(endpoint);
    assert.equal(status, 200);
    assert.deepEqual(json.matches, [
        { rateId: RATE_ID, carrier: 'MSC', contractOwner: 'Kings', ownerCompanyName: 'Synthetic Owner', price: 1070,
            rateEffectiveDate: utcDay(2), rateExpirationDate: utcDay(30), bookable: true, withinPriceRange: true },
        { rateId: 'r134-open-end', carrier: 'MSC', contractOwner: 'Kings', ownerCompanyName: 'Synthetic Owner', price: 1284,
            rateEffectiveDate: utcDay(2), rateExpirationDate: null, bookable: true, withinPriceRange: true }
    ]);
    assert.deepEqual(json.sailings.map(row => row.departure), [2, 3, 4, 5, 6].map(utcDay));
    assert.doesNotMatch(JSON.stringify(json), /ownerCompanyId|basePrice|margin|rate20D/);
    const setDate = app.db.prepare('UPDATE managed_agents SET sailing_date = ? WHERE id = ?');
    for (const [day, included] of [[1, false], [30, true], [31, false]]) {
        setDate.run(utcDay(day), agent.id);
        assert.equal((await admin(endpoint)).json.matches.some(row => row.rateId === RATE_ID), included);
    }
    setDate.run(utcDay(2), agent.id);
    assert.deepEqual((await admin(endpoint + '?destinationPort=OAK')).json.matches.map(row => row.rateId), ['r134-alternative']);
    const restricted = await queue({ allowAlternativeRoutes: false, containerType: '20D' });
    checkError(await admin(`/${restricted.id}/matches?destinationPort=OAK`), 403, 'alternatives_not_allowed');
    assert.ok((await admin(`/${restricted.id}/matches`)).json.matches.every(row => !('withinPriceRange' in row)));
    assert.ok(app.db.prepare("SELECT 1 FROM audit_events WHERE event_type = 'admin_managed_agents_read' AND json_extract(detail, '$.agentId') = ?").get(agent.id));
});

it('creates one customer booking under the creator, atomically links it and audits the agent id', async () => {
    const agent = await queue(BOOKING, 'member');
    const results = await Promise.all([book(agent), book(agent)]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
    checkError(results.find(row => row.status === 409), 409, 'already_booked');
    checkError(await book(agent), 409, 'already_booked');
    const rows = app.db.prepare('SELECT * FROM booking_requests').all();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row.requesting_company_id, row.requesting_user_id, row.container_size, row.slots, row.customer_price],
        [BUYER, users.member, '20D', 3, 1070]);
    assert.equal(row.owner_read_at, null);
    assert.equal(app.db.prepare('SELECT booking_request_id FROM managed_agents WHERE id = ?').get(agent.id).booking_request_id, row.id);
    const event = app.db.prepare("SELECT detail FROM audit_events WHERE event_type = 'booking_request_created' AND json_extract(detail, '$.requestId') = ?").get(row.id);
    assert.equal(JSON.parse(event.detail).channel, 'admin_agent');
    assert.equal(JSON.parse(event.detail).agentId, agent.id);
});

it('rejects unauthorized or mismatched bookings before any table changes', async () => {
    const agent = await queue({ ...BOOKING, allowAlternativeRoutes: false });
    const declined = async (id, rateId, status, error) => {
        const before = hashTables(app.db);
        checkError(await book(id, rateId), status, error);
        assert.deepEqual(hashTables(app.db), before);
    };
    await declined(await queue(), RATE_ID, 403, 'booking_not_allowed');
    await declined(await queue({ ...BOOKING, priceMin: 1071, priceMax: 1500 }), RATE_ID, 400, 'price_out_of_range');
    await declined(await queue({ ...BOOKING, priceMin: 0, priceMax: 1069 }), RATE_ID, 400, 'price_out_of_range');
    for (const rateId of ['r134-private', 'r134-alternative', 'r134-missing-size', 'managed-rate-2', 'unknown']) {
        await declined(agent, rateId, 404, 'not_found');
    }
    app.db.prepare("UPDATE managed_agents SET status = 'completed' WHERE id = ?").run(agent.id);
    await declined(agent, RATE_ID, 409, 'invalid_request');
    app.db.prepare("UPDATE managed_agents SET status = 'running' WHERE id = ?").run(agent.id);
    app.db.prepare('UPDATE users SET company_record_id = ? WHERE id = ?').run(OTHER_BUYER, users.creator);
    try {
        await declined(agent, RATE_ID, 409, 'agent_creator_unavailable');
    } finally {
        app.db.prepare('UPDATE users SET company_record_id = ? WHERE id = ?').run(BUYER, users.creator);
    }
    app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(users.creator);
    try {
        await declined(agent, RATE_ID, 409, 'agent_creator_unavailable');
    } finally {
        app.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(users.creator);
    }
    const setType = app.db.prepare('UPDATE companies SET company_type = ?, company_type_id = ? WHERE id = ?');
    setType.run(COMPANY_TYPE_CONTRACT_OWNER, 'contract_owner', BUYER);
    try {
        await declined(agent, RATE_ID, 409, 'agent_creator_unavailable');
        assert.deepEqual((await admin(`/${agent.id}/matches`)).json.matches, []);
    } finally {
        setType.run(COMPANY_TYPE_CUSTOMER, 'freight_forwarder_customer', BUYER);
    }
});

it('books an allowed alternative and refuses an already expired historical match', async () => {
    const alternative = await queue({ ...BOOKING, priceMax: 1284 });
    assert.equal((await book(alternative, 'r134-alternative')).status, 201);
    const historical = await queue(BOOKING);
    app.db.prepare('UPDATE managed_agents SET sailing_date = ? WHERE id = ?').run(utcDay(-2), historical.id);
    const { json } = await admin(`/${historical.id}/matches`);
    assert.equal(json.matches.find(row => row.rateId === 'managed-rate-0').bookable, false);
    const before = hashTables(app.db);
    checkError(await book(historical, 'managed-rate-0'), 400, 'invalid_request');
    assert.deepEqual(hashTables(app.db), before);
});

it('requires integer slots only with booking enabled on create and edit', async () => {
    const agent = await queue(BOOKING);
    for (const slots of [undefined, 0, 1001, 2.5, '3']) {
        const invalid = search({ ...BOOKING, bookingSlots: slots });
        const before = hashTables(app.db);
        for (const [method, suffix, body, row] of [
            ['POST', '', [search(), invalid], 2], ['PUT', `/${agent.id}`, invalid, 1]
        ]) {
            const response = await sessionApi(method, suffix, body);
            assert.equal(response.status, 400, response.text);
            assert.match(response.json.error, new RegExp(`^Row ${row}:.*slots`));
        }
        assert.deepEqual(hashTables(app.db), before);
    }
    for (const bookingSlots of [1, 1000]) {
        assert.equal((await queue({ ...BOOKING, bookingSlots })).bookingSlots, bookingSlots);
        const response = await sessionApi('PUT', `/${agent.id}`, search({ ...BOOKING, bookingSlots }));
        assert.equal(response.status, 200, response.text);
        assert.equal(response.json.agent.bookingSlots, bookingSlots);
    }
    assert.equal((await queue({ bookingSlots: 4 })).bookingSlots, null);
    const result = await sessionApi('PUT', `/${agent.id}`, search({ bookingSlots: 4 }));
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.agent.bookingSlots, null);
});
