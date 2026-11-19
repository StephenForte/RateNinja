'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const { activate, call, login } = require('./helpers/r1-19');
const { partnerSend } = require('./helpers/r1-21');
const { applyAdminKey } = require('./helpers/r1-25');
const { search, seedManagedAgents } = require('./helpers/r1-33');
const { ADMIN_KEY, ROOT } = require('./helpers/r1-34');
const { CODE, SERVER_TOKEN, startCloudBbs } = require('./helpers/r1-37');

const toolName = 'rateninja_create_booking_request';
const bookingPath = '/api/partner/v1/me/booking-requests';
const booking = { rateId: 'managed-rate-1', containerSize: '20D', slots: 2 };
const agentSearch = search({ allowBookingRequest: true, bookingSlots: 2, containerType: '20D', priceMin: 1000, priceMax: 1100 });
let app;
let buyer;
let token;
let draft;
let cloud;

before(async () => {
    process.env.PARTNER_OAUTH_ENABLED = 'true';
    cloud = await startCloudBbs();
    cloud.configureServer();
    app = await startApp();
    applyAdminKey(ADMIN_KEY);
    app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
    const users = seedManagedAgents(app.db);
    activate(users.creator);
    buyer = await login(app.baseUrl, users.creator);
    const registered = await app.request('/api/admin/oauth-clients', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Synthetic R1-37', clientType: 'confidential',
            redirectUris: [REDIRECT_URI], allowedScopes: ['bookings:write'] })
    });
    assert.equal(registered.status, 201);
    const { client, clientSecret } = await registered.json();
    const oauth = await authorizeAndToken({ baseUrl: app.baseUrl, cookie: buyer.cookie, csrf: buyer.csrf,
        clientId: client.id, clientSecret, scope: 'bookings:write' });
    token = oauth.access_token;
    draft = await queueAgent();
});

after(async () => {
    await app?.close();
    await cloud?.close();
});

async function queueAgent() {
    const queued = await call(app.baseUrl, buyer, 'POST', '/api/managed-agents', [agentSearch]);
    assert.equal(queued.status, 201, queued.text);
    return queued.json.agents[0].id;
}

function codeField(code) {
    return code === undefined ? {} : { bookingCode: code };
}

const paths = {
    partner: code => partnerSend(app.baseUrl, token, 'POST', bookingPath, { body: { ...booking, ...codeField(code) } }),
    mcp: code => mcpCall(app.baseUrl, token, 'tools/call', { name: toolName, arguments: { ...booking, ...codeField(code) } }),
    admin: async (code, id = draft) => {
        const response = await app.request(`${ROOT}/${id}/booking-requests`, {
            method: 'POST', cookie: false, csrf: false,
            headers: { 'content-type': 'application/json', 'x-admin-api-key': ADMIN_KEY },
            body: JSON.stringify({ rateId: booking.rateId, ...codeField(code) })
        });
        const text = await response.text();
        return { status: response.status, body: JSON.parse(text), text };
    }
};

function verifyNoBooking() {
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM booking_requests').get().n, 0);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'booking_request_created'").get().n, 0);
    assert.equal(app.db.prepare('SELECT booking_request_id FROM managed_agents WHERE id = ?').get(draft).booking_request_id, null);
}

function assertNoValues(text) {
    assert.equal(text.toUpperCase().includes(CODE), false);
    assert.equal(text.toLowerCase().includes(SERVER_TOKEN), false);
}

async function refused(code, status, error) {
    const results = await Promise.all(Object.values(paths).map(send => send(code)));
    for (const { status: actual, body, text } of results) {
        assert.equal(actual, status, text);
        assert.equal(body.error ?? body.result.structuredContent.error, error);
        if (body.result) assert.equal(body.result.isError, true);
        assertNoValues(text);
    }
    verifyNoBooking();
}

it('fails closed on all three routes and leaves booking and audit state untouched', async t => {
    const logs = ['error', 'warn', 'log'].map(method => t.mock.method(console, method, () => {}));

    await t.test('no server token and no CLI credential fallback', async () => {
        delete process.env.CLOUDBBS_SERVER_TOKEN;
        process.env.CLOUDBBS_AGENT_TOKEN = SERVER_TOKEN;
        process.env.CLOUDBBS_TOKEN = SERVER_TOKEN;
        await refused(CODE, 503, 'booking_code_unavailable');
        await refused('', 503, 'booking_code_unavailable');
        assert.equal(cloud.calls.length, 0);
        cloud.configureServer();
    });

    for (const mode of ['error', 'timeout', 'no announcement', 'no code', 'malformed code']) {
        await t.test(mode, async () => {
            cloud.mode = mode;
            cloud.code = mode === 'malformed code' ? 'MALFORMED!' : CODE;
            await refused(CODE, 503, 'booking_code_unavailable');
            await refused('', 503, 'booking_code_unavailable');
        });
    }

    cloud.mode = 'ok';
    cloud.code = CODE;
    for (const value of ['WRONG0000', undefined, '', '   ']) {
        await refused(value, 403, 'invalid_booking_code');
    }
    for (const log of logs) assertNoValues(JSON.stringify(log.mock.calls.map(entry => entry.arguments)));
});

it('publishes the code schema and keeps website booking independent of CloudBBS', async () => {
    const callsBefore = cloud.calls.length;
    const listed = await mcpCall(app.baseUrl, token, 'tools/list', {});
    const schema = listed.body.result.tools.find(tool => tool.name === toolName).inputSchema;
    assert.ok(schema.required.includes('bookingCode'));
    assert.equal(schema.properties.bookingCode.type, 'string');

    const result = await call(app.baseUrl, buyer, 'POST', '/api/booking-requests', booking);
    assert.equal(result.status, 201, result.text);
    assertNoValues(result.text);
    assert.equal(cloud.calls.length, callsBefore);
});

it('creates through all three paths and never persists or returns the code or token', async t => {
    const logs = ['error', 'warn', 'log'].map(method => t.mock.method(console, method, () => {}));
    let first = true;
    for (const value of [CODE, CODE.toLowerCase(), `  ${CODE} \t`]) {
        const adminId = first ? draft : await queueAgent();
        first = false;
        const partner = await paths.partner(value);
        const mcp = await paths.mcp(value);
        const admin = await paths.admin(value, adminId);
        assert.equal(partner.status, 201, partner.text);
        assert.equal(mcp.status, 200, mcp.text);
        assert.equal(mcp.body.result.isError, false);
        assert.equal(admin.status, 201, admin.text);
        for (const { text } of [partner, mcp, admin]) assertNoValues(text);
    }
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM booking_requests').get().n, 10);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'booking_request_created'").get().n, 10);
    for (const { name } of app.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
        const rows = app.db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all();
        assertNoValues(JSON.stringify(rows));
    }
    for (const log of logs) assertNoValues(JSON.stringify(log.mock.calls.map(entry => entry.arguments)));
});

it('shares in-flight reads and refreshes exactly at the 60-second cache boundary', async t => {
    const fake = await startCloudBbs();
    t.after(() => fake.close());
    const { createBookingCodeCheck } = require('../lib/booking-code');
    let now = 0;
    const check = createBookingCodeCheck({
        now: () => now,
        settings: () => ({ baseUrl: fake.url, project: 'rn', token: SERVER_TOKEN, agentName: 'synthetic-server' })
    });
    assert.deepEqual(await Promise.all([check(CODE), check(CODE)]), [null, null]);
    assert.deepEqual(fake.calls.map(call => call.name), ['connect_agent', 'list_projects', 'check_board']);
    fake.code = 'SYNTH37B9';
    now = 59_999;
    assert.equal(await check(CODE), null);
    assert.equal(fake.calls.length, 3);
    now = 60_000;
    assert.deepEqual(await check(CODE), { status: 403, error: 'invalid_booking_code' });
    assert.equal(await check(fake.code), null);
    assert.equal(fake.calls.length, 6);
    for (const call of fake.calls) {
        assert.equal(call.method, 'POST');
        assert.equal(call.path, '/api/mcp');
        assert.equal(call.authorized, true);
        if (call.name === 'check_board') {
            assert.equal(call.args.project_id, 'synthetic-rn');
            assert.equal(call.args.continuation, undefined);
        }
    }

    now += 60_000;
    fake.mode = 'error';
    assert.deepEqual(await check(fake.code), { status: 503, error: 'booking_code_unavailable' });
    fake.mode = 'ok';
    assert.equal(await check(fake.code), null);
});
