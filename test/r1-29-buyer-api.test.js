'use strict';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.NODE_ENV = 'test';
process.env.RATE_NINJA_API_KEY = 'synthetic-demo-key';
process.env.RATE_NINJA_ADMIN_API_KEY = 'a'.repeat(32);
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, partnerGet, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const { insertCompany, insertUser, insertRate, insertMargin, activate, login, call,
    COMPANY_TYPE_CUSTOMER: CUSTOMER, COMPANY_TYPE_CONTRACT_OWNER: OWNER } = require('./helpers/r1-19');
const { createKey } = require('./helpers/r1-31');
const ROOT = '/api/partner/v1/me';
let KEY;

describe('R1-29 buyer credential boundary', { concurrency: 1 }, () => {
    let app, config, buyer, token, ownerToken;
    async function request(path, { key = KEY, headers = {}, method = 'GET', body } = {}) {
        const response = await fetch(app.baseUrl + path, { method, redirect: 'manual', headers: {
            ...(key === null ? {} : { 'X-Buyer-API-Key': key }), ...headers,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
        }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, body: json, text };
    }
    async function denied(path, status, error, options) {
        const result = await request(path, options);
        assert.equal(result.status, status, result.text);
        if (error) assert.equal(result.body.error, error, result.text);
        assert.equal(result.body?.data, undefined);
    }
    before(async () => {
        app = await startApp();
        app.db.prepare('UPDATE users SET is_system_admin=1 WHERE username=?').run(app.username);
        config = require('../lib/config').config;
        for (const [id, type] of [['buyer', CUSTOMER], ['owner-b', OWNER], ['inactive', OWNER]]) {
            insertCompany(app.db, { id, name: `Synthetic ${id}`, type });
        }
        insertUser(app.db, { id: 'buyer-user', username: 'synthetic-buyer', companyId: 'buyer', displayName: 'Test Buyer' });
        activate('synthetic-buyer'); buyer = await login(app.baseUrl, 'synthetic-buyer');
        KEY = (await createKey(app.baseUrl, buyer)).key;
        insertMargin(app.db, { id: 'active-link', owner: app.company.id, customer: 'buyer', percent: 0.1, number: 7 });
        insertMargin(app.db, { id: 'inactive-link', owner: 'inactive', customer: 'buyer', percent: 0.2, status: 'revoked' });
        insertRate(app.db, { id: 'priced', owner: app.company.id });
        for (const [id, owner, carrier, port, date, deleted] of [
            ['sail-a', app.company.id, 'MSC', 'SHA', '2027-01-02', null],
            ['sail-a2', app.company.id, 'MSC', 'SHA', '2027-01-02', null],
            ['sail-other-carrier', app.company.id, 'ONE', 'SHA', '2027-01-03', null],
            ['sail-other-port', app.company.id, 'MSC', 'SIN', '2027-01-04', null],
            ['sail-before', app.company.id, 'MSC', 'SHA', '2026-12-31', null],
            ['sail-b', 'owner-b', 'MSC', 'SHA', '2027-01-02', null],
            ['sail-inactive', 'inactive', 'MSC', 'SHA', '2027-01-02', null],
            ['sail-deleted', app.company.id, 'MSC', 'SHA', '2027-01-02', '2026-11-01']
        ]) app.db.prepare(`INSERT INTO sailings (id,owner_company_id,carrier,departure_port,departure,arrival,vessel,deleted_at)
            VALUES (?,?,?,?,?,'2027-01-20','Test Vessel',?)`).run(id, owner, carrier, port, date, deleted);
        const registered = await app.request('/api/admin/oauth-clients', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: 'Synthetic R29', clientType: 'confidential', redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read'] }) });
        assert.equal(registered.status, 201);
        const client = await registered.json();
        const issue = session => authorizeAndToken({ baseUrl: app.baseUrl, cookie: session.cookie, csrf: session.csrf,
            clientId: client.client.id, clientSecret: client.clientSecret });
        token = await issue(buyer); ownerToken = await issue(app);
    });
    after(async () => { if (app) await app.close(); });

    it('returns the OAuth userinfo body for buyer key, customer token and owner token', async () => {
        const expected = await partnerGet(app.baseUrl, token.access_token, '/oauth/userinfo');
        assert.equal(expected.status, 200);
        const key = await request(`${ROOT}/profile`); assert.equal(key.status, 200);
        assert.deepEqual(key.body, expected.body);
        for (const t of [token, ownerToken]) {
            const profile = await partnerGet(app.baseUrl, t.access_token, `${ROOT}/profile`);
            assert.equal(profile.status, 200);
            assert.equal(profile.text, (await partnerGet(app.baseUrl, t.access_token, '/oauth/userinfo')).text);
        }
        const access = require('../lib/buyer-api-key').verifyBuyerApiKey(KEY).access;
        assert.deepEqual(access.scopes, ['profile:read', 'rates:read', 'sailings:read']);
        assert.equal(access.clientId, 'buyer-api-key');
        // This server-side test credential is independent of OAuth token issuance.
        process.env.PARTNER_OAUTH_ENABLED = 'false';
        try { assert.equal((await request(`${ROOT}/profile`)).status, 200); }
        finally { process.env.PARTNER_OAUTH_ENABLED = 'true'; }
    });
    it('applies the customer margin with no base price or margin fields', async () => {
        const rates = await request(`${ROOT}/available-rates`); assert.equal(rates.status, 200);
        assert.equal(rates.body.data[0].rate20D, 1107);
        assert.doesNotMatch(rates.text, /ownerCompanyId|marginPercent|marginNumber|basePrice/);
        assert.deepEqual(rates.body, (await partnerGet(app.baseUrl, token.access_token, `${ROOT}/available-rates`)).body);
    });
    it('matches session sailing rows for both customer credentials with filtering and stable paging', async () => {
        const filters = '?carrier=msc&originPort=sha&after=2027-01-01';
        const session = await call(app.baseUrl, buyer, 'GET', '/api/sailings' + filters);
        assert.equal(session.status, 200);
        assert.deepEqual(session.json.sailings.map(s => s.id).sort(), ['sail-a', 'sail-a2']);
        for (const headers of [{}, { authorization: `Bearer ${token.access_token}` }]) {
            const key = Object.keys(headers).length ? null : KEY;
            const result = await request(ROOT + '/sailings' + filters, { key, headers });
            assert.equal(result.status, 200); assert.deepEqual(result.body.data, session.json.sailings);
            const pages = [];
            for (const page of [1, 2, 3]) {
                const r = await request(ROOT + '/sailings' + filters + `&pageSize=1&page=${page}`, { key, headers });
                assert.equal(r.body.meta.total, 2); pages.push(...r.body.data);
            }
            assert.deepEqual(pages, result.body.data);
        }
        const all = await request(ROOT + '/sailings');
        assert.equal(all.body.meta.total, 5);
        assert.equal(all.body.data.some(s => /sail-b$|inactive|deleted/.test(s.id)), false);
        app.db.prepare("UPDATE company_margins SET status='revoked' WHERE id='active-link'").run();
        try { assert.deepEqual((await request(ROOT + '/sailings')).body.data, []); }
        finally { app.db.prepare("UPDATE company_margins SET status='active' WHERE id='active-link'").run(); }
    });
    it('keeps owner sailing DTO bytes and customer MCP restrictions', async () => {
        const result = await partnerGet(app.baseUrl, ownerToken.access_token, ROOT + '/sailings?carrier=MSC&originPort=SHA&after=2027-01-01&pageSize=1');
        assert.equal(result.status, 200);
        assert.equal(result.text, JSON.stringify({ data: [{ id:'sail-a',source:'base_contract',allocationEvidence:false,capacityQuantity:null,
            departure:'2027-01-02',arrival:'2027-01-20',transitTime:null,vessel:'Test Vessel',voyage:null,service:null,carrier:'MSC',departurePort:'SHA',
            ownerCompanyId:app.company.id,currency:null,updatedAt:null }],meta:{total:2,page:1,pageSize:1,returned:1,
                notice:'Rate and sailing records are not evidence of allocatable or transferable capacity.'} }));
        const mcp = await mcpCall(app.baseUrl, token.access_token, 'tools/call', { name: 'rateninja_list_my_sailings', arguments: {} });
        assert.equal(mcp.body.result.structuredContent.error, 'owner_only');
    });
    it('denies booking reads, creates and decisions for missing scope', async () => {
        for (const [path, method] of [['/booking-requests','GET'], ['/booking-requests/missing','GET'],
            ['/booking-requests','POST'], ['/booking-requests/missing/decision','POST']]) {
            await denied(ROOT + path, 403, 'insufficient_scope', { method, body: method === 'POST' ? {} : undefined });
        }
        for (const path of ['/rates', '/rates/missing', '/sailings/missing', '/predictive-pricing', '/sailing-date-ranges']) {
            await denied(ROOT + path, 403, 'owner_only');
        }
    });
    it('refuses unknown, revoked and reused keys', async () => {
        const revoked = await createKey(app.baseUrl, buyer, 'To revoke');
        assert.equal((await call(app.baseUrl, buyer, 'DELETE', '/api/account/api-keys/' + revoked.apiKey.id)).status, 200);
        for (const path of ['/profile', '/sailings', '/available-rates', '/booking-requests']) {
            for (const key of ['rnb_' + 'z'.repeat(43), revoked.key, config.publicApiKey, config.adminApiKey]) {
                await denied(ROOT + path, 401, 'invalid_token', { key });
            }
            app.db.prepare("UPDATE users SET disabled=1 WHERE id='buyer-user'").run();
            try { await denied(ROOT + path, 403, 'buyer_access_denied'); }
            finally { app.db.prepare("UPDATE users SET disabled=0 WHERE id='buyer-user'").run(); }
        }
        const { verifyBuyerApiKey } = require('../lib/buyer-api-key');
        assert.equal(verifyBuyerApiKey(KEY + 'extra').status, 401);
        await denied(ROOT + '/profile', 401, 'invalid_token', { key:'wrong' });
        await denied(ROOT + '/profile', 401, 'invalid_token', { key:'c'.repeat(32) });
        await denied(ROOT + '/profile', 401, 'invalid_token', { key:'' });
        await denied(ROOT + '/profile', 401, 'invalid_token', { key:null });
        for (const bearer of ['bad', token.access_token]) {
            await denied(ROOT + '/profile', 400, 'invalid_request', { headers:{authorization:`Bearer ${bearer}`} });
        }
    });
    it('reads the bound user and company live, including missing and disabled accounts', async () => {
        app.db.prepare("UPDATE buyer_api_keys SET user_id='missing' WHERE user_id='buyer-user'").run();
        await denied(ROOT + '/profile', 403, 'buyer_access_denied');
        app.db.prepare("UPDATE buyer_api_keys SET user_id='buyer-user' WHERE user_id='missing'").run();
        app.db.prepare("UPDATE users SET disabled=1 WHERE id='buyer-user'").run();
        await denied(ROOT + '/profile', 403, 'buyer_access_denied');
        app.db.prepare("UPDATE users SET disabled=0 WHERE id='buyer-user'").run();
        for (const type of [OWNER, '', 'Unsupported']) {
            app.db.prepare("UPDATE companies SET company_type=?,company_type_id=NULL WHERE id='buyer'").run(type);
            await denied(ROOT + '/profile', 403, 'buyer_access_denied');
        }
        app.db.prepare("UPDATE companies SET company_type=? WHERE id='buyer'").run(CUSTOMER);
        assert.equal((await request(ROOT + '/profile')).status, 200);
    });
    it('does not authenticate OAuth, MCP, admin, demo or session routes', async () => {
        for (const path of ['/oauth/userinfo', '/api/admin/v1/reference/companies', '/api/v1/rates', '/api/sailings?carrier=MSC&originPort=SHA&after=2027-01-01']) {
            await denied(path, 401);
        }
        await denied('/mcp', 401, null, { method:'POST', body:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}} });
    });
    it('uses the shared per-user partner window across routes and key rotation', async () => {
        const realNow = Date.now;
        Date.now = () => realNow() + 120_000;
        try {
            for (let i=0; i<60; i++) assert.equal((await request(ROOT + (i%2 ? '/profile' : '/sailings'))).status, 200);
            await denied(ROOT + '/available-rates', 429, 'rate_limited');
            const rotated = await createKey(app.baseUrl, buyer, 'Rotated key');
            await denied(ROOT + '/profile', 429, 'rate_limited', { key:rotated.key });
        } finally { Date.now = realNow; }
    });
});
