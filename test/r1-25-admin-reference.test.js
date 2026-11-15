'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.RATE_NINJA_ADMIN_API_KEY = 'r125-admin-test-key-32chars-xxxxxx';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp } = require('./helpers/app');
const {
    freezeToday,
    insertRate,
    insertSailing,
    insertPort,
    insertCompany,
    insertUser,
    insertMargin,
    activate,
    login,
    SHARED_REFERENCE_TOOLS,
    OWNER_ONLY_REFERENCE_TOOLS,
    CUSTOMER_TOOLS,
    COMPANY_TYPE_CONTRACT_OWNER: OWNER,
    COMPANY_TYPE_CUSTOMER: CUSTOMER,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    REDIRECT_URI
} = require('./helpers/r1-24');
const {
    ADMIN_KEY,
    DEMO_KEY,
    ADMIN_ROUTES,
    PARITY_ROUTES,
    PARTNER_ROOT,
    enableAdminKey,
    adminGet,
    assertNoPrices,
    resetAdminApiWindowForTests
} = require('./helpers/r1-25');

freezeToday();

const ALL = 'profile:read rates:read sailings:read bookings:read bookings:write';

describe('R1-25 admin reference API', { concurrency: 1 }, () => {
    let app;
    let client;
    let ownerToken;
    let customerToken;
    let buyerSession;
    let ownerBId;

    async function register(name) {
        const response = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: name,
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ALL.split(' ')
            })
        });
        const body = await response.json();
        assert.equal(response.status, 201, JSON.stringify(body));
        return { id: body.client.id, secret: body.clientSecret };
    }

    async function issue(session, scope = ALL, chosen = client) {
        return authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: session.cookie,
            csrf: session.csrf,
            clientId: chosen.id,
            clientSecret: chosen.secret,
            scope
        });
    }

    before(async () => {
        app = await startApp({ companyName: 'R125 Owner A' });
        enableAdminKey();
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);

        ownerBId = 'owner-b';
        insertCompany(app.db, { id: ownerBId, name: 'R125 Owner B', type: OWNER });
        insertCompany(app.db, { id: 'buyer', name: 'R125 Buyer', type: CUSTOMER });
        insertCompany(app.db, { id: 'unsupported', name: 'R125 Unsupported', type: OWNER });
        app.db.prepare("UPDATE companies SET company_type = 'Other', company_type_id = NULL WHERE id = 'unsupported'").run();

        insertUser(app.db, { id: 'buyer-user', username: 'r125-buyer', companyId: 'buyer', role: 'company_admin' });
        activate('r125-buyer');
        buyerSession = await login(app.baseUrl, 'r125-buyer');

        insertMargin(app.db, { id: 'm-active', owner: app.company.id, customer: 'buyer', percent: 0.1, number: 0 });

        insertPort(app.db, { id: 'port-pkg', code: 'MYPKG', name: 'Port Klang' });
        insertPort(app.db, { id: 'port-lalb', code: 'USLGB', name: 'LALB' });
        insertPort(app.db, { id: 'port-sha', code: 'CNSHA', name: 'Shanghai' });
        insertPort(app.db, { id: 'port-sea', code: 'USSEA', name: 'Seattle' });
        insertPort(app.db, { id: 'port-tyo', code: 'JPTYO', name: 'Tokyo' });

        insertRate(app.db, {
            id: 'r-a-1',
            owner: app.company.id,
            origin: 'Port Klang',
            destination: 'LALB',
            contractOwner: 'Kings',
            effective: '2026-10-26',
            expiration: '2026-12-31'
        });
        insertRate(app.db, {
            id: 'r-a-expired',
            owner: app.company.id,
            origin: 'Expired Origin',
            destination: 'Expired Dest',
            effective: '2026-01-01',
            expiration: '2026-11-13'
        });
        insertRate(app.db, {
            id: 'r-a-deleted',
            owner: app.company.id,
            origin: 'Deleted Origin',
            destination: 'Deleted Dest',
            effective: '2026-01-01',
            expiration: '2026-12-31',
            deletedAt: '2026-11-01T00:00:00.000Z'
        });
        insertRate(app.db, {
            id: 'r-b-1',
            owner: ownerBId,
            origin: 'Tokyo',
            destination: 'Seattle',
            contractOwner: 'Owner B Label',
            effective: '2026-10-01',
            expiration: '2026-12-31'
        });
        insertRate(app.db, {
            id: 'r-b-shared-port',
            owner: ownerBId,
            origin: 'Port Klang',
            destination: 'LALB',
            contractOwner: 'Owner B Label',
            effective: '2026-10-01',
            expiration: '2026-12-31'
        });

        insertSailing(app.db, {
            id: 's-a-1',
            owner: app.company.id,
            departurePort: 'Port Klang',
            arrivalPort: 'LALB',
            departure: '2026-12-01T08:00:00.000Z'
        });
        insertSailing(app.db, {
            id: 's-b-1',
            owner: ownerBId,
            departurePort: 'Tokyo',
            arrivalPort: 'Seattle',
            departure: '2026-12-15T08:00:00.000Z'
        });

        client = await register('R125 Client');
        ownerToken = await issue({ cookie: app.cookie, csrf: app.csrf });
        customerToken = await issue(buyerSession);
    });

    after(async () => {
        if (app) await app.close();
    });

    it('rejects wrong credentials with 401 on every admin reference route', async () => {
        resetAdminApiWindowForTests();
        for (const route of ADMIN_ROUTES) {
            for (const headers of [
                { key: null },
                { key: 'wrong-admin-key-value-xxxxxxxxxxxxxx' },
                { key: DEMO_KEY },
                { key: null, headers: { authorization: `Bearer ${ownerToken.access_token}` } },
                { key: null, headers: { cookie: app.cookie } }
            ]) {
                const result = await adminGet(app.baseUrl, route, headers);
                assert.equal(result.status, 401, `${route} ${JSON.stringify(headers)}`);
                assert.equal(result.body.error, 'invalid_admin_key');
                assert.equal(result.body.data, undefined);
            }
        }
    });

    it('does not accept the admin key on demo, partner, or mcp surfaces', async () => {
        const rates = await fetch(`${app.baseUrl}/api/v1/rates`, {
            headers: { 'x-admin-api-key': ADMIN_KEY }
        });
        assert.equal(rates.status, 401);

        const partner = await fetch(`${app.baseUrl}${PARTNER_ROOT}/origin-ports`, {
            headers: { 'x-admin-api-key': ADMIN_KEY }
        });
        const partnerBody = await partner.json();
        assert.equal(partner.status, 401);
        assert.equal(partnerBody.error, 'invalid_token');

        const mcp = await mcpCall(app.baseUrl, null, 'tools/list', {});
        // Mirror no-credential MCP refusal shape used without a bearer token.
        const mcpWithAdmin = await fetch(`${app.baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-admin-api-key': ADMIN_KEY
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
        const mcpAdminText = await mcpWithAdmin.text();
        assert.equal(mcpWithAdmin.status, mcp.status);
        assert.equal(mcpAdminText, mcp.text);
    });

    it('matches partner data and meta byte-for-byte when company is set', async () => {
        resetAdminApiWindowForTests();
        for (const route of PARITY_ROUTES.slice(0, 4)) {
            const partnerOwner = await partnerGet(app.baseUrl, ownerToken.access_token, `${PARTNER_ROOT}/${route}`);
            const adminOwner = await adminGet(app.baseUrl, route, { query: `company=${app.company.id}` });
            assert.equal(partnerOwner.status, 200, partnerOwner.text);
            assert.equal(adminOwner.status, 200, adminOwner.text);
            assert.deepEqual(adminOwner.body, partnerOwner.body);

            const partnerCustomer = await partnerGet(app.baseUrl, customerToken.access_token, `${PARTNER_ROOT}/${route}`);
            const adminCustomer = await adminGet(app.baseUrl, route, { query: 'company=buyer' });
            assert.equal(partnerCustomer.status, 200, partnerCustomer.text);
            assert.equal(adminCustomer.status, 200, adminCustomer.text);
            assert.deepEqual(adminCustomer.body, partnerCustomer.body);
            assertNoPrices(adminOwner.body);
            assertNoPrices(adminCustomer.body);
        }

        for (const route of ['sailing-date-ranges', 'predictive-date-ranges']) {
            const partnerOwner = await partnerGet(app.baseUrl, ownerToken.access_token, `${PARTNER_ROOT}/${route}`);
            const adminOwner = await adminGet(app.baseUrl, route, { query: `company=${app.company.id}` });
            assert.equal(adminOwner.status, 200, adminOwner.text);
            assert.deepEqual(adminOwner.body, partnerOwner.body);

            const adminCustomer = await adminGet(app.baseUrl, route, { query: 'company=buyer' });
            assert.equal(adminCustomer.status, 403);
            assert.equal(adminCustomer.body.error, 'owner_only');
        }

        const missing = await adminGet(app.baseUrl, 'origin-ports', { query: 'company=does-not-exist' });
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, 'not_found');

        const unsupported = await adminGet(app.baseUrl, 'origin-ports', { query: 'company=unsupported' });
        assert.equal(unsupported.status, 403);
        assert.equal(unsupported.body.error, 'unsupported_company_type');
    });

    it('combines all contract owners without merging rows across owners', async () => {
        resetAdminApiWindowForTests();
        const ranges = await adminGet(app.baseUrl, 'rate-date-ranges');
        assert.equal(ranges.status, 200, ranges.text);
        const ownerIds = new Set(ranges.body.data.map(row => row.ownerCompanyId));
        assert.equal(ownerIds.has(app.company.id), true);
        assert.equal(ownerIds.has(ownerBId), true);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Expired Origin'), false);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Deleted Origin'), false);
        assert.equal(ranges.body.data.every(row => row.ownerCompanyId && row.ownerCompanyName), true);
        assertNoPrices(ranges.body);

        const origins = await adminGet(app.baseUrl, 'origin-ports');
        const portKlang = origins.body.data.filter(row => row.value === 'Port Klang');
        assert.equal(portKlang.length, 1);
        assert.deepEqual(portKlang[0], { value: 'Port Klang', code: 'MYPKG', name: 'Port Klang' });
        assert.equal(origins.body.data.some(row => row.value === 'Tokyo'), true);

        const owners = await adminGet(app.baseUrl, 'contract-owners');
        assert.equal(owners.body.data.some(row => row.value === 'Kings' && row.ownerCompanyName === 'R125 Owner A'), true);
        assert.equal(owners.body.data.some(row => row.value === 'Owner B Label' && row.ownerCompanyName === 'R125 Owner B'), true);

        const sailings = await adminGet(app.baseUrl, 'sailing-date-ranges');
        assert.equal(sailings.body.data.some(row => row.ownerCompanyId === app.company.id), true);
        assert.equal(sailings.body.data.some(row => row.ownerCompanyId === ownerBId), true);

        const page1 = await adminGet(app.baseUrl, 'rate-date-ranges', { query: 'page=1&pageSize=1' });
        const page2 = await adminGet(app.baseUrl, 'rate-date-ranges', { query: 'page=2&pageSize=1' });
        assert.equal(page1.body.data.length, 1);
        assert.equal(page2.body.data.length, 1);
        assert.notDeepEqual(page1.body.data[0], page2.body.data[0]);
        assert.equal(page1.body.meta.total, page2.body.meta.total);
        const again = await adminGet(app.baseUrl, 'rate-date-ranges', { query: 'page=1&pageSize=1' });
        assert.deepEqual(again.body, page1.body);
    });

    it('lists companies and writes audit events without actor users', async () => {
        resetAdminApiWindowForTests();
        const before = Number(app.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
        const companies = await adminGet(app.baseUrl, 'companies', { query: 'pageSize=100' });
        assert.equal(companies.status, 200, companies.text);
        assert.ok(companies.body.data.some(row => row.id === app.company.id && row.name === 'R125 Owner A'));
        assert.ok(companies.body.data.some(row => row.id === 'buyer' && row.companyType === CUSTOMER));
        assert.equal(companies.body.data.every(row => Object.keys(row).sort().join(',') === 'companyType,id,name'), true);

        const origins = await adminGet(app.baseUrl, 'origin-ports', { query: `company=${app.company.id}` });
        assert.equal(origins.status, 200);

        const events = app.db.prepare(`
            SELECT event_type, actor_user_id, detail FROM audit_events
            WHERE event_type IN ('admin_reference_companies_read', 'admin_reference_origin_ports_read')
            ORDER BY created_at DESC
            LIMIT 4
        `).all();
        const companyEvent = events.find(row => row.event_type === 'admin_reference_companies_read');
        const originEvent = events.find(row => row.event_type === 'admin_reference_origin_ports_read');
        assert.ok(companyEvent);
        assert.equal(companyEvent.actor_user_id, null);
        assert.deepEqual(JSON.parse(companyEvent.detail), {
            count: companies.body.data.length,
            company: null
        });
        assert.ok(originEvent);
        assert.deepEqual(JSON.parse(originEvent.detail), {
            count: origins.body.data.length,
            company: app.company.id
        });
        const after = Number(app.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
        assert.ok(after >= before + 2);
    });

    it('rate-limits the admin key separately at 60 requests per window', async () => {
        resetAdminApiWindowForTests();
        for (let index = 0; index < 60; index += 1) {
            const result = await adminGet(app.baseUrl, 'companies');
            assert.equal(result.status, 200, `request ${index + 1}`);
        }
        const limited = await adminGet(app.baseUrl, 'companies');
        assert.equal(limited.status, 429);
        assert.equal(limited.body.error, 'rate_limited');
        assert.equal(limited.body.data, undefined);
    });

    it('keeps MCP tools/list byte-identical for owner and customer (R1-24 presence approach)', async () => {
        const ownerListed = await mcpCall(app.baseUrl, ownerToken.access_token, 'tools/list', {});
        const customerListed = await mcpCall(app.baseUrl, customerToken.access_token, 'tools/list', {});
        assert.equal(ownerListed.status, 200);
        assert.equal(customerListed.status, 200);

        const ownerNames = ownerListed.body.result.tools.map(tool => tool.name);
        const customerNames = customerListed.body.result.tools.map(tool => tool.name);
        for (const name of [...SHARED_REFERENCE_TOOLS, ...OWNER_ONLY_REFERENCE_TOOLS]) {
            assert.equal(ownerNames.includes(name), true, name);
        }
        assert.deepEqual(customerNames, CUSTOMER_TOOLS);
        assert.equal(JSON.stringify(ownerListed.body).includes('admin_reference'), false);
        assert.equal(JSON.stringify(customerListed.body).includes('admin'), false);

        // Stable canonical JSON hash of tool definitions (order-sensitive) for regression pinning.
        const ownerHash = crypto.createHash('sha256')
            .update(JSON.stringify(ownerListed.body.result.tools))
            .digest('hex');
        const customerHash = crypto.createHash('sha256')
            .update(JSON.stringify(customerListed.body.result.tools))
            .digest('hex');
        assert.equal(ownerHash.length, 64);
        assert.equal(customerHash.length, 64);
        assert.notEqual(ownerHash, customerHash);
    });
});
