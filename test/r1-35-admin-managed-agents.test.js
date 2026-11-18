'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { activate, login, call, insertRate, utcDay } = require('./helpers/r1-19');
const { seedManagedAgents, search, BUYER, RATE_TYPE } = require('./helpers/r1-33');
const { applyAdminKey } = require('./helpers/r1-25');
const { hashTables } = require('./helpers/r1-34');
const { ADMIN_KEY, ROOT, PAYLOAD, serveProviders, cli } = require('./helpers/r1-35');

const userPath = '/api/managed-agents';
const booking = { allowBookingRequest: true, bookingSlots: 4, containerType: '20D', priceMin: 1000, priceMax: 1100 };
const completed = { status: 'completed', resultSummary: ' ' + PAYLOAD + ' ' };
let app;
let users;
let customer;

async function admin(id, step, body, key = ADMIN_KEY) {
    const response = await app.request(ROOT + '/' + id + '/' + step, {
        method: 'POST', cookie: false, csrf: false,
        headers: { ...(key ? { 'x-admin-api-key': key } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
}

function errorIs(result, status, error) {
    assert.equal(result.status, status, JSON.stringify(result.json));
    assert.equal(result.json.error, error);
}

function customerCall(method, suffix = '', body) {
    return call(app.baseUrl, customer, method, userPath + suffix, body);
}

async function queue(options = {}) {
    const response = await customerCall('POST', '', [search(options)]);
    assert.equal(response.status, 201, response.text);
    return response.json.agents[0];
}

function stored(id) {
    return app.db.prepare('SELECT * FROM managed_agents WHERE id = ?').get(id);
}

function otherTableHashes() {
    const hashes = hashTables(app.db, { skipAudit: true });
    delete hashes.managed_agents;
    delete hashes.booking_requests;
    return hashes;
}

before(async () => {
    app = await startApp();
    users = seedManagedAgents(app.db);
    activate(users.creator);
    customer = await login(app.baseUrl, users.creator);
    insertRate(app.db, { id: 'synthetic-oak', owner: 'managed-owner', destination: 'OAK',
        effective: utcDay(2), expiration: utcDay(30) });
    app.db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'synthetic-oak');
});
beforeEach(() => {
    app.db.exec('DELETE FROM booking_requests; DELETE FROM managed_agents;');
    applyAdminKey(ADMIN_KEY);
});
after(async () => { await app?.close(); });

it('requires a configured and valid admin key for both state mutations', async () => {
    for (const step of ['start', 'finish']) {
        errorIs(await admin('missing', step, completed, null), 401, 'invalid_admin_key');
        errorIs(await admin('missing', step, completed, 'wrong'), 401, 'invalid_admin_key');
        applyAdminKey('');
        errorIs(await admin('missing', step, completed), 503, 'admin_api_disabled');
        applyAdminKey(ADMIN_KEY);
    }
});

it('starts a queued agent once and rejects edits, deletes and repeated starts', async () => {
    const changed = await queue();
    const discarded = await queue();
    assert.equal((await customerCall('DELETE', '/' + discarded.id)).status, 204);
    errorIs(await admin(discarded.id, 'start'), 404, 'not_found');

    const results = await Promise.all([admin(changed.id, 'start'), admin(changed.id, 'start')]);
    const [winner, loser] = results.sort((a, b) => a.status - b.status);
    assert.equal(winner.status, 200);
    assert.equal(winner.json.agent.status, 'running');
    assert.equal(winner.json.agent.id, changed.id);
    assert.equal(winner.json.agent.startedAt, stored(changed.id).started_at);
    assert.ok(Number.isFinite(Date.parse(winner.json.agent.startedAt)));
    errorIs(loser, 409, 'not_queued');
    errorIs(await admin(changed.id, 'start'), 409, 'not_queued');
    assert.equal((await customerCall('PUT', '/' + changed.id, search())).status, 409);
    assert.equal((await customerCall('DELETE', '/' + changed.id)).status, 409);
    const events = app.db.prepare("SELECT detail FROM audit_events WHERE event_type = 'managed_agent_started'").all();
    assert.equal(events.filter(row => JSON.parse(row.detail).agentId === changed.id).length, 1);
});

it('validates finish, trims text, writes each terminal state with an audit, and preserves the booking link', async () => {
    const booked = await queue(booking);
    const failed = await queue();
    errorIs(await admin(booked.id, 'finish', completed), 409, 'not_running');
    assert.equal((await admin(booked.id, 'start')).status, 200);
    assert.equal((await admin(failed.id, 'start')).status, 200);

    for (const body of [
        { status: 'cancelled', resultSummary: 'invalid status' },
        { status: 'completed', resultSummary: '  ' },
        { status: 'completed', resultSummary: 'x'.repeat(1001) }
    ]) {
        errorIs(await admin(booked.id, 'finish', body), 400, 'invalid_request');
    }
    assert.equal(stored(booked.id).status, 'running');

    const bookedResult = await admin(booked.id, 'booking-requests', { rateId: 'managed-rate-1' });
    assert.equal(bookedResult.status, 201, JSON.stringify(bookedResult.json));
    const bookingId = bookedResult.json.booking.id;
    const done = await admin(booked.id, 'finish', completed);
    assert.equal(done.status, 200);
    assert.equal(done.json.agent.bookingRequestId, bookingId);
    assert.equal(done.json.agent.resultSummary, PAYLOAD);
    assert.equal(done.json.agent.finishedAt, stored(booked.id).finished_at);
    assert.ok(Number.isFinite(Date.parse(done.json.agent.finishedAt)));
    assert.equal(stored(booked.id).booking_request_id, bookingId);
    assert.equal(stored(booked.id).status, 'completed');
    assert.equal(stored(booked.id).result_summary, PAYLOAD);
    errorIs(await admin(booked.id, 'finish', completed), 409, 'not_running');

    const failedResult = await admin(failed.id, 'finish', { status: 'failed', resultSummary: 'x'.repeat(1000) });
    assert.equal(failedResult.status, 200);
    assert.ok(Number.isFinite(Date.parse(stored(failed.id).finished_at)));
    assert.equal(stored(failed.id).status, 'failed');
    const events = app.db.prepare("SELECT detail FROM audit_events WHERE event_type = 'managed_agent_finished'").all();
    for (const [id, status] of [[booked.id, 'completed'], [failed.id, 'failed']]) {
        assert.deepEqual(events.map(row => JSON.parse(row.detail)).filter(detail => detail.agentId === id),
            [{ agentId: id, companyId: BUYER, status }]);
    }
});

it('runs the actual CLI against a temporary server and keeps writes confined to agents, bookings and audit', async t => {
    const booked = await queue(booking);
    const unbooked = await queue({ allowAlternativeRoutes: false });
    const providers = await serveProviders({
        lanes: [{ originPort: 'SHA', destinationPort: 'LAX' }, { originPort: 'SHA', destinationPort: 'OAK' }],
        alternatives: () => ['OAK', 'off-list-port'],
        judge: input => ({
            rateId: input.allowBookingRequest ? 'synthetic-oak' : null,
            summary: 'Best synthetic customer price USD 1,070 on MSC. ' + PAYLOAD
        })
    });
    t.after(() => providers.close());
    const before = otherTableHashes();

    const cancel = await cli(app, providers, [], '12\nn\n8\n');
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, /Run queued managed agents\?.*\bCancelled/);
    assert.equal(providers.calls.length, 0);
    assert.equal(stored(booked.id).status, 'queued');
    assert.equal(stored(unbooked.id).status, 'queued');

    const result = await cli(app, providers, ['managed-agents-run', '--yes']);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Run queued managed agents\?/);
    assert.match(result.stdout, /Agent ID.*Company.*Outcome.*Booking ID/);
    assert.equal(providers.posts.length, 1);
    assert.match(providers.posts[0].body, /Agents run: 2\nCompleted: 2\nFailed: 0\nBookings made: 1\nAlready running: 0/);
    const bookings = app.db.prepare('SELECT * FROM booking_requests').all();
    assert.equal(bookings.length, 1);
    const [created] = bookings;
    assert.equal(created.requesting_user_id, users.creator);
    assert.equal(created.requesting_company_id, BUYER);
    assert.equal(created.slots, booking.bookingSlots);
    assert.equal(created.rate_id, 'synthetic-oak');
    assert.equal(created.customer_price, 1070);
    assert.match(result.stdout, new RegExp(created.id));
    for (const [agent, bookingId] of [[booked, created.id], [unbooked, null]]) {
        const row = stored(agent.id);
        assert.equal(row.status, 'completed');
        assert.ok(Number.isFinite(Date.parse(row.started_at)));
        assert.ok(Number.isFinite(Date.parse(row.finished_at)));
        assert.ok(row.result_summary.includes(PAYLOAD));
        assert.equal(row.booking_request_id, bookingId);
    }
    assert.deepEqual(otherTableHashes(), before);

    const visible = (await customerCall('GET')).json.agents;
    assert.equal(visible.find(agent => agent.id === booked.id).bookingRequestId, created.id);
    assert.equal(visible.find(agent => agent.id === unbooked.id).bookingRequestId, null);
    assert.ok(visible.find(agent => agent.id === booked.id).resultSummary.includes(PAYLOAD));
});
