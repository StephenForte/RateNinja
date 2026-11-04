'use strict';

process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateToolArguments } = require('../lib/mcp-schema');
const { customerPrice } = require('../lib/pricing');
const { startApp } = require('./helpers/app');
const {
    PASSWORD,
    REDIRECT_URI,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    pkce
} = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    insertRate,
    insertMargin,
    activate
} = require('./helpers/r1-19');
const { partnerSend, assertNoBase } = require('./helpers/r1-21');

const ROOT = path.join(__dirname, '..');
const BASE = 8123;
const ALL_SCOPES = ['profile:read', 'rates:read', 'sailings:read', 'bookings:read', 'bookings:write'];
const SEEDED_SCOPES = ['profile:read', 'rates:read', 'sailings:read'];
const NOT_FOUND = { error: 'not_found', error_description: 'Not found.' };
const EXISTING_TOOLS = [
    'rateninja_get_my_profile',
    'rateninja_list_my_rates',
    'rateninja_get_my_rate',
    'rateninja_list_my_sailings',
    'rateninja_get_my_sailing',
    'rateninja_get_my_predictive_pricing'
];

describe('mcp schema enum', () => {
    it('enforces enum and does not apply it to strings that have none', () => {
        const schema = {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['pending', 'approved', 'declined'] },
                note: { type: 'string' }
            },
            additionalProperties: false
        };
        assert.equal(validateToolArguments(schema, { status: 'approved', note: 'ok' }).ok, true);
        const rejected = validateToolArguments(schema, { status: 'closed' });
        assert.equal(rejected.ok, false);
        assert.match(rejected.error, /must be one of: pending, approved, declined/);
        assert.equal(validateToolArguments(schema, { note: 'closed' }).ok, true);
    });
});

describe('owner booking requests on the partner API and MCP', { concurrency: 1 }, () => {
    let app;
    let owner;
    let customer;
    let fullClient;
    let narrowClient;
    let fullToken;
    let readToken;
    let writeToken;
    let ratesToken;
    let ownerBToken;
    let expectedPrice;
    let otherId;
    let targets;

    before(async () => {
        app = await startApp({ companyName: 'Book Owner A', username: 'book-owner-a' });
        const db = app.db;
        insertCompany(db, { id: 'book-owner-b', name: 'Book Owner B', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'book-customer-a', name: 'Book Customer A', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'book-customer-b', name: 'Book Customer B', type: COMPANY_TYPE_CUSTOMER });
        insertUser(db, { id: 'book-customer-user', username: 'book-customer', companyId: 'book-customer-a', displayName: 'Book Customer' });
        insertUser(db, { id: 'book-owner-b-user', username: 'book-owner-b', companyId: 'book-owner-b', displayName: 'Book Owner B' });
        insertUser(db, { id: 'book-customer-b-user', username: 'book-customer-b', companyId: 'book-customer-b', displayName: 'Book Customer B' });
        for (const name of ['book-customer', 'book-owner-b', 'book-customer-b']) activate(name, PASSWORD);
        insertMargin(db, { id: 'book-margin-a', owner: app.company.id, customer: 'book-customer-a', percent: 0.1 });
        insertMargin(db, { id: 'book-margin-b', owner: 'book-owner-b', customer: 'book-customer-b', percent: 0.1 });
        insertRate(db, { id: 'book-rate-a', owner: app.company.id, rate20: BASE, expiration: utcDay(40), contractOwner: 'Book Owner A' });
        insertRate(db, { id: 'book-rate-b', owner: 'book-owner-b', rate20: BASE, expiration: utcDay(40), contractOwner: 'Book Owner B' });
        db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        owner = { cookie: app.cookie, csrf: app.csrf };
        customer = await login(app.baseUrl, 'book-customer', PASSWORD);
        expectedPrice = customerPrice(BASE, { marginPercent: 0.1, marginNumber: 0 });
        assert.notEqual(expectedPrice, BASE);

        async function register(name, allowedScopes) {
            const created = await app.request('/api/admin/oauth-clients', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    displayName: name,
                    clientType: 'confidential',
                    redirectUris: [REDIRECT_URI],
                    allowedScopes
                })
            });
            const body = await created.json();
            assert.equal(created.status, 201, JSON.stringify(body));
            return { id: body.client.id, secret: body.clientSecret };
        }

        async function issue(session, client, scope) {
            return (await authorizeAndToken({
                baseUrl: app.baseUrl,
                cookie: session.cookie,
                csrf: session.csrf,
                clientId: client.id,
                clientSecret: client.secret,
                scope
            })).access_token;
        }

        fullClient = await register('Booking Full', ALL_SCOPES);
        const readClient = await register('Booking Read', ALL_SCOPES);
        const writeClient = await register('Booking Write', ALL_SCOPES);
        const ratesClient = await register('Booking Rates', ALL_SCOPES);
        narrowClient = await register('Booking Narrow', SEEDED_SCOPES);
        const ownerScope = 'bookings:read bookings:write';
        // A later approval for the same user and client revokes the previous grant.
        fullToken = await issue(owner, fullClient, ownerScope);
        readToken = await issue(owner, readClient, 'bookings:read');
        writeToken = await issue(owner, writeClient, 'bookings:write');
        ratesToken = await issue(owner, ratesClient, 'rates:read');
        const ownerB = await login(app.baseUrl, 'book-owner-b', PASSWORD);
        ownerBToken = await issue(ownerB, fullClient, ownerScope);

        async function book(session, rateId) {
            const created = await call(app.baseUrl, session, 'POST', '/api/booking-requests', {
                rateId,
                containerSize: '20D',
                slots: 2
            });
            assert.equal(created.status, 201, created.text);
            return created.json.request.id;
        }

        const customerB = await login(app.baseUrl, 'book-customer-b', PASSWORD);
        const ids = [];
        for (let index = 0; index < 8; index += 1) {
            const id = await book(customer, 'book-rate-a');
            app.db.prepare('UPDATE booking_requests SET created_at = ? WHERE id = ?').run(
                `2026-11-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
                id
            );
            ids.push(id);
        }
        otherId = await book(customerB, 'book-rate-b');
        targets = {
            parity: ids[7],
            app: ids[0],
            api: ids[1],
            mcp: ids[2],
            race: ids[3],
            bad: ids[4],
            write: ids[5],
            spare: ids[6]
        };
    });

    after(async () => {
        process.env.PARTNER_OAUTH_ENABLED = 'true';
        if (app) await app.close();
    });

    function rowOf(id) {
        return app.db.prepare(`
            SELECT status, decided_at, owner_read_at, customer_read_at
            FROM booking_requests WHERE id = ?
        `).get(id);
    }

    it('keeps the seed, the consent words, and the admin defaults', async () => {
        const { ensureCapacityExchangeClient, CAPACITY_EXCHANGE_CLIENT_ID } = (() => {
            const oauth = require('../lib/oauth');
            const constants = require('../lib/constants');
            return {
                ensureCapacityExchangeClient: oauth.ensureCapacityExchangeClient,
                CAPACITY_EXCHANGE_CLIENT_ID: constants.CAPACITY_EXCHANGE_CLIENT_ID
            };
        })();
        ensureCapacityExchangeClient();
        const seeded = app.db.prepare('SELECT allowed_scopes FROM oauth_clients WHERE id = ?').get(CAPACITY_EXCHANGE_CLIENT_ID);
        assert.deepEqual(JSON.parse(seeded.allowed_scopes), SEEDED_SCOPES);
        ensureCapacityExchangeClient();
        assert.deepEqual(
            JSON.parse(app.db.prepare('SELECT allowed_scopes FROM oauth_clients WHERE id = ?').get(CAPACITY_EXCHANGE_CLIENT_ID).allowed_scopes),
            SEEDED_SCOPES
        );

        const copy = path.join(app.directory, 'restart.db');
        app.db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
        const { DatabaseSync } = require('node:sqlite');
        const copyDb = new DatabaseSync(copy);
        copyDb.prepare('UPDATE oauth_clients SET allowed_scopes = ? WHERE id = ?').run(JSON.stringify(['profile:read']), CAPACITY_EXCHANGE_CLIENT_ID);
        copyDb.prepare(`
            INSERT INTO oauth_clients (
                id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
            ) VALUES ('existing-client', 'Existing', NULL, 'public', '[]', ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run(JSON.stringify(['rates:read']));
        copyDb.close();
        const child = spawnSync(process.execPath, ['-e', "require('./lib/foundation').ensureFoundation()"], {
            cwd: ROOT,
            env: { ...process.env, SQLITE_DB_PATH: copy },
            encoding: 'utf8'
        });
        assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
        const restarted = new DatabaseSync(copy);
        const capacity = JSON.parse(restarted.prepare('SELECT allowed_scopes FROM oauth_clients WHERE id = ?').get(CAPACITY_EXCHANGE_CLIENT_ID).allowed_scopes);
        const existing = JSON.parse(restarted.prepare('SELECT allowed_scopes FROM oauth_clients WHERE id = ?').get('existing-client').allowed_scopes);
        restarted.close();
        assert.deepEqual(capacity, ['profile:read']);
        assert.deepEqual(existing, ['rates:read']);
        assert.equal(capacity.includes('bookings:read') || capacity.includes('bookings:write'), false);
        assert.equal(existing.includes('bookings:read') || existing.includes('bookings:write'), false);

        const oauthSource = fs.readFileSync(path.join(ROOT, 'lib/oauth.js'), 'utf8');
        const seedFn = oauthSource.slice(
            oauthSource.indexOf('function ensureCapacityExchangeClient'),
            oauthSource.indexOf('function authorizationServerMetadata')
        );
        assert.equal(seedFn.includes('JSON.stringify(SCOPES)'), false);
        assert.match(seedFn, /profile:read', 'rates:read', 'sailings:read'/);

        const ui = fs.readFileSync(path.join(ROOT, 'public/js/admin/oauth-clients.js'), 'utf8');
        assert.match(ui, /\['bookings:read', true\]/);
        assert.match(ui, /\['bookings:write', false\]/);
        assert.equal(ui.includes('input.checked = true'), false);

        for (const relativePath of [
            'docs/partner-integration.md',
            'docs/booking-requests.md',
            'API-README.md',
            'public/api-docs.html',
            'public/js/admin/integrations.js'
        ]) {
            const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
            assert.match(text, /planned, not available/, relativePath);
            assert.equal(text.includes('The tools are read-only.'), false, relativePath);
        }

        const proof = pkce();
        const consent = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: fullClient.id,
            redirect_uri: REDIRECT_URI,
            scope: 'bookings:read bookings:write',
            state: proof.state,
            code_challenge: proof.challenge,
            code_challenge_method: 'S256'
        })}`, { headers: { cookie: owner.cookie }, redirect: 'manual' });
        const html = await consent.text();
        assert.equal(consent.status, 200, html);
        assert.match(html, /This app can approve or decline booking requests for your company\./);
        assert.match(html, /wants to read data/);

        const narrowProof = pkce();
        const invalid = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: narrowClient.id,
            redirect_uri: REDIRECT_URI,
            scope: 'bookings:write',
            state: narrowProof.state,
            code_challenge: narrowProof.challenge,
            code_challenge_method: 'S256'
        })}`, { headers: { cookie: owner.cookie }, redirect: 'manual' });
        assert.equal(invalid.status, 302);
        assert.match(invalid.headers.get('location'), /error=invalid_scope/);

        const customerProof = pkce();
        const customerDenied = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: fullClient.id,
            redirect_uri: REDIRECT_URI,
            scope: 'bookings:read bookings:write',
            state: customerProof.state,
            code_challenge: customerProof.challenge,
            code_challenge_method: 'S256'
        })}`, { headers: { cookie: customer.cookie }, redirect: 'manual' });
        assert.equal(customerDenied.status, 302);
        const customerLocation = customerDenied.headers.get('location');
        assert.match(customerLocation, /only_contract_owner/);
        assert.equal(new URL(customerLocation).searchParams.get('code'), null);
    });

    it('shows an owner only its own requests, with the same customer price on both surfaces', async () => {
        const { ALLOCATION_NOTICE } = require('../lib/visibility');
        const unreadBefore = await call(app.baseUrl, owner, 'GET', '/api/booking-requests/unread');
        const customerBefore = await call(app.baseUrl, customer, 'GET', '/api/booking-requests/unread');
        assert.equal(unreadBefore.status, 200);
        assert.equal(customerBefore.json.unread, 0);

        const list = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?pageSize=50');
        const listMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_list_my_booking_requests',
            arguments: { pageSize: 50 }
        });
        assert.equal(list.status, 200, list.text);
        assert.equal(listMcp.body.result.isError, false, listMcp.text);
        assert.deepEqual(listMcp.body.result.structuredContent, list.body);
        assert.equal(list.body.data.some(item => item.id === otherId), false);
        assert.equal(list.body.meta.notice, ALLOCATION_NOTICE);
        assert.equal(list.body.meta.total, 8);
        assert.equal(list.body.meta.returned, 8);

        const own = await partnerGet(app.baseUrl, fullToken, `/api/partner/v1/me/booking-requests/${targets.parity}`);
        const ownMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_get_my_booking_request',
            arguments: { requestId: targets.parity }
        });
        assert.equal(own.status, 200, own.text);
        assert.equal(ownMcp.body.result.isError, false, ownMcp.text);
        assert.deepEqual(ownMcp.body.result.structuredContent, own.body);
        assert.equal(own.body.data.customerPrice, expectedPrice);
        assert.equal(own.body.data.requestedBy.id, 'book-customer-user');
        assert.equal(own.body.data.requestedBy.name, 'Book Customer');
        assert.equal(own.body.data.side, 'owner');
        assert.equal(own.body.meta.notice, ALLOCATION_NOTICE);
        assertNoBase(assert, own.body, BASE);
        assertNoBase(assert, ownMcp.body.result.structuredContent, BASE);
        const listed = list.body.data.find(item => item.id === targets.parity);
        assert.deepEqual(listed, own.body.data);

        const missing = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests/missing-booking-id');
        const other = await partnerGet(app.baseUrl, fullToken, `/api/partner/v1/me/booking-requests/${otherId}`);
        assert.equal(missing.status, 404);
        assert.equal(other.status, 404);
        assert.deepEqual(missing.body, NOT_FOUND);
        assert.deepEqual(other.body, missing.body);
        const missingMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_get_my_booking_request',
            arguments: { requestId: 'missing-booking-id' }
        });
        const otherMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_get_my_booking_request',
            arguments: { requestId: otherId }
        });
        assert.equal(missingMcp.status, 200);
        assert.equal(missingMcp.body.result.isError, true);
        assert.deepEqual(missingMcp.body.result.structuredContent, NOT_FOUND);
        assert.deepEqual(otherMcp.body.result.structuredContent, missingMcp.body.result.structuredContent);

        const missingDecide = await partnerSend(app.baseUrl, fullToken, 'POST', '/api/partner/v1/me/booking-requests/missing-booking-id/decision', {
            body: { decision: 'approved' }
        });
        const otherDecide = await partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${otherId}/decision`, {
            body: { decision: 'declined' }
        });
        assert.deepEqual(missingDecide.body, NOT_FOUND);
        assert.deepEqual(otherDecide.body, missingDecide.body);
        const missingDecideMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: 'missing-booking-id', decision: 'approved' }
        });
        const otherDecideMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: otherId, decision: 'declined' }
        });
        assert.deepEqual(missingDecideMcp.body.result.structuredContent, NOT_FOUND);
        assert.deepEqual(otherDecideMcp.body.result.structuredContent, missingDecideMcp.body.result.structuredContent);
        assert.equal(rowOf(otherId).status, 'pending');

        const ownerBList = await partnerGet(app.baseUrl, ownerBToken, '/api/partner/v1/me/booking-requests');
        assert.equal(ownerBList.status, 200, ownerBList.text);
        assert.deepEqual(ownerBList.body.data.map(item => item.id), [otherId]);
        const ownerBMiss = await partnerGet(app.baseUrl, ownerBToken, `/api/partner/v1/me/booking-requests/${targets.parity}`);
        const ownerBMissing = await partnerGet(app.baseUrl, ownerBToken, '/api/partner/v1/me/booking-requests/missing-booking-id');
        assert.deepEqual(ownerBMiss.body, ownerBMissing.body);
        assert.deepEqual(ownerBMiss.body, NOT_FOUND);

        const unreadAfter = await call(app.baseUrl, owner, 'GET', '/api/booking-requests/unread');
        const customerAfter = await call(app.baseUrl, customer, 'GET', '/api/booking-requests/unread');
        assert.equal(unreadAfter.json.unread, unreadBefore.json.unread);
        assert.equal(customerAfter.json.unread, 0);
    });

    it('pages newest first, and the status filter matches the stored rows', async () => {
        const first = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?page=1&pageSize=2');
        const firstAgain = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?page=1&pageSize=2');
        const second = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?page=2&pageSize=2');
        const firstMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_list_my_booking_requests',
            arguments: { page: 1, pageSize: 2 }
        });
        assert.equal(first.status, 200, first.text);
        assert.deepEqual(firstAgain.body, first.body);
        assert.deepEqual(firstMcp.body.result.structuredContent, first.body);
        assert.equal(first.body.meta.total, 8);
        assert.equal(first.body.meta.page, 1);
        assert.equal(first.body.meta.pageSize, 2);
        assert.equal(first.body.meta.returned, 2);
        assert.equal(second.body.meta.page, 2);
        assert.equal(second.body.meta.returned, 2);
        assert.equal(second.body.meta.total, 8);
        const expected = app.db.prepare(`
            SELECT id FROM booking_requests
            WHERE owner_company_id = ?
            ORDER BY created_at DESC, id DESC
        `).all(app.company.id).map(row => row.id);
        const seen = first.body.data.map(item => item.id).concat(second.body.data.map(item => item.id));
        assert.deepEqual(seen, expected.slice(0, 4));
        assert.equal(new Set(seen).size, 4);

        const pending = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?status=pending&pageSize=50');
        assert.equal(pending.body.meta.total, 8);
        assert.ok(pending.body.data.every(item => item.status === 'pending'));
        const badFilter = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?status=closed');
        assert.equal(badFilter.status, 400);
        assert.equal(badFilter.body.error, 'invalid_request');
        const badFilterMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_list_my_booking_requests',
            arguments: { status: 'closed' }
        });
        assert.equal(badFilterMcp.status, 200);
        assert.equal(badFilterMcp.body.result.isError, true);
        assert.equal(badFilterMcp.body.result.structuredContent.error, 'invalid_request');
        assert.equal(rowOf(targets.bad).status, 'pending');
    });

    it('separates read, write, and rates scopes, and rejects a bad decision body', async () => {
        const before = rowOf(targets.bad);
        assert.equal(before.status, 'pending');

        const readList = await partnerGet(app.baseUrl, readToken, '/api/partner/v1/me/booking-requests?pageSize=1');
        const readOne = await partnerGet(app.baseUrl, readToken, `/api/partner/v1/me/booking-requests/${targets.bad}`);
        assert.equal(readList.status, 200, readList.text);
        assert.equal(readOne.status, 200, readOne.text);
        const readDecide = await partnerSend(app.baseUrl, readToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.bad}/decision`, {
            raw: '{'
        });
        assert.equal(readDecide.status, 403);
        assert.equal(readDecide.body.error, 'insufficient_scope');
        const readDecideMcp = await mcpCall(app.baseUrl, readToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: targets.bad, decision: 'maybe' }
        });
        assert.equal(readDecideMcp.status, 200);
        assert.equal(readDecideMcp.body.result.structuredContent.error, 'insufficient_scope');

        for (const [method, urlPath, options] of [
            ['GET', '/api/partner/v1/me/booking-requests', undefined],
            ['GET', `/api/partner/v1/me/booking-requests/${targets.bad}`, undefined]
        ]) {
            const denied = method === 'GET'
                ? await partnerGet(app.baseUrl, writeToken, urlPath)
                : null;
            assert.equal(denied.status, 403, denied.text);
            assert.equal(denied.body.error, 'insufficient_scope');
        }
        const writeListMcp = await mcpCall(app.baseUrl, writeToken, 'tools/call', {
            name: 'rateninja_list_my_booking_requests',
            arguments: { status: 'closed' }
        });
        const writeGetMcp = await mcpCall(app.baseUrl, writeToken, 'tools/call', {
            name: 'rateninja_get_my_booking_request',
            arguments: { requestId: targets.bad }
        });
        assert.equal(writeListMcp.body.result.structuredContent.error, 'insufficient_scope');
        assert.equal(writeGetMcp.body.result.structuredContent.error, 'insufficient_scope');

        for (const token of [ratesToken]) {
            const listDenied = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/booking-requests');
            const oneDenied = await partnerGet(app.baseUrl, token, `/api/partner/v1/me/booking-requests/${targets.bad}`);
            const decideDenied = await partnerSend(app.baseUrl, token, 'POST', `/api/partner/v1/me/booking-requests/${targets.bad}/decision`, {
                body: { decision: 'approved' }
            });
            assert.equal(listDenied.body.error, 'insufficient_scope');
            assert.equal(oneDenied.body.error, 'insufficient_scope');
            assert.equal(decideDenied.status, 403);
            assert.equal(decideDenied.body.error, 'insufficient_scope');
            const listMcp = await mcpCall(app.baseUrl, token, 'tools/call', {
                name: 'rateninja_list_my_booking_requests',
                arguments: {}
            });
            const oneMcp = await mcpCall(app.baseUrl, token, 'tools/call', {
                name: 'rateninja_get_my_booking_request',
                arguments: { requestId: targets.bad }
            });
            const decideMcp = await mcpCall(app.baseUrl, token, 'tools/call', {
                name: 'rateninja_decide_booking_request',
                arguments: { requestId: targets.bad, decision: 'approved' }
            });
            assert.equal(listMcp.body.result.structuredContent.error, 'insufficient_scope');
            assert.equal(oneMcp.body.result.structuredContent.error, 'insufficient_scope');
            assert.equal(decideMcp.body.result.structuredContent.error, 'insufficient_scope');
        }
        const rates = await partnerGet(app.baseUrl, ratesToken, '/api/partner/v1/me/rates');
        assert.equal(rates.status, 200, rates.text);
        assert.ok(Array.isArray(rates.body.data));

        const cases = [
            { raw: '{' },
            { raw: '[]' },
            { raw: 'null' },
            { raw: '"approved"' },
            { body: { decision: 'maybe' } },
            { body: {} }
        ];
        for (const options of cases) {
            const rejected = await partnerSend(
                app.baseUrl,
                fullToken,
                'POST',
                `/api/partner/v1/me/booking-requests/${targets.bad}/decision`,
                options
            );
            assert.equal(rejected.status, 400, rejected.text);
            assert.equal(rejected.body.error, 'invalid_request');
            assert.deepEqual(rowOf(targets.bad), before);
        }
        const maybeMcp = await mcpCall(app.baseUrl, writeToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: targets.write, decision: 'maybe' }
        });
        assert.equal(maybeMcp.body.result.structuredContent.error, 'invalid_request');
        assert.equal(rowOf(targets.write).status, 'pending');
        assert.deepEqual(rowOf(targets.bad), before);
    });

    it('decides once on each surface, races to one winner, and leaves the app audit unchanged', async () => {
        const appDecide = await call(app.baseUrl, owner, 'POST', `/api/booking-requests/${targets.app}/decision`, { decision: 'approved' });
        assert.equal(appDecide.status, 200, appDecide.text);
        assert.equal(appDecide.json.request.status, 'approved');
        assert.equal(appDecide.json.data, undefined);
        const appAudit = app.db.prepare(`
            SELECT client_id, detail FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${targets.app}%`);
        assert.equal(appAudit.client_id, null);
        assert.deepEqual(JSON.parse(appAudit.detail), {
            requestId: targets.app,
            status: 'approved',
            ownerCompanyId: app.company.id
        });

        const marked = await call(app.baseUrl, customer, 'POST', '/api/booking-requests/read', {});
        assert.equal(marked.status, 200, marked.text);
        assert.equal((await call(app.baseUrl, customer, 'GET', '/api/booking-requests/unread')).json.unread, 0);

        const apiDecide = await partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.api}/decision`, {
            body: { decision: 'approved' }
        });
        assert.equal(apiDecide.status, 200, apiDecide.text);
        assert.equal(apiDecide.body.data.status, 'approved');
        assert.equal(apiDecide.body.data.customerPrice, expectedPrice);
        assert.equal(apiDecide.body.data.requestedBy.id, 'book-customer-user');
        assert.equal(apiDecide.body.data.decidedBy.name, 'book-owner-a');
        assertNoBase(assert, apiDecide.body, BASE);
        assert.equal(rowOf(targets.api).status, 'approved');
        assert.equal((await call(app.baseUrl, customer, 'GET', '/api/booking-requests/unread')).json.unread, 1);
        const customerView = await call(app.baseUrl, customer, 'GET', `/api/booking-requests/${targets.api}`);
        assert.equal(customerView.json.request.status, 'approved');
        assert.equal(customerView.json.request.decidedBy, undefined);
        const apiAudit = JSON.parse(app.db.prepare(`
            SELECT client_id, detail FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${targets.api}%`).detail);
        const apiClient = app.db.prepare(`
            SELECT client_id FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${targets.api}%`).client_id;
        assert.equal(apiClient, fullClient.id);
        assert.equal(apiAudit.channel, 'api');
        assert.equal(apiAudit.status, 'approved');
        assert.equal(apiAudit.ownerCompanyId, app.company.id);

        const apiAgain = await partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.api}/decision`, {
            body: { decision: 'declined' }
        });
        const apiAgainMcp = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: targets.api, decision: 'declined' }
        });
        assert.equal(apiAgain.status, 409);
        assert.equal(apiAgain.body.error, 'already_decided');
        assert.equal(apiAgainMcp.body.result.isError, true);
        assert.equal(apiAgainMcp.body.result.structuredContent.error, 'already_decided');
        assert.equal(rowOf(targets.api).status, 'approved');
        assert.equal(app.db.prepare(`
            SELECT COUNT(*) AS count FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${targets.api}%`).count, 1);

        await call(app.baseUrl, customer, 'POST', '/api/booking-requests/read', {});
        const mcpDecide = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: targets.mcp, decision: 'declined' }
        });
        assert.equal(mcpDecide.body.result.isError, false, mcpDecide.text);
        assert.equal(mcpDecide.body.result.structuredContent.data.status, 'declined');
        assert.equal(mcpDecide.body.result.structuredContent.data.customerPrice, expectedPrice);
        assertNoBase(assert, mcpDecide.body.result.structuredContent, BASE);
        assert.equal(rowOf(targets.mcp).status, 'declined');
        assert.equal((await call(app.baseUrl, customer, 'GET', '/api/booking-requests/unread')).json.unread, 1);
        const mcpAuditRow = app.db.prepare(`
            SELECT client_id, detail FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${targets.mcp}%`);
        assert.equal(mcpAuditRow.client_id, fullClient.id);
        assert.equal(JSON.parse(mcpAuditRow.detail).channel, 'mcp');
        const mcpAgain = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
            name: 'rateninja_decide_booking_request',
            arguments: { requestId: targets.mcp, decision: 'approved' }
        });
        const mcpAgainApi = await partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.mcp}/decision`, {
            body: { decision: 'approved' }
        });
        assert.equal(mcpAgain.body.result.structuredContent.error, 'already_decided');
        assert.equal(mcpAgainApi.status, 409);
        assert.equal(mcpAgainApi.body.error, 'already_decided');
        assert.equal(rowOf(targets.mcp).status, 'declined');

        const [raceApi, raceMcp] = await Promise.all([
            partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.race}/decision`, {
                body: { decision: 'approved' }
            }),
            mcpCall(app.baseUrl, fullToken, 'tools/call', {
                name: 'rateninja_decide_booking_request',
                arguments: { requestId: targets.race, decision: 'declined' }
            })
        ]);
        const apiWon = raceApi.status === 200;
        const mcpWon = raceMcp.body.result.isError === false;
        assert.equal(Number(apiWon) + Number(mcpWon), 1, `${raceApi.text}\n${raceMcp.text}`);
        const raced = rowOf(targets.race).status;
        if (apiWon) {
            assert.equal(raced, 'approved');
            assert.equal(raceMcp.body.result.structuredContent.error, 'already_decided');
        } else {
            assert.equal(raced, 'declined');
            assert.equal(raceApi.status, 409);
            assert.equal(raceApi.body.error, 'already_decided');
        }
        assert.equal(rowOf(targets.race).status, raced);

        const written = await partnerSend(app.baseUrl, writeToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.write}/decision`, {
            body: { decision: 'approved' }
        });
        assert.equal(written.status, 200, written.text);
        assert.equal(rowOf(targets.write).status, 'approved');
        assert.equal(rowOf(targets.bad).status, 'pending');
        assert.equal(rowOf(targets.bad).decided_at, null);

        const ownerUnread = await call(app.baseUrl, owner, 'GET', '/api/booking-requests/unread');
        const readAgain = await partnerGet(app.baseUrl, readToken, `/api/partner/v1/me/booking-requests/${targets.spare}`);
        assert.equal(readAgain.status, 200, readAgain.text);
        const ownerUnreadAfter = await call(app.baseUrl, owner, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerUnreadAfter.json.unread, ownerUnread.json.unread);

        const approved = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?status=approved&pageSize=50');
        const pending = await partnerGet(app.baseUrl, fullToken, '/api/partner/v1/me/booking-requests?status=pending&page=1&pageSize=1');
        assert.equal(approved.status, 200, approved.text);
        assert.ok(approved.body.data.every(item => item.status === 'approved'));
        assert.equal(approved.body.meta.total, approved.body.data.length);
        assert.ok(approved.body.meta.total >= 1);
        assert.equal(pending.body.meta.pageSize, 1);
        assert.equal(pending.body.meta.returned, 1);
        assert.ok(pending.body.meta.total > 1);
        assert.equal(pending.body.data[0].status, 'pending');
        const approvedCount = app.db.prepare(`
            SELECT COUNT(*) AS count FROM booking_requests
            WHERE owner_company_id = ? AND status = 'approved'
        `).get(app.company.id).count;
        assert.equal(approved.body.meta.total, approvedCount);
    });

    it('publishes booking annotations and leaves the existing tools unchanged', async () => {
        const listed = await mcpCall(app.baseUrl, fullToken, 'tools/list', {});
        assert.equal(listed.status, 200, listed.text);
        const tools = listed.body.result.tools;
        assert.deepEqual(tools.slice(0, 6).map(tool => tool.name), EXISTING_TOOLS);
        for (const tool of tools.slice(0, 6)) {
            assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema']);
        }
        assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
        assert.match(tools[5].description, /read-only/i);
        assert.deepEqual(tools.slice(6).map(tool => tool.name), [
            'rateninja_list_my_booking_requests',
            'rateninja_get_my_booking_request',
            'rateninja_decide_booking_request'
        ]);
        assert.deepEqual(tools[6].annotations, { readOnlyHint: true });
        assert.deepEqual(tools[7].annotations, { readOnlyHint: true });
        assert.deepEqual(tools[8].annotations, {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false
        });
        assert.match(tools[8].description, /changes data/);
        assert.match(tools[8].description, /final/);
        assert.equal(validateToolArguments(tools[8].inputSchema, { requestId: 'x', decision: 'maybe' }).ok, false);
        assert.equal(validateToolArguments(tools[8].inputSchema, { requestId: 'x', decision: 'approved' }).ok, true);
        assert.equal(validateToolArguments(tools[6].inputSchema, { status: 'nope' }).ok, false);
        assert.equal(validateToolArguments(tools[6].inputSchema, { status: 'pending' }).ok, true);

        const reads = app.db.prepare(`
            SELECT client_id, detail FROM audit_events WHERE event_type = 'partner_booking_requests_read'
        `).all();
        assert.ok(reads.some(row => row.client_id === fullClient.id && !JSON.parse(row.detail).channel));
        assert.ok(reads.some(row => row.client_id === fullClient.id && JSON.parse(row.detail).channel === 'mcp'));
    });

    it('closes every booking route and tool when partner OAuth is off', async () => {
        process.env.PARTNER_OAUTH_ENABLED = 'false';
        try {
            const paths = [
                ['GET', '/api/partner/v1/me/booking-requests'],
                ['GET', `/api/partner/v1/me/booking-requests/${targets.bad}`]
            ];
            for (const [, urlPath] of paths) {
                const blocked = await partnerGet(app.baseUrl, fullToken, urlPath);
                assert.equal(blocked.status, 403, blocked.text);
                assert.equal(blocked.body.error, 'partner_oauth_disabled');
            }
            const blockedDecide = await partnerSend(app.baseUrl, fullToken, 'POST', `/api/partner/v1/me/booking-requests/${targets.bad}/decision`, {
                body: { decision: 'approved' }
            });
            assert.equal(blockedDecide.status, 403);
            assert.equal(blockedDecide.body.error, 'partner_oauth_disabled');
            for (const name of [
                'rateninja_list_my_booking_requests',
                'rateninja_get_my_booking_request',
                'rateninja_decide_booking_request'
            ]) {
                const blocked = await mcpCall(app.baseUrl, fullToken, 'tools/call', {
                    name,
                    arguments: name === 'rateninja_list_my_booking_requests' ? {} : { requestId: targets.bad, decision: 'approved' }
                });
                assert.equal(blocked.status, 403, blocked.text);
                assert.equal(blocked.body.error.message, 'partner_oauth_disabled');
            }
            const proof = pkce();
            const customerDenied = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams({
                response_type: 'code',
                client_id: fullClient.id,
                redirect_uri: REDIRECT_URI,
                scope: 'bookings:write',
                state: proof.state,
                code_challenge: proof.challenge,
                code_challenge_method: 'S256'
            })}`, { headers: { cookie: customer.cookie }, redirect: 'manual' });
            assert.equal(customerDenied.status, 403);
            assert.equal(new URL(customerDenied.url).searchParams.get('code'), null);
            assert.equal((await customerDenied.text()).includes('access_token'), false);
            assert.equal(rowOf(targets.bad).status, 'pending');
        } finally {
            process.env.PARTNER_OAUTH_ENABLED = 'true';
        }
    });
});
