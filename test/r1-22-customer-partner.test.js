'use strict';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.NODE_ENV = 'test';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, partnerGet, mcpCall, pkce, REDIRECT_URI } = require('./helpers/r1-12');
const { insertCompany, insertUser, insertRate, insertMargin, activate, login, call, utcDay,
    COMPANY_TYPE_CUSTOMER: CUSTOMER, COMPANY_TYPE_CONTRACT_OWNER: OWNER } = require('./helpers/r1-19');
const { partnerSend } = require('./helpers/r1-21');
const ALL = 'profile:read rates:read sailings:read bookings:read bookings:write';
const ROOT = '/api/partner/v1/me';
const customerTools = ['rateninja_get_my_profile', 'rateninja_list_my_booking_requests',
    'rateninja_get_my_booking_request', 'rateninja_list_available_rates', 'rateninja_create_booking_request'];

describe('R1-22 customer partner boundary', { concurrency: 1 }, () => {
    let app, buyer, sibling, client, token, ownerToken, readToken, ratesToken, createdId;
    const get = (t, p) => partnerGet(app.baseUrl, t, p);
    const rpc = (t, name, args = {}) => mcpCall(app.baseUrl, t, 'tools/call', { name, arguments: args });
    const create = (t, body) => partnerSend(app.baseUrl, t, 'POST', `${ROOT}/booking-requests`, { body });
    const setType = (id, type) => app.db.prepare('UPDATE companies SET company_type = ?, company_type_id = NULL WHERE id = ?').run(type, id);
    const issue = (session, scope = ALL, chosen = client) => authorizeAndToken({ baseUrl: app.baseUrl,
        cookie: session.cookie, csrf: session.csrf, clientId: chosen.id, clientSecret: chosen.secret, scope });
    async function register(name) {
        const response = await app.request('/api/admin/oauth-clients', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: name, clientType: 'confidential', redirectUris: [REDIRECT_URI], allowedScopes: ALL.split(' ') }) });
        const body = await response.json();
        assert.equal(response.status, 201, JSON.stringify(body));
        return { id: body.client.id, secret: body.clientSecret };
    }
    function safe(payload) {
        const text = JSON.stringify(payload);
        assert.doesNotMatch(text, /ownerCompanyId|owner_company_id|marginPercent|marginNumber|margin_percent|margin_number|basePrice|decidedBy|decided_by/);
        for (const base of [8123, 9321, 10431]) assert.equal(text.includes(String(base)), false, text);
    }
    async function refresh(refreshToken) {
        const response = await fetch(`${app.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.id, client_secret: client.secret }) });
        return { status: response.status, body: await response.json() };
    }
    function authParams() {
        const proof = pkce();
        return { proof, params: new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: REDIRECT_URI,
            scope: ALL, state: proof.state, code_challenge: proof.challenge, code_challenge_method: 'S256' }) };
    }
    before(async () => {
        app = await startApp({ companyName: 'Synthetic R22 Owner' });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        for (const [id, type] of [['buyer', CUSTOMER], ['sibling', CUSTOMER], ['unlinked', OWNER], ['revoked', OWNER]]) {
            insertCompany(app.db, { id, name: `Synthetic ${id}`, type });
        }
        for (const id of ['buyer', 'sibling']) {
            insertUser(app.db, { id: `${id}-user`, username: `r22-${id}`, companyId: id });
            activate(`r22-${id}`);
        }
        buyer = await login(app.baseUrl, 'r22-buyer');
        sibling = await login(app.baseUrl, 'r22-sibling');
        insertMargin(app.db, { id: 'buyer-link', owner: app.company.id, customer: 'buyer', percent: 0.1, number: 7 });
        insertMargin(app.db, { id: 'sibling-link', owner: app.company.id, customer: 'sibling', percent: 0.2, number: 9 });
        insertMargin(app.db, { id: 'revoked-link', owner: 'revoked', customer: 'buyer', percent: 0.1, status: 'revoked' });
        for (const [id, expiration] of [['priced', utcDay(40)], ['today', utcDay(0)], ['blank', null], ['expired', utcDay(-1)], ['deleted', null], ['no-price', null]]) {
            insertRate(app.db, { id, owner: app.company.id, rate20: 8123, rate40: 9321, rate40hc: 10431, expiration, notes: 'Synthetic note' });
        }
        app.db.prepare('UPDATE rates SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'deleted');
        app.db.prepare('UPDATE rates SET rate_20d = NULL, rate_40d = NULL, rate_40hc = NULL WHERE id = ?').run('no-price');
        for (const owner of ['unlinked', 'revoked']) insertRate(app.db, { id: `${owner}-rate`, owner });
        client = await register('Synthetic R22 Client');
        token = await issue(buyer);
        ownerToken = await issue(app);
        readToken = await issue(buyer, 'bookings:read', await register('Synthetic R22 Read'));
        ratesToken = await issue(buyer, 'rates:read', await register('Synthetic R22 Rates'));
    });
    after(async () => { process.env.PARTNER_OAUTH_ENABLED = 'true'; if (app) await app.close(); });

    it('completes customer consent, exchange, refresh, and profile without a token role', async () => {
        const { params } = authParams();
        for (const [session, wording] of [[buyer, 'request bookings'], [app, 'approve or decline booking requests']]) {
            const response = await fetch(`${app.baseUrl}/oauth/authorize?${params}`, { headers: { cookie: session.cookie } });
            assert.equal(response.status, 200);
            assert.match(await response.text(), new RegExp(wording));
        }
        const rotated = await refresh(token.refresh_token);
        assert.equal(rotated.status, 200); token = rotated.body;
        const profile = await get(token.access_token, '/oauth/userinfo');
        assert.equal(profile.status, 200); safe(profile.body);
        const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString());
        assert.equal(claims.companyType, undefined); assert.equal(claims.role, undefined);
        safe((await rpc(token.access_token, 'rateninja_get_my_profile')).body);
    });

    it('matches app-grid prices with percent plus fixed margin and exposes only the allowed fields', async () => {
        const grid = await call(app.baseUrl, buyer, 'GET', '/api/rates');
        const api = await get(token.access_token, `${ROOT}/available-rates`);
        const mcp = await rpc(token.access_token, 'rateninja_list_available_rates');
        assert.equal(api.status, 200); assert.deepEqual(mcp.body.result.structuredContent, api.body);
        safe(api.body); safe(mcp.body);
        assert.deepEqual(api.body.data.map(r => r.id).sort(), ['blank', 'expired', 'no-price', 'priced', 'today']);
        for (const rate of api.body.data) {
            const appRate = grid.json.rates.find(r => r.id === rate.id);
            for (const key of ['rate20D', 'rate40D', 'rate40HC']) assert.equal(rate[key], appRate[key]);
            assert.equal(rate.bookable, !['expired', 'no-price'].includes(rate.id));
            assert.deepEqual(Object.keys(rate).sort(), ['id', 'carrier', 'originPort', 'destinationPort', 'inlandDeliveryLocation', 'commodityType', 'contractOwner', 'ownerCompanyName', 'contractNumber', 'rate20D', 'rate40D', 'rate40HC', 'rateEffectiveDate', 'rateExpirationDate', 'notes', 'bookable'].sort());
        }
        const filtered = await get(token.access_token, `${ROOT}/available-rates?carrier=msc&originPort=sha&destinationPort=lax&page=2&pageSize=2`);
        assert.equal(filtered.body.meta.total, 5); assert.equal(filtered.body.data.length, 2);
        assert.deepEqual(filtered.body.data, api.body.data.slice(2, 4));
        assert.equal((await get(token.access_token, `${ROOT}/available-rates?carrier=MS`)).body.meta.total, 0);
        app.db.prepare("UPDATE company_margins SET status = 'revoked' WHERE id = 'buyer-link'").run();
        assert.equal((await get(token.access_token, `${ROOT}/available-rates`)).body.meta.total, 0);
        assert.equal((await rpc(token.access_token, 'rateninja_list_available_rates')).body.result.structuredContent.meta.total, 0);
        app.db.prepare("UPDATE company_margins SET status = 'active' WHERE id = 'buyer-link'").run();
        const audit = app.db.prepare("SELECT client_id FROM audit_events WHERE event_type = 'partner_available_rates_read' ORDER BY rowid DESC LIMIT 1").get();
        assert.equal(audit.client_id, client.id);
    });

    it('publishes exactly five customer tools and byte-identical owner discovery to main', async () => {
        const listed = await mcpCall(app.baseUrl, token.access_token, 'tools/list', {});
        assert.deepEqual(listed.body.result.tools.map(t => t.name), customerTools);
        const createTool = listed.body.result.tools.find(t => t.name === 'rateninja_create_booking_request');
        assert.deepEqual(createTool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
        assert.match(createTool.description, /repeat call creates another request/);
        // SHA-256 of JSON.stringify(tools/list body, id 1) from main 9a5534b.
        // Pin the full bytes without requiring history in CI's shallow checkout.
        const actual = await mcpCall(app.baseUrl, ownerToken.access_token, 'tools/list', {});
        const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(actual.body)).digest('hex');
        assert.equal(digest, '872126b25ad6a6bfc9493bf372d18f9e232c32c4491466ad0076a28344d901be');
    });

    it('creates through API and MCP using the shared snapshot rules and audit context', async () => {
        const body = { rateId: 'priced', containerSize: '20D', slots: 3 };
        const api = await create(token.access_token, { ...body, ownerCompanyId: 'forged', customerPrice: 1 });
        assert.equal(api.status, 201, api.text); createdId = api.body.data.id;
        const mcp = await rpc(token.access_token, 'rateninja_create_booking_request', body);
        assert.equal(mcp.body.result.isError, false, mcp.text);
        const repeat = await create(token.access_token, body);
        assert.notEqual(repeat.body.data.id, createdId);
        for (const [data, channel] of [[api.body.data, 'api'], [mcp.body.result.structuredContent.data, 'mcp']]) {
            safe(data); assert.equal(data.customerPrice, Math.round(8123 * 1.1 + 7));
            const row = app.db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(data.id);
            assert.equal(row.owner_company_id, app.company.id); assert.equal(row.requesting_company_id, 'buyer');
            assert.equal(row.requesting_user_id, 'buyer-user'); assert.equal(row.container_size, '20D'); assert.equal(row.slots, 3);
            assert.equal(row.customer_price, data.customerPrice); assert.equal(row.owner_read_at, null);
            const audit = app.db.prepare("SELECT * FROM audit_events WHERE event_type = 'booking_request_created' AND detail LIKE ?").get(`%${data.id}%`);
            assert.equal(audit.client_id, client.id); assert.equal(JSON.parse(audit.detail).channel, channel);
        }
        assert.equal((await call(app.baseUrl, app, 'GET', '/api/booking-requests/unread')).json.unread, 3);
    });

    it('enforces audience before arguments, body reads, ids and scopes on API and MCP', async () => {
        for (const p of [`${ROOT}/rates`, `${ROOT}/rates/priced`, `${ROOT}/sailings`, `${ROOT}/sailings/fake`, `${ROOT}/predictive-pricing`]) {
            const r = await get(token.access_token, p); assert.equal(r.status, 403, r.text); assert.equal(r.body.error, 'owner_only');
        }
        const denied = await partnerSend(app.baseUrl, token.access_token, 'POST', `${ROOT}/booking-requests/${createdId}/decision`, { raw: '{' });
        assert.equal(denied.status, 403); assert.equal(denied.body.error, 'owner_only');
        for (const name of ['rateninja_list_my_rates', 'rateninja_get_my_rate', 'rateninja_list_my_sailings', 'rateninja_get_my_sailing', 'rateninja_get_my_predictive_pricing', 'rateninja_decide_booking_request']) {
            const r = await rpc(ratesToken.access_token, name, { requestId: createdId, decision: 'approved', unexpected: true });
            assert.equal(r.body.result.isError, true); assert.equal(r.body.result.structuredContent.error, 'owner_only', r.text);
        }
        for (const p of [`${ROOT}/available-rates`]) {
            const r = await get(ownerToken.access_token, p); assert.equal(r.status, 403); assert.equal(r.body.error, 'customer_only');
        }
        const ownerCreate = await partnerSend(app.baseUrl, ownerToken.access_token, 'POST', `${ROOT}/booking-requests`, { raw: '{' });
        assert.equal(ownerCreate.body.error, 'customer_only');
        for (const name of ['rateninja_list_available_rates', 'rateninja_create_booking_request']) {
            const r = await rpc(ownerToken.access_token, name, { bogus: 1 });
            assert.equal(r.body.result.structuredContent.error, 'customer_only');
        }
        assert.equal((await get('bad-token', `${ROOT}/available-rates`)).status, 401);
        assert.equal((await create(readToken.access_token, {})).body.error, 'insufficient_scope');
        assert.equal((await rpc(readToken.access_token, 'rateninja_create_booking_request', {})).body.result.structuredContent.error, 'insufficient_scope');
        assert.equal((await get(ratesToken.access_token, `${ROOT}/booking-requests`)).body.error, 'insufficient_scope');
        assert.equal((await rpc(ratesToken.access_token, 'rateninja_list_my_booking_requests')).body.result.structuredContent.error, 'insufficient_scope');
    });

    it('matches app validation for sizes, slots, expiration and invisible rates on both transports', async () => {
        const base = { rateId: 'priced', containerSize: '20D', slots: 1 };
        for (const patch of [{ slots: 0 }, { slots: 1.5 }, { slots: 1001 }, { slots: '2' }, { containerSize: 'bad' }, { rateId: 'expired' }, { rateId: 'no-price' }, ...['unlinked-rate', 'revoked-rate', 'deleted', 'missing'].map(rateId => ({ rateId }))]) {
            const body = { ...base, ...patch };
            const appResult = await call(app.baseUrl, buyer, 'POST', '/api/booking-requests', body);
            const api = await create(token.access_token, body);
            const mcp = await rpc(token.access_token, 'rateninja_create_booking_request', body);
            assert.equal(api.status, appResult.status, api.text);
            assert.equal(mcp.body.result.isError, true, mcp.text);
            assert.equal(mcp.body.result.structuredContent.error, api.body.error);
            if (api.status === 404) assert.deepEqual(api.body, { error: 'not_found', error_description: 'Not found.' });
        }
    });

    it('isolates customer booking views and keeps reads from changing unread state', async () => {
        const siblingToken = await issue(sibling);
        const other = await create(siblingToken.access_token, { rateId: 'priced', containerSize: '40D', slots: 1 });
        const missing = await get(token.access_token, `${ROOT}/booking-requests/missing`);
        const hidden = await get(token.access_token, `${ROOT}/booking-requests/${other.body.data.id}`);
        assert.deepEqual(hidden, { ...missing, text: missing.text });
        const hiddenMcp = await rpc(token.access_token, 'rateninja_get_my_booking_request', { requestId: other.body.data.id });
        assert.deepEqual(hiddenMcp.body.result.structuredContent, missing.body);
        const decision = await partnerSend(app.baseUrl, ownerToken.access_token, 'POST', `${ROOT}/booking-requests/${createdId}/decision`, { body: { decision: 'approved' } });
        assert.equal(decision.status, 200);
        const api = await get(token.access_token, `${ROOT}/booking-requests?status=approved&page=1&pageSize=1`);
        assert.equal(api.body.meta.total, 1); assert.equal(api.body.data[0].id, createdId); safe(api.body);
        const mcp = await rpc(token.access_token, 'rateninja_list_my_booking_requests', { status: 'approved', page: 1, pageSize: 1 });
        assert.deepEqual(mcp.body.result.structuredContent, api.body);
        const one = await get(token.access_token, `${ROOT}/booking-requests/${createdId}`); safe(one.body);
        assert.equal(one.body.data.side, 'customer'); assert.equal(one.body.data.unread, true);
        safe((await rpc(token.access_token, 'rateninja_get_my_booking_request', { requestId: createdId })).body);
        const row = app.db.prepare('SELECT owner_read_at, customer_read_at FROM booking_requests WHERE id = ?').get(createdId);
        assert.equal(row.customer_read_at, null); assert.equal(row.owner_read_at, null);
        assert.equal((await call(app.baseUrl, buyer, 'GET', '/api/booking-requests/unread')).json.unread, 1);
        assert.equal((await get(token.access_token, `${ROOT}/booking-requests?status=bad`)).status, 400);
    });

    it('uses live company type in both directions and never carries old owner reach', async () => {
        setType(app.company.id, CUSTOMER);
        assert.equal((await get(ownerToken.access_token, `${ROOT}/rates/priced`)).body.error, 'owner_only');
        assert.equal((await get(ownerToken.access_token, `${ROOT}/booking-requests`)).body.meta.total, 0);
        assert.equal((await get(ownerToken.access_token, `${ROOT}/booking-requests/${createdId}`)).status, 404);
        const list = await mcpCall(app.baseUrl, ownerToken.access_token, 'tools/list', {});
        assert.deepEqual(list.body.result.tools.map(t => t.name), customerTools);
        assert.equal((await rpc(ownerToken.access_token, 'rateninja_get_my_rate', { rateId: 'priced' })).body.result.structuredContent.error, 'owner_only');
        setType(app.company.id, OWNER);
        setType('buyer', OWNER);
        assert.equal((await get(token.access_token, `${ROOT}/available-rates`)).body.error, 'customer_only');
        assert.equal((await get(token.access_token, `${ROOT}/booking-requests`)).body.meta.total, 0);
        assert.equal((await get(token.access_token, `${ROOT}/booking-requests/${createdId}`)).status, 404);
        assert.equal((await rpc(token.access_token, 'rateninja_create_booking_request', {})).body.result.structuredContent.error, 'customer_only');
        assert.equal((await get(token.access_token, `${ROOT}/rates`)).status, 200);
        setType('buyer', CUSTOMER);
    });

    it('refuses blank and unsupported types at every OAuth boundary, including mid-token changes', async () => {
        for (const type of ['', 'Unsupported']) {
            setType('buyer', type);
            const { params } = authParams();
            const denied = await fetch(`${app.baseUrl}/oauth/authorize?${params}`, { headers: { cookie: buyer.cookie }, redirect: 'manual' });
            assert.equal(denied.status, 302); assert.match(denied.headers.get('location'), /unsupported_company_type/);
            const complete = await fetch(`${app.baseUrl}/oauth/authorize`, { method: 'POST', headers: { cookie: buyer.cookie, 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: buyer.csrf }), redirect: 'manual' });
            assert.match(complete.headers.get('location'), /unsupported_company_type/);
            assert.equal((await get(token.access_token, `${ROOT}/available-rates`)).status, 401);
            assert.equal((await refresh(token.refresh_token)).status, 400);
            assert.equal((await call(app.baseUrl, buyer, 'GET', '/oauth/consents')).status, 403);
            assert.equal((await call(app.baseUrl, buyer, 'DELETE', `/oauth/consents/${client.id}`)).status, 403);
            setType('buyer', CUSTOMER);
        }
        const { params, proof } = authParams();
        const approved = await fetch(`${app.baseUrl}/oauth/authorize`, { method: 'POST', headers: { cookie: buyer.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: buyer.csrf }), redirect: 'manual' });
        const code = new URL(approved.headers.get('location')).searchParams.get('code'); assert.ok(code);
        setType('buyer', '');
        const exchanged = await fetch(`${app.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: client.id, client_secret: client.secret, code_verifier: proof.verifier }) });
        assert.equal(exchanged.status, 400);
        setType('buyer', CUSTOMER); token = await issue(buyer);
    });

    it('allows customer Connected apps to list and revoke, invalidating access and refresh tokens', async () => {
        const page = await call(app.baseUrl, buyer, 'GET', '/profile/connected-apps'); assert.equal(page.status, 200);
        const grants = await call(app.baseUrl, buyer, 'GET', '/oauth/consents');
        assert.equal(grants.status, 200); assert.ok(grants.json.grants.some(g => g.clientId === client.id));
        const revoked = await call(app.baseUrl, buyer, 'DELETE', `/oauth/consents/${client.id}`); assert.equal(revoked.status, 200);
        assert.equal((await get(token.access_token, `${ROOT}/available-rates`)).status, 401);
        assert.equal((await refresh(token.refresh_token)).status, 400);
        token = await issue(buyer);
    });

    it('keeps discovery at three scopes and blocks new surfaces when OAuth is disabled', async () => {
        for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
            const response = await get('', p); assert.deepEqual(response.body.scopes_supported, ['profile:read', 'rates:read', 'sailings:read']);
        }
        process.env.PARTNER_OAUTH_ENABLED = 'false';
        try {
            assert.equal((await get(token.access_token, `${ROOT}/available-rates`)).status, 403);
            assert.equal((await create(token.access_token, {})).status, 403);
            assert.equal((await rpc(token.access_token, 'rateninja_list_available_rates')).status, 403);
            assert.equal((await rpc(token.access_token, 'rateninja_create_booking_request')).status, 403);
        } finally { process.env.PARTNER_OAUTH_ENABLED = 'true'; }
    });
});

describe('R1-22 Connected apps menu', () => {
    it('carries companyType through both normalizers and hides blank or unsupported types', async () => {
        const { permissionsFromUser, ANONYMOUS } = await import('../public/js/permissions.js');
        const { menuFor } = await import('../public/js/menu.js');
        assert.equal(ANONYMOUS.companyType, '');
        for (const companyType of [OWNER, CUSTOMER, '', 'Unsupported']) {
            for (const modern of [true, false]) {
                const user = { companyType, isContractOwner: companyType === OWNER };
                if (modern) user.permissions = { contractOwner: companyType === OWNER };
                const permissions = permissionsFromUser(user);
                assert.equal(permissions.companyType, companyType);
                assert.equal(menuFor(permissions).some(item => item.id === 'connected-apps'), [OWNER, CUSTOMER].includes(companyType));
            }
        }
    });
});
