const helpers = require('./helpers/r1-12');
helpers.freezeClock();

process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const {
    REDIRECT_URI,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    insertRate
} = helpers;

// Clock is frozen at 2026-10-13. 2027-07-13 is 273 days ahead: 9 full
// 30-day periods, so a price on file is round(base * 1.45).
const AFTER = '2027-07-13';

describe('partner and MCP missing prices', { concurrency: 1 }, () => {
    let app;
    let token;

    before(async () => {
        app = await startApp({ companyName: 'Null Owner', username: 'null-owner' });
        const owner = app.company.id;
        insertRate(app.db, {
            id: 'r17-null',
            origin: 'SHA',
            destination: 'LAX',
            carrier: 'MSC',
            d20: 1000,
            d40: null,
            d40hc: null,
            expiration: '2027-01-01',
            owner,
            contractOwner: 'Null Owner'
        });
        insertRate(app.db, {
            id: 'r17-zero',
            origin: 'SHA',
            destination: 'NYC',
            carrier: 'MSC',
            d20: 0,
            d40: 1000.6,
            d40hc: 0,
            expiration: '2027-01-01',
            owner,
            contractOwner: 'Null Owner'
        });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        const created = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Null Price Partner',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        token = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: app.cookie,
            csrf: app.csrf,
            clientId: createdBody.client.id,
            clientSecret: createdBody.clientSecret
        })).access_token;
    });

    after(async () => {
        if (app) await app.close();
    });

    async function pair(path, tool, args) {
        const http = await partnerGet(app.baseUrl, token, path);
        const mcp = await mcpCall(app.baseUrl, token, 'tools/call', { name: tool, arguments: args });
        assert.equal(http.status, 200, http.text);
        assert.equal(mcp.status, 200, mcp.text);
        assert.equal(mcp.body.result.isError, false);
        assert.deepEqual(mcp.body.result.structuredContent, http.body);
        return http.body;
    }

    function prices(rate) {
        assert.equal(Object.hasOwn(rate, 'rate20D'), true);
        assert.equal(Object.hasOwn(rate, 'rate40D'), true);
        assert.equal(Object.hasOwn(rate, 'rate40HC'), true);
        return [rate.rate20D, rate.rate40D, rate.rate40HC];
    }

    it('returns null for a missing container price and 0 for a stored zero', async () => {
        const listed = await pair(
            '/api/partner/v1/me/rates?page=1&pageSize=10',
            'rateninja_list_my_rates',
            { page: 1, pageSize: 10 }
        );
        const nullRow = listed.data.find(rate => rate.id === 'r17-null');
        const zeroRow = listed.data.find(rate => rate.id === 'r17-zero');
        assert.deepEqual(prices(nullRow), [1000, null, null]);
        assert.deepEqual(prices(zeroRow), [0, 1001, 0]);

        const nullDetail = await pair(
            '/api/partner/v1/me/rates/r17-null',
            'rateninja_get_my_rate',
            { rateId: 'r17-null' }
        );
        assert.deepEqual(prices(nullDetail.data), [1000, null, null]);

        const zeroDetail = await pair(
            '/api/partner/v1/me/rates/r17-zero',
            'rateninja_get_my_rate',
            { rateId: 'r17-zero' }
        );
        assert.deepEqual(prices(zeroDetail.data), [0, 1001, 0]);
    });

    it('returns null for a missing predictive base and 0 for a stored zero', async () => {
        const body = await pair(
            `/api/partner/v1/me/predictive-pricing?after=${AFTER}&page=1&pageSize=10`,
            'rateninja_get_my_predictive_pricing',
            { after: AFTER, page: 1, pageSize: 10 }
        );
        const nullRow = body.data.find(rate => rate.id === 'r17-null');
        const zeroRow = body.data.find(rate => rate.id === 'r17-zero');
        assert.deepEqual(prices(nullRow), [1450, null, null]);
        assert.deepEqual(prices(zeroRow), [0, 1451, 0]);
    });
});
