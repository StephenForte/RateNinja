'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'synthetic-r157-demo-key';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, partnerGet, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const { insertCompany, insertUser, insertRate, insertMargin, activate, login, utcDay,
    COMPANY_TYPE_CUSTOMER } = require('./helpers/r1-19');
const { leaksBasePrice } = require('./helpers/no-base-price');

const ROOT = '/api/partner/v1/me';
const BASE_PRICES = [8123, 9321, 10431];
const LIMITS = { 'slot-three': 3, 'slot-zero': 0, 'slot-null': null };

function assertLimit(rate) {
    assert.ok(Object.hasOwn(LIMITS, rate.id), rate.id);
    assert.equal(rate.maxSlotsAllowed, LIMITS[rate.id], rate.id);
    const keys = Object.keys(rate);
    const expirationIndex = keys.indexOf('rateExpirationDate');
    assert.ok(expirationIndex >= 0, rate.id);
    assert.equal(keys[expirationIndex + 1], 'maxSlotsAllowed', rate.id);
}

describe('R1-57 partner rate slot limits', () => {
    let app, customerToken, ownerToken;

    before(async () => {
        app = await startApp({ companyName: 'Synthetic R1-57 Owner' });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        insertCompany(app.db, { id: 'buyer-r157', name: 'Synthetic R1-57 Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, { id: 'buyer-r157-user', username: 'buyer-r157', companyId: 'buyer-r157' });
        activate('buyer-r157');
        const buyer = await login(app.baseUrl, 'buyer-r157');
        insertMargin(app.db, { id: 'active-r157', owner: app.company.id, customer: 'buyer-r157', percent: 0.1, number: 7 });
        const [rate20, rate40, rate40hc] = BASE_PRICES;
        for (const [id, maxSlotsAllowed] of Object.entries(LIMITS)) {
            insertRate(app.db, {
                id, owner: app.company.id, rate20, rate40, rate40hc,
                expiration: utcDay(30), maxSlotsAllowed
            });
        }
        const scope = 'rates:read bookings:write';
        const registered = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Synthetic R1-57 OAuth',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: scope.split(' ')
            })
        });
        assert.equal(registered.status, 201);
        const client = await registered.json();
        const issue = async (session, requestedScope) => (await authorizeAndToken({
            baseUrl: app.baseUrl, cookie: session.cookie, csrf: session.csrf,
            clientId: client.client.id, clientSecret: client.clientSecret, scope: requestedScope
        })).access_token;
        customerToken = await issue(buyer, scope);
        ownerToken = await issue(app, 'rates:read');
    });

    after(async () => { await app?.close(); });

    async function pairedData(token, path, name, args = {}) {
        const rest = await partnerGet(app.baseUrl, token, ROOT + path);
        const mcp = await mcpCall(app.baseUrl, token, 'tools/call', { name, arguments: args });
        assert.equal(rest.status, 200, rest.text);
        assert.equal(mcp.status, 200, mcp.text);
        assert.equal(mcp.body.result.isError, false, mcp.text);
        assert.equal(mcp.body.result.content[0].text, rest.text);
        assert.equal(JSON.stringify(mcp.body.result.structuredContent.data), JSON.stringify(rest.body.data));
        return rest.body.data;
    }

    it('publishes the same available rates to customers over REST and MCP without exposing base prices', async () => {
        const rows = await pairedData(customerToken, '/available-rates', 'rateninja_list_available_rates');
        assert.deepEqual(rows.map(rate => rate.id).sort(), Object.keys(LIMITS).sort());
        for (const rate of rows) {
            assertLimit(rate);
            assert.equal(rate.bookable, LIMITS[rate.id] !== 0, rate.id);
            assert.doesNotMatch(JSON.stringify(rate), /"(?:base[^"]*|margin[^"]*|owner_?company_?id)"\s*:/i);
            for (const base of BASE_PRICES) assert.equal(leaksBasePrice(rate, base), false, rate.id);
        }
    });

    it('publishes the same limits on owner list and detail responses over REST and MCP', async () => {
        const rows = await pairedData(ownerToken, '/rates', 'rateninja_list_my_rates');
        assert.deepEqual(rows.map(rate => rate.id).sort(), Object.keys(LIMITS).sort());
        for (const row of rows) {
            const detail = await pairedData(ownerToken, `/rates/${row.id}`, 'rateninja_get_my_rate', { rateId: row.id });
            for (const rate of [row, detail]) {
                assertLimit(rate);
                assert.equal(rate.capacityQuantity, null);
            }
            assert.equal(JSON.stringify(detail), JSON.stringify(row));
        }
    });

    it('describes the per-request limit on both customer MCP tools', async () => {
        const response = await mcpCall(app.baseUrl, customerToken, 'tools/list', {});
        assert.equal(response.status, 200, response.text);
        for (const name of ['rateninja_list_available_rates', 'rateninja_create_booking_request']) {
            const tool = response.body.result.tools.find(tool => tool.name === name);
            assert.ok(tool, name);
            assert.match(tool.description, /A request may ask for at most maxSlotsAllowed slots, with 0 meaning the rate cannot be booked and null meaning there is no per-rate limit\./);
        }
    });

    it('keeps the slot limit off public API rates', async () => {
        const response = await fetch(`${app.baseUrl}/api/v1/rates`, { headers: { 'x-api-key': process.env.RATE_NINJA_API_KEY } });
        assert.equal(response.status, 200);
        const { data } = await response.json();
        assert.deepEqual(data.map(rate => rate.id).sort(), Object.keys(LIMITS).sort());
        for (const rate of data) {
            assert.equal(Object.hasOwn(rate, 'maxSlotsAllowed'), false);
            assert.equal(Object.hasOwn(rate, 'max_slots_allowed'), false);
        }
    });
});
