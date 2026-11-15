'use strict';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
    dayBefore,
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
freezeToday();

let earliestDepartingAfter;
let predictiveWindow;

const ALL = 'profile:read rates:read sailings:read bookings:read bookings:write';
const ROOT = '/api/partner/v1/me';
const PAIRS = [
    ['/rate-date-ranges', 'rateninja_list_rate_date_ranges'],
    ['/origin-ports', 'rateninja_list_valid_origin_ports'],
    ['/destination-ports', 'rateninja_list_valid_destination_ports'],
    ['/contract-owners', 'rateninja_list_valid_contract_owners'],
    ['/sailing-date-ranges', 'rateninja_list_sailing_date_ranges'],
    ['/predictive-date-ranges', 'rateninja_list_predictive_date_ranges']
];

describe('R1-24 reference lookups and date ranges', { concurrency: 1 }, () => {
    let app;
    let client;
    let ownerToken;
    let customerToken;
    let ownerRatesOnlyToken;
    let buyerSession;

    const get = (token, path) => partnerGet(app.baseUrl, token, path);
    const rpc = (token, name, args = {}) => mcpCall(app.baseUrl, token, 'tools/call', { name, arguments: args });

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
        app = await startApp({ companyName: 'R124 Owner Co' });
        ({ earliestDepartingAfter } = require('../lib/reference-ranges'));
        ({ predictiveWindow } = require('../lib/predictive'));
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);

        insertCompany(app.db, { id: 'buyer', name: 'R124 Buyer', type: CUSTOMER });
        insertCompany(app.db, { id: 'sibling', name: 'R124 Sibling', type: CUSTOMER });
        insertCompany(app.db, { id: 'unlinked', name: 'R124 Unlinked Owner', type: OWNER });
        insertCompany(app.db, { id: 'revoked-owner', name: 'R124 Revoked Owner', type: OWNER });
        insertUser(app.db, { id: 'buyer-user', username: 'r124-buyer', companyId: 'buyer', role: 'company_admin' });
        activate('r124-buyer');
        buyerSession = await login(app.baseUrl, 'r124-buyer');

        insertMargin(app.db, { id: 'm-active', owner: app.company.id, customer: 'buyer', percent: 0.1, number: 0 });
        insertMargin(app.db, {
            id: 'm-revoked',
            owner: 'revoked-owner',
            customer: 'buyer',
            percent: 0.1,
            number: 0,
            status: 'revoked'
        });

        insertPort(app.db, { id: 'port-pkg', code: 'MYPKG', name: 'Port Klang' });
        insertPort(app.db, { id: 'port-lalb', code: 'USLGB', name: 'LALB' });
        insertPort(app.db, { id: 'port-sha', code: 'CNSHA', name: 'Shanghai' });
        insertPort(app.db, { id: 'port-sea', code: 'USSEA', name: 'Seattle' });

        // Worked example: three current periods + one expired.
        insertRate(app.db, {
            id: 'r-pkg-1',
            owner: app.company.id,
            origin: 'Port Klang',
            destination: 'LALB',
            effective: '2026-10-26',
            expiration: '2026-11-19'
        });
        insertRate(app.db, {
            id: 'r-pkg-2',
            owner: app.company.id,
            origin: 'Port Klang',
            destination: 'LALB',
            effective: '2026-11-20',
            expiration: '2026-12-31'
        });
        insertRate(app.db, {
            id: 'r-sha-1',
            owner: app.company.id,
            origin: 'Shanghai',
            destination: 'Seattle',
            effective: '2026-10-26',
            expiration: '2026-11-19'
        });
        insertRate(app.db, {
            id: 'r-expired',
            owner: app.company.id,
            origin: 'Expired Origin',
            destination: 'Expired Dest',
            effective: '2026-01-01',
            expiration: '2026-11-13'
        });
        // Current-definition edge cases.
        insertRate(app.db, {
            id: 'r-today',
            owner: app.company.id,
            origin: 'Today Origin',
            destination: 'Today Dest',
            effective: '2026-01-01',
            expiration: '2026-11-14'
        });
        insertRate(app.db, {
            id: 'r-blank',
            owner: app.company.id,
            origin: 'Blank Origin',
            destination: 'Blank Dest',
            effective: '2026-01-01',
            expiration: null
        });
        insertRate(app.db, {
            id: 'r-future',
            owner: app.company.id,
            origin: 'Future Origin',
            destination: 'Future Dest',
            effective: '2027-01-01',
            expiration: '2027-12-31'
        });
        insertRate(app.db, {
            id: 'r-deleted',
            owner: app.company.id,
            origin: 'Deleted Origin',
            destination: 'Deleted Dest',
            effective: '2026-01-01',
            expiration: '2026-12-31',
            deletedAt: '2026-11-01T00:00:00.000Z'
        });
        // Unlinked / revoked owner leakage seeds.
        insertRate(app.db, {
            id: 'r-unlinked',
            owner: 'unlinked',
            origin: 'Secret Origin',
            destination: 'Secret Dest',
            contractOwner: 'Secret Owner Label',
            effective: '2026-01-01',
            expiration: '2026-12-31'
        });
        insertRate(app.db, {
            id: 'r-revoked',
            owner: 'revoked-owner',
            origin: 'Revoked Origin',
            destination: 'Revoked Dest',
            contractOwner: 'Revoked Owner Label',
            effective: '2026-01-01',
            expiration: '2026-12-31'
        });

        insertSailing(app.db, {
            id: 's-today',
            owner: app.company.id,
            departurePort: 'Port Klang',
            arrivalPort: 'LALB',
            departure: '2026-11-14T08:00:00.000Z'
        });
        insertSailing(app.db, {
            id: 's-later',
            owner: app.company.id,
            departurePort: 'Port Klang',
            arrivalPort: 'LALB',
            departure: '2026-12-01T08:00:00.000Z'
        });
        insertSailing(app.db, {
            id: 's-past',
            owner: app.company.id,
            departurePort: 'Shanghai',
            arrivalPort: null,
            departure: '2026-11-13T08:00:00.000Z'
        });
        insertSailing(app.db, {
            id: 's-null-arrival',
            owner: app.company.id,
            departurePort: 'Shanghai',
            arrivalPort: null,
            departure: '2026-11-20T00:00:00.000Z'
        });
        insertSailing(app.db, {
            id: 's-deleted',
            owner: app.company.id,
            departurePort: 'Deleted Sail Origin',
            arrivalPort: 'Deleted Sail Dest',
            departure: '2026-11-20T00:00:00.000Z',
            deletedAt: '2026-11-01T00:00:00.000Z'
        });

        client = await register('R124 Client');
        ownerToken = await issue({ cookie: app.cookie, csrf: app.csrf });
        customerToken = await issue(buyerSession);
        ownerRatesOnlyToken = await issue(
            { cookie: app.cookie, csrf: app.csrf },
            'profile:read rates:read',
            await register('R124 Owner Rates Client')
        );
    });

    after(async () => {
        if (app) await app.close();
    });

    it('returns the worked example rows and resolves port codes for current rates', async () => {
        const ranges = await get(ownerToken.access_token, `${ROOT}/rate-date-ranges`);
        assert.equal(ranges.status, 200, ranges.text);
        const worked = ranges.body.data.filter(row => (
            (row.originPort === 'Port Klang' && row.destinationPort === 'LALB')
            || (row.originPort === 'Shanghai' && row.destinationPort === 'Seattle')
        ));
        assert.equal(worked.length, 3);
        assert.deepEqual(
            worked.map(row => [row.originPort, row.destinationPort, row.rateEffectiveDate, row.rateExpirationDate, row.rateCount]),
            [
                ['Port Klang', 'LALB', '2026-10-26', '2026-11-19', 1],
                ['Port Klang', 'LALB', '2026-11-20', '2026-12-31', 1],
                ['Shanghai', 'Seattle', '2026-10-26', '2026-11-19', 1]
            ]
        );
        assert.equal(ranges.body.data.some(row => row.originPort === 'Expired Origin'), false);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Deleted Origin'), false);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Today Origin'), true);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Blank Origin'), true);
        assert.equal(ranges.body.data.some(row => row.originPort === 'Future Origin'), true);

        const origins = await get(ownerToken.access_token, `${ROOT}/origin-ports`);
        const destinations = await get(ownerToken.access_token, `${ROOT}/destination-ports`);
        assert.deepEqual(
            origins.body.data.find(row => row.value === 'Port Klang'),
            { value: 'Port Klang', code: 'MYPKG', name: 'Port Klang' }
        );
        assert.deepEqual(
            destinations.body.data.find(row => row.value === 'LALB'),
            { value: 'LALB', code: 'USLGB', name: 'LALB' }
        );
        assert.equal(origins.body.data.some(row => row.value === 'Expired Origin'), false);
        assert.equal(destinations.body.data.some(row => row.value === 'Secret Dest'), false);
        assert.equal(JSON.stringify(ranges.body).includes('rate20'), false);
        assert.equal(JSON.stringify(ranges.body).includes('8123'), false);
    });

    it('keeps MCP and partner parity for every reference read', async () => {
        for (const [path, tool] of PAIRS) {
            const api = await get(ownerToken.access_token, `${ROOT}${path}`);
            const mcp = await rpc(ownerToken.access_token, tool);
            assert.equal(api.status, 200, api.text);
            assert.equal(mcp.body.result.isError, false, mcp.text);
            assert.deepEqual(mcp.body.result.structuredContent, api.body);
            assert.equal(api.body.meta.notice.includes('allocatable'), true);
            assert.equal(typeof api.body.meta.total, 'number');
            assert.equal(typeof api.body.meta.page, 'number');
            assert.equal(typeof api.body.meta.pageSize, 'number');
            assert.equal(typeof api.body.meta.returned, 'number');
        }
        for (const [path, tool] of PAIRS.slice(0, 4)) {
            const api = await get(customerToken.access_token, `${ROOT}${path}`);
            const mcp = await rpc(customerToken.access_token, tool);
            assert.equal(api.status, 200, api.text);
            assert.deepEqual(mcp.body.result.structuredContent, api.body);
        }
    });

    it('enforces audience and scope, and keeps customer tools/list additions exact', async () => {
        for (const path of ['/sailing-date-ranges', '/predictive-date-ranges']) {
            const api = await get(customerToken.access_token, `${ROOT}${path}`);
            assert.equal(api.status, 403, api.text);
            assert.equal(api.body.error, 'owner_only');
        }
        for (const tool of OWNER_ONLY_REFERENCE_TOOLS) {
            const mcp = await rpc(customerToken.access_token, tool, { unexpected: true });
            assert.equal(mcp.body.result.isError, true);
            assert.equal(mcp.body.result.structuredContent.error, 'owner_only');
        }
        const listed = await mcpCall(app.baseUrl, customerToken.access_token, 'tools/list', {});
        assert.deepEqual(listed.body.result.tools.map(tool => tool.name), CUSTOMER_TOOLS);
        for (const name of OWNER_ONLY_REFERENCE_TOOLS) {
            assert.equal(listed.body.result.tools.some(tool => tool.name === name), false);
        }
        for (const name of SHARED_REFERENCE_TOOLS) {
            assert.equal(listed.body.result.tools.some(tool => tool.name === name), true);
        }

        const ownerListed = await mcpCall(app.baseUrl, ownerToken.access_token, 'tools/list', {});
        const ownerNames = ownerListed.body.result.tools.map(tool => tool.name);
        for (const name of [...SHARED_REFERENCE_TOOLS, ...OWNER_ONLY_REFERENCE_TOOLS]) {
            assert.equal(ownerNames.includes(name), true, name);
        }
        assert.equal(ownerNames.includes('rateninja_list_available_rates'), false);

        assert.equal((await get(ownerRatesOnlyToken.access_token, `${ROOT}/sailing-date-ranges`)).body.error, 'insufficient_scope');
        const noRates = await issue(buyerSession, 'profile:read', await register('R124 Profile Client'));
        assert.equal((await get(noRates.access_token, `${ROOT}/rate-date-ranges`)).body.error, 'insufficient_scope');
        assert.equal(
            (await rpc(noRates.access_token, 'rateninja_list_rate_date_ranges')).body.result.structuredContent.error,
            'insufficient_scope'
        );
    });

    it('does not leak unlinked or revoked owner ports, owners, or periods to a customer', async () => {
        const forbidden = ['Secret Origin', 'Secret Dest', 'Secret Owner Label', 'Revoked Origin', 'Revoked Dest', 'Revoked Owner Label'];
        for (const path of ['/rate-date-ranges', '/origin-ports', '/destination-ports', '/contract-owners']) {
            const api = await get(customerToken.access_token, `${ROOT}${path}`);
            assert.equal(api.status, 200, api.text);
            const text = JSON.stringify(api.body);
            for (const needle of forbidden) {
                assert.equal(text.includes(needle), false, `${path} leaked ${needle}`);
            }
            assert.equal(text.includes('ownerCompanyId'), false);
            assert.equal(text.includes('unlinked'), false);
            assert.equal(text.includes('revoked-owner'), false);
        }
        assert.equal(
            (await get(customerToken.access_token, `${ROOT}/origin-ports`)).body.data.some(row => row.value === 'Port Klang'),
            true
        );

        app.db.prepare("UPDATE company_margins SET status = 'revoked' WHERE id = 'm-active'").run();
        const afterRevoke = await get(customerToken.access_token, `${ROOT}/origin-ports`);
        assert.equal(afterRevoke.body.data.some(row => row.value === 'Port Klang'), false);
        app.db.prepare("UPDATE company_margins SET status = 'active' WHERE id = 'm-active'").run();
        const restored = await get(customerToken.access_token, `${ROOT}/origin-ports`);
        assert.equal(restored.body.data.some(row => row.value === 'Port Klang'), true);
    });

    it('advertises an earliestDepartingAfter that predictive pricing accepts, and rejects the day before', async () => {
        const ranges = await get(ownerToken.access_token, `${ROOT}/predictive-date-ranges`);
        assert.equal(ranges.status, 200, ranges.text);
        assert.ok(ranges.body.data.length >= 1);
        const after = ranges.body.data[0].earliestDepartingAfter;
        assert.equal(after, earliestDepartingAfter());
        assert.equal(predictiveWindow(after).ok, true);
        assert.equal(ranges.body.data.every(row => row.latestDepartingAfter === null), true);

        const ok = await rpc(ownerToken.access_token, 'rateninja_get_my_predictive_pricing', { after });
        assert.equal(ok.body.result.isError, false, ok.text);
        assert.equal(ok.status, 200);

        const tooSoon = dayBefore(after);
        const denied = await rpc(ownerToken.access_token, 'rateninja_get_my_predictive_pricing', { after: tooSoon });
        assert.equal(denied.body.result.isError, true);
        assert.match(denied.body.result.structuredContent.error_description, /more than 90 days/i);

        const sailings = await get(ownerToken.access_token, `${ROOT}/sailing-date-ranges`);
        assert.equal(sailings.status, 200, sailings.text);
        const pkg = sailings.body.data.find(row => row.departurePort.value === 'Port Klang');
        assert.deepEqual(pkg.departurePort, { value: 'Port Klang', code: 'MYPKG', name: 'Port Klang' });
        assert.deepEqual(pkg.arrivalPort, { value: 'LALB', code: 'USLGB', name: 'LALB' });
        assert.equal(pkg.firstDeparture, '2026-11-14');
        assert.equal(pkg.lastDeparture, '2026-12-01');
        assert.equal(pkg.sailingCount, 2);
        const sha = sailings.body.data.find(row => row.departurePort.value === 'Shanghai');
        assert.equal(sha.arrivalPort, null);
        assert.equal(sha.firstDeparture, '2026-11-20');
        assert.equal(sailings.body.data.some(row => row.departurePort.value === 'Deleted Sail Origin'), false);
    });

    it('writes partner audit events for each reference read', async () => {
        const before = Number(app.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
        await get(ownerToken.access_token, `${ROOT}/rate-date-ranges`);
        await rpc(ownerToken.access_token, 'rateninja_list_valid_origin_ports');
        const rows = app.db.prepare(`
            SELECT event_type, client_id, detail FROM audit_events
            WHERE event_type IN (
                'partner_rate_date_ranges_read',
                'partner_origin_ports_read'
            )
            ORDER BY created_at DESC
            LIMIT 4
        `).all();
        assert.ok(rows.some(row => row.event_type === 'partner_rate_date_ranges_read' && row.client_id === client.id && !JSON.parse(row.detail).channel));
        assert.ok(rows.some(row => row.event_type === 'partner_origin_ports_read' && JSON.parse(row.detail).channel === 'mcp'));
        const after = Number(app.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
        assert.ok(after > before);
    });
});
