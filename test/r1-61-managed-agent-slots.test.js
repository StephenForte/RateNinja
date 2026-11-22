'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { activate, call, login } = require('./helpers/r1-19');
const { applyAdminKey } = require('./helpers/r1-25');
const { search, seedManagedAgents } = require('./helpers/r1-33');
const { ADMIN_KEY, ROOT } = require('./helpers/r1-34');
const { CODE, startCloudBbs } = require('./helpers/r1-37');

const rateId = 'managed-rate-1';
const requested = search({
    containerType: '20D', allowAlternativeRoutes: false, allowBookingRequest: true,
    bookingSlots: 12, priceMin: 0, priceMax: 2000
});
let app;
let cloud;
let session;

before(async () => {
    cloud = await startCloudBbs();
    cloud.configureServer();
    app = await startApp();
    const { creator } = seedManagedAgents(app.db);
    activate(creator);
    session = await login(app.baseUrl, creator);
    applyAdminKey(ADMIN_KEY);
});

after(async () => { await app?.close(); await cloud?.close(); });

function setMax(max) {
    app.db.prepare('UPDATE rates SET max_slots_allowed = ? WHERE id = ?').run(max, rateId);
}

beforeEach(() => {
    app.db.exec('DELETE FROM booking_requests; DELETE FROM managed_agents;');
    setMax(3);
});

function sessionApi(method, body, id = '') {
    return call(app.baseUrl, session, method, '/api/managed-agents' + id, body);
}

async function queue(overrides) {
    const result = await sessionApi('POST', [{ ...requested, ...overrides }]);
    assert.equal(result.status, 201, result.text);
    return result.json.agents[0];
}

async function admin(id, path, body) {
    const response = await app.request(ROOT + '/' + id + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-admin-api-key': ADMIN_KEY, 'content-type': 'application/json' },
        cookie: false,
        csrf: false,
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, json: await response.json() };
}

async function match(agent) {
    const result = await admin(agent.id, '/matches');
    assert.equal(result.status, 200);
    const row = result.json.matches.find(row => row.rateId === rateId);
    assert.equal(row.price, 1070);
    assert.equal(row.withinPriceRange, true);
    return row;
}

function book(agent) {
    return admin(agent.id, '/booking-requests', { rateId, bookingCode: CODE });
}

function storedFlag(id) {
    return app.db.prepare('SELECT accept_max_slots FROM managed_agents WHERE id = ?').get(id).accept_max_slots;
}

function storedBookings() {
    return app.db.prepare('SELECT id, slots FROM booking_requests').all().map(row => ({ ...row }));
}

it('validates the optional boolean, includes it in duplicate detection, and persists edits', async () => {
    for (const acceptMaxSlots of ['yes', null]) {
        const result = await sessionApi('POST', [{ ...requested, acceptMaxSlots }]);
        assert.equal(result.status, 400);
        assert.match(result.json.error, /acceptMaxSlots/);
    }
    const off = await queue({ allowBookingRequest: false, acceptMaxSlots: true });
    assert.equal(off.acceptMaxSlots, false);
    assert.equal(storedFlag(off.id), 0);

    const result = await sessionApi('POST', [requested, { ...requested, acceptMaxSlots: true }]);
    assert.equal(result.status, 201, result.text);
    const [omitted, enabled] = result.json.agents;
    assert.deepEqual([omitted.acceptMaxSlots, enabled.acceptMaxSlots], [false, true]);
    assert.deepEqual([storedFlag(omitted.id), storedFlag(enabled.id)], [0, 1]);

    for (const [id, acceptMaxSlots] of [[omitted.id, true], [enabled.id, false]]) {
        const edited = await sessionApi('PUT', { ...requested, acceptMaxSlots }, '/' + id);
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.json.agent.acceptMaxSlots, acceptMaxSlots);
        assert.equal(storedFlag(id), Number(acceptMaxSlots));
    }
    const disabled = await sessionApi('PUT',
        { ...requested, allowBookingRequest: false, acceptMaxSlots: true }, '/' + omitted.id);
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.json.agent.acceptMaxSlots, false);
    assert.equal(storedFlag(omitted.id), 0);
});

for (const { title, max, slots, currentMax, expected } of [
    { title: 'clamps 12 to 3', max: 3, slots: 12, expected: 3 },
    { title: 'keeps a request that fits', max: 3, slots: 2, expected: 2 },
    { title: 'keeps the requested count for a null maximum', max: null, slots: 12, expected: 12 },
    { title: 'uses the lower maximum at booking time', max: 3, slots: 12, currentMax: 2, expected: 2 }
]) {
    it(title, async () => {
        setMax(max);
        const agent = await queue({ bookingSlots: slots, acceptMaxSlots: true });
        const row = await match(agent);
        assert.equal(row.bookable, true);
        assert.equal(row.slotsToBook, max === null ? slots : Math.min(slots, max));
        if (currentMax !== undefined) setMax(currentMax);
        const booking = await book(agent);
        assert.equal(booking.status, 201, JSON.stringify(booking.json));
        assert.equal(booking.json.booking.slots, expected);
        assert.deepEqual(storedBookings(), [{ id: booking.json.booking.id, slots: expected }]);
    });
}

for (const { title, acceptMaxSlots, max, currentMax, error } of [
    { title: 'refuses over-limit requests with opt-in off', acceptMaxSlots: false, max: 3, error: /at most 3 slots/ },
    { title: 'refuses a zero rate with opt-in on', acceptMaxSlots: true, max: 0, error: /no slots available/ },
    { title: 'refuses a rate lowered to zero after matching', acceptMaxSlots: true, max: 3, currentMax: 0, error: /no slots available/ }
]) {
    it(title, async () => {
        setMax(max);
        const agent = await queue({ acceptMaxSlots });
        assert.equal((await match(agent)).bookable, currentMax !== undefined);
        if (currentMax !== undefined) setMax(currentMax);
        const booking = await book(agent);
        assert.equal(booking.status, 400, JSON.stringify(booking.json));
        assert.match(booking.json.error_description, error);
        assert.deepEqual(storedBookings(), []);
        assert.equal(app.db.prepare('SELECT booking_request_id FROM managed_agents WHERE id = ?').get(agent.id)
            .booking_request_id, null);
    });
}
