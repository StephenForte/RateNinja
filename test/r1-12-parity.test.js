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
    PASSWORD,
    REDIRECT_URI,
    cookieHeader,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    insertCompany,
    insertUser,
    insertRate,
    insertSailing
} = helpers;

function audits(db, eventType) {
    return db.prepare(`
        SELECT event_type, actor_user_id, client_id, detail
        FROM audit_events
        WHERE event_type = ?
        ORDER BY rowid
    `).all(eventType);
}

describe('partner and MCP parity', { concurrency: 1 }, () => {
    let app;
    let client;
    let ownerA;
    let ownerB;
    let tokenA;
    let tokenB;
    let profileToken;

    before(async () => {
        app = await startApp({ companyName: 'Owner A', username: 'owner-a' });
        const db = app.db;
        insertCompany(db, { id: 'owner-b', name: 'Owner B', type: 'Contract Owner', typeId: 'contract_owner', admin: 1 });
        insertCompany(db, { id: 'owner-c', name: 'Owner C', type: 'Contract Owner', typeId: 'contract_owner', admin: 1 });
        insertCompany(db, { id: 'customer-c', name: 'Customer C', type: 'Freight Forwarder/Customer', typeId: 'freight_forwarder_customer' });
        insertUser(db, { id: 'user-b', username: 'owner-b', companyId: 'owner-b', admin: 1 });
        insertUser(db, { id: 'user-c', username: 'owner-c', companyId: 'owner-c', admin: 1 });
        insertUser(db, { id: 'user-customer', username: 'customer-c', companyId: 'customer-c' });
        const { setPasswordByUsername } = require('../lib/accounts');
        for (const name of ['owner-b', 'owner-c', 'customer-c']) {
            assert.equal(setPasswordByUsername(name, PASSWORD).ok, true);
        }
        const store = require('../lib/store');
        store.upsertCompanyMargin(app.company.id, 'customer-c', { marginPercent: 0.1, marginNumber: 0 });

        const owner = app.company.id;
        insertRate(db, { id: 'a-rate-1', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1000, d40: 1800, d40hc: 1900, expiration: '2026-12-01', owner, contractOwner: 'Owner A', notes: 'a1' });
        insertRate(db, { id: 'a-rate-2', origin: 'SHA', destination: 'NYC', carrier: 'MSC', d20: 2000, d40: 3000, d40hc: 3100, expiration: '2026-03-01', owner, contractOwner: 'Owner A', notes: 'a2' });
        insertRate(db, { id: 'a-rate-3', origin: 'NGB', destination: 'LAX', carrier: 'CMA', d20: 800, d40: 1500, d40hc: 1550, expiration: '2026-09-01', owner, contractOwner: 'Owner A', notes: 'a3' });
        insertRate(db, { id: 'b-rate-1', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 9000, d40: 9000, d40hc: 9000, expiration: '2027-06-01', owner: 'owner-b', contractOwner: 'Owner B', notes: 'b1' });
        insertRate(db, { id: 'pred-old', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1000, d40: 1000, d40hc: 1000, expiration: '2026-01-01', owner, contractOwner: 'Owner A' });
        insertRate(db, { id: 'pred-new', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1100, d40: 2100, d40hc: 2200, effective: '2026-11-01', expiration: '2027-03-01', owner, contractOwner: 'Owner A' });
        insertRate(db, { id: 'pred-nyc', origin: 'SHA', destination: 'NYC', carrier: 'MSC', d20: 900, d40: 1600, d40hc: 1700, expiration: '2026-08-01', owner, contractOwner: 'Owner A' });
        insertSailing(db, { id: 'a-sail-1', departure: '2026-05-01T00:00:00.000Z', carrier: 'MSC', origin: 'SHA', owner, vessel: 'Early' });
        insertSailing(db, { id: 'a-sail-2', departure: '2026-08-01T00:00:00.000Z', carrier: 'MSC', origin: 'SHA', owner, vessel: 'Late' });
        insertSailing(db, { id: 'b-sail-1', departure: '2026-08-01T00:00:00.000Z', carrier: 'MSC', origin: 'SHA', owner: 'owner-b', vessel: 'Other' });

        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);

        const created = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Parity Partner',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        client = { id: createdBody.client.id, secret: createdBody.clientSecret };
        const limited = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Profile Only Partner',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const limitedBody = await limited.json();
        assert.equal(limited.status, 201, JSON.stringify(limitedBody));
        const limitedClient = { id: limitedBody.client.id, secret: limitedBody.clientSecret };
        ownerA = {
            id: db.prepare(`SELECT id FROM users WHERE username = 'owner-a'`).get().id,
            cookie: app.cookie,
            csrf: app.csrf
        };
        tokenA = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: ownerA.cookie,
            csrf: ownerA.csrf,
            clientId: client.id,
            clientSecret: client.secret
        })).access_token;
        const loginB = await fetch(`${app.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'owner-b', password: PASSWORD })
        });
        const loginBBody = await loginB.json();
        assert.equal(loginB.status, 200, JSON.stringify(loginBBody));
        ownerB = { id: 'user-b', cookie: cookieHeader(loginB), csrf: loginBBody.csrfToken };
        tokenB = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: ownerB.cookie,
            csrf: ownerB.csrf,
            clientId: client.id,
            clientSecret: client.secret
        })).access_token;
        profileToken = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: ownerA.cookie,
            csrf: ownerA.csrf,
            clientId: limitedClient.id,
            clientSecret: limitedClient.secret,
            scope: 'profile:read'
        })).access_token;
    });

    after(async () => {
        process.env.PARTNER_OAUTH_ENABLED = 'true';
        if (app) await app.close();
    });

    async function step(name, fn) {
        try {
            await fn();
        } catch (error) {
            if (error instanceof Error) error.message = `${name}\n${error.message}`;
            throw error;
        }
    }

    async function assertPair(path, tool, args, token = tokenA) {
        const http = await partnerGet(app.baseUrl, token, path);
        const mcp = await mcpCall(app.baseUrl, token, 'tools/call', { name: tool, arguments: args });
        assert.equal(http.status, 200, http.text);
        assert.equal(mcp.status, 200, mcp.text);
        assert.equal(mcp.body.result.isError, false);
        assert.deepEqual(mcp.body.result.structuredContent, http.body);
        return http.body;
    }

    it('covers partner and MCP parity end to end', async () => {
    await step('returns the same rate and sailing pages, filters, and details', async () => {
        const rates = await assertPair(
            '/api/partner/v1/me/rates?carrier=msc&originPort=sha&destinationPort=LAX&effectiveDate=2026-06-01&page=1&pageSize=10',
            'rateninja_list_my_rates',
            { carrier: 'msc', originPort: 'sha', destinationPort: 'LAX', effectiveDate: '2026-06-01', page: 1, pageSize: 10 }
        );
        assert.deepEqual(rates.data.map(rate => rate.id), ['a-rate-1']);
        assert.equal(rates.meta.pageSize, 10);
        assert.equal(rates.data[0].rate20D, 1000);

        const page = await assertPair(
            '/api/partner/v1/me/rates?page=2&pageSize=1',
            'rateninja_list_my_rates',
            { page: 2, pageSize: 1 }
        );
        assert.equal(page.data.length, 1);
        assert.equal(page.meta.page, 2);
        assert.equal(page.meta.pageSize, 1);

        const detail = await assertPair(
            '/api/partner/v1/me/rates/a-rate-1',
            'rateninja_get_my_rate',
            { rateId: 'a-rate-1' }
        );
        assert.equal(detail.data.id, 'a-rate-1');
        assert.equal(detail.data.source, 'base_contract');

        const sailings = await assertPair(
            '/api/partner/v1/me/sailings?carrier=MSC&originPort=SHA&after=2026-06-01&page=1&pageSize=10',
            'rateninja_list_my_sailings',
            { carrier: 'MSC', originPort: 'SHA', after: '2026-06-01', page: 1, pageSize: 10 }
        );
        assert.deepEqual(sailings.data.map(sailing => sailing.id), ['a-sail-2']);

        const sailingPage = await assertPair(
            '/api/partner/v1/me/sailings?page=2&pageSize=1',
            'rateninja_list_my_sailings',
            { page: 2, pageSize: 1 }
        );
        assert.equal(sailingPage.data[0].id, 'a-sail-2');

        const sailing = await assertPair(
            '/api/partner/v1/me/sailings/a-sail-1',
            'rateninja_get_my_sailing',
            { sailingId: 'a-sail-1' }
        );
        assert.equal(sailing.data.id, 'a-sail-1');

        const empty = await assertPair(
            '/api/partner/v1/me/rates?carrier=NO-SUCH',
            'rateninja_list_my_rates',
            { carrier: 'NO-SUCH' }
        );
        assert.deepEqual(empty.data, []);
        assert.equal(empty.meta.total, 0);
        assert.equal(empty.meta.returned, 0);

        const capped = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/rates?pageSize=1000');
        assert.equal(capped.status, 200);
        assert.equal(capped.body.meta.pageSize, 100);
    });

    await step('returns the same owner predictive estimate and rejects 90 days', async () => {
        const body = await assertPair(
            '/api/partner/v1/me/predictive-pricing?after=2027-07-13&carrier=msc&originPort=sha&page=1&pageSize=10',
            'rateninja_get_my_predictive_pricing',
            { after: '2027-07-13', carrier: 'msc', originPort: 'sha', page: 1, pageSize: 10 }
        );
        assert.deepEqual(body.data.map(rate => rate.id), ['pred-new', 'pred-nyc']);
        assert.equal(body.data[0].rate20D, 1595);
        assert.notEqual(body.data[0].rate20D, 1755);
        assert.equal(body.data[0].estimate, true);
        assert.equal(body.data[0].source, 'base_contract');
        assert.equal('margin' in body.data[0], false);
        assert.equal(body.meta.estimate, true);
        assert.equal(body.meta.after, '2027-07-13');
        assert.equal(body.meta.basis.formula, '5_percent_per_full_30_day_period');
        assert.equal(body.meta.basis.fullThirtyDayPeriods, 9);
        assert.equal(body.meta.owner.companyId, app.company.id);
        assert.equal(body.meta.owner.companyName, 'Owner A');
        assert.equal(body.meta.total, 2);
        assert.equal(typeof body.meta.notice, 'string');

        const second = await assertPair(
            '/api/partner/v1/me/predictive-pricing?after=2027-07-13&carrier=msc&originPort=sha&page=2&pageSize=1',
            'rateninja_get_my_predictive_pricing',
            { after: '2027-07-13', carrier: 'msc', originPort: 'sha', page: 2, pageSize: 1 }
        );
        assert.deepEqual(second.data.map(rate => rate.id), ['pred-nyc']);
        assert.equal(second.meta.page, 2);
        assert.equal(second.meta.returned, 1);

        const accepted = await assertPair(
            '/api/partner/v1/me/predictive-pricing?after=2027-01-12&carrier=MSC&originPort=SHA&pageSize=1',
            'rateninja_get_my_predictive_pricing',
            { after: '2027-01-12', carrier: 'MSC', originPort: 'SHA', pageSize: 1 }
        );
        assert.equal(accepted.data[0].rate20D, 1265);
        assert.equal(accepted.meta.basis.fullThirtyDayPeriods, 3);

        const tooSoon = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/predictive-pricing?after=2027-01-11');
        assert.equal(tooSoon.status, 400);
        assert.equal(tooSoon.body.error, 'invalid_request');
        assert.match(tooSoon.body.error_description, /more than 90 days/);
        const tooSoonMcp = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after: '2027-01-11' }
        });
        assert.equal(tooSoonMcp.body.result.isError, true);
        assert.equal(tooSoonMcp.body.result.structuredContent.error, 'invalid_request');
        assert.equal(tooSoonMcp.body.result.structuredContent.data, undefined);

        const empty = await assertPair(
            '/api/partner/v1/me/predictive-pricing?after=2027-07-13&carrier=NO-SUCH',
            'rateninja_get_my_predictive_pricing',
            { after: '2027-07-13', carrier: 'NO-SUCH' }
        );
        assert.deepEqual(empty.data, []);
        assert.equal(empty.meta.total, 0);
    });

    await step('hides the other owner on both transports', async () => {
        const hiddenRate = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/rates/b-rate-1');
        assert.equal(hiddenRate.status, 404);
        assert.equal(hiddenRate.body.error, 'not_found');
        const hiddenMcp = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
            name: 'rateninja_get_my_rate',
            arguments: { rateId: 'b-rate-1' }
        });
        assert.equal(hiddenMcp.body.result.isError, true);
        assert.equal(hiddenMcp.body.result.structuredContent.error, 'not_found');
        assert.equal(hiddenMcp.body.result.structuredContent.data, undefined);

        const hiddenSailing = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/sailings/b-sail-1');
        assert.equal(hiddenSailing.status, 404);
        assert.equal(hiddenSailing.body.error, 'not_found');
        const hiddenSailingMcp = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
            name: 'rateninja_get_my_sailing',
            arguments: { sailingId: 'b-sail-1' }
        });
        assert.equal(hiddenSailingMcp.body.result.structuredContent.error, 'not_found');

        const mine = await partnerGet(app.baseUrl, tokenB, '/api/partner/v1/me/rates/b-rate-1');
        assert.equal(mine.status, 200);
        assert.equal(mine.body.data.rate20D, 9000);
        const listed = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/predictive-pricing?after=2027-07-13');
        assert.equal(listed.body.data.some(rate => rate.id === 'b-rate-1' || rate.rate20D === 9000), false);
        const listedMcp = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after: '2027-07-13' }
        });
        assert.deepEqual(listedMcp.body.result.structuredContent, listed.body);
    });

    await step('requires rates:read and sailings:read on both transports', async () => {
        const rates = await partnerGet(app.baseUrl, profileToken, '/api/partner/v1/me/rates');
        assert.equal(rates.status, 403);
        assert.equal(rates.body.error, 'insufficient_scope');
        const ratesMcp = await mcpCall(app.baseUrl, profileToken, 'tools/call', {
            name: 'rateninja_list_my_rates',
            arguments: {}
        });
        assert.equal(ratesMcp.body.result.isError, true);
        assert.equal(ratesMcp.body.result.structuredContent.error, 'insufficient_scope');
        const predictive = await partnerGet(app.baseUrl, profileToken, '/api/partner/v1/me/predictive-pricing?after=2027-07-13');
        assert.equal(predictive.status, 403);
        assert.equal(predictive.body.error, 'insufficient_scope');
        const predictiveMcp = await mcpCall(app.baseUrl, profileToken, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after: '2027-07-13' }
        });
        assert.equal(predictiveMcp.body.result.structuredContent.error, 'insufficient_scope');
        const sailings = await partnerGet(app.baseUrl, profileToken, '/api/partner/v1/me/sailings');
        assert.equal(sailings.body.error, 'insufficient_scope');
        const profile = await mcpCall(app.baseUrl, profileToken, 'tools/call', {
            name: 'rateninja_get_my_profile',
            arguments: {}
        });
        assert.equal(profile.body.result.isError, false);
        assert.equal(profile.body.result.structuredContent.companyName, 'Owner A');
    });

    await step('rejects malformed MCP arguments before the tool runs and audits successful reads once', async () => {
        const before = audits(app.db, 'partner_rates_read').length;
        const cases = [
            { arguments: { carrier: 'MSC', unexpected: true } },
            { arguments: { carrier: 1 } },
            { arguments: { rateId: 'a-rate-1', unexpected: true }, name: 'rateninja_get_my_rate' },
            { arguments: {}, name: 'rateninja_get_my_rate' },
            { arguments: { effectiveDate: 'not-a-date' } },
            { arguments: { pageSize: 101 } },
            { arguments: { page: 10001 } },
            { arguments: { after: '07-13-2027' }, name: 'rateninja_get_my_predictive_pricing' },
            { arguments: {}, name: 'rateninja_get_my_predictive_pricing' }
        ];
        for (const item of cases) {
            const response = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
                name: item.name || 'rateninja_list_my_rates',
                arguments: item.arguments
            });
            assert.equal(response.body.result.isError, true, JSON.stringify(item));
            assert.equal(response.body.result.structuredContent.error, 'invalid_request', JSON.stringify(item));
            assert.equal(response.body.result.structuredContent.data, undefined, JSON.stringify(item));
        }
        assert.equal(audits(app.db, 'partner_rates_read').length, before);

        const predictiveBefore = audits(app.db, 'partner_predictive_read').length;
        const read = await mcpCall(app.baseUrl, tokenA, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after: '2027-07-13', pageSize: 1 }
        });
        assert.equal(read.body.result.isError, false);
        const predictiveRows = audits(app.db, 'partner_predictive_read');
        assert.equal(predictiveRows.length, predictiveBefore + 1);
        const predictiveDetail = JSON.parse(predictiveRows.at(-1).detail);
        assert.deepEqual(predictiveDetail, { count: 1, channel: 'mcp' });
        assert.equal(predictiveRows.at(-1).client_id, client.id);
        assert.equal(predictiveRows.at(-1).actor_user_id, ownerA.id);
        assert.equal(predictiveRows.at(-1).detail.includes(tokenA), false);

        const rateBefore = audits(app.db, 'partner_rates_read').length;
        await mcpCall(app.baseUrl, tokenA, 'tools/call', { name: 'rateninja_list_my_rates', arguments: { pageSize: 1 } });
        await mcpCall(app.baseUrl, tokenA, 'tools/call', { name: 'rateninja_get_my_rate', arguments: { rateId: 'a-rate-1' } });
        const rateRows = audits(app.db, 'partner_rates_read');
        assert.equal(rateRows.length, rateBefore + 2);
        for (const row of rateRows.slice(-2)) {
            assert.equal(row.client_id, client.id);
            assert.equal(row.actor_user_id, ownerA.id);
            assert.equal(JSON.parse(row.detail).channel, 'mcp');
            assert.equal(row.detail.includes('a-rate-1'), false);
        }

        const sailingBefore = audits(app.db, 'partner_sailings_read').length;
        await mcpCall(app.baseUrl, tokenA, 'tools/call', { name: 'rateninja_list_my_sailings', arguments: {} });
        await mcpCall(app.baseUrl, tokenA, 'tools/call', { name: 'rateninja_get_my_sailing', arguments: { sailingId: 'a-sail-1' } });
        const sailingRows = audits(app.db, 'partner_sailings_read');
        assert.equal(sailingRows.length, sailingBefore + 2);
        assert.equal(JSON.parse(sailingRows.at(-1).detail).channel, 'mcp');

        const partnerPredictive = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/predictive-pricing?after=2027-07-13&pageSize=1');
        assert.equal(partnerPredictive.status, 200);
        const partnerRow = audits(app.db, 'partner_predictive_read').at(-1);
        assert.deepEqual(JSON.parse(partnerRow.detail), { count: 1 });
        assert.equal(partnerRow.client_id, client.id);
    });

    await step('stops the next call after revoke, deactivation, and a session epoch bump', async () => {
        const fresh = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: ownerA.cookie,
            csrf: ownerA.csrf,
            clientId: client.id,
            clientSecret: client.secret
        })).access_token;
        const revoked = await app.request(`/oauth/consents/${client.id}`, { method: 'DELETE' });
        assert.equal(revoked.status, 200);
        const afterRevoke = await partnerGet(app.baseUrl, fresh, '/api/partner/v1/me/rates');
        assert.equal(afterRevoke.status, 401);
        assert.equal(afterRevoke.body.error, 'invalid_token');
        const afterRevokeMcp = await mcpCall(app.baseUrl, fresh, 'tools/call', { name: 'rateninja_list_my_rates', arguments: {} });
        assert.equal(afterRevokeMcp.status, 401);
        assert.equal(afterRevokeMcp.body.error.message, 'invalid_token');

        app.db.prepare(`UPDATE users SET disabled = 1 WHERE id = 'user-b'`).run();
        const disabledHttp = await partnerGet(app.baseUrl, tokenB, '/api/partner/v1/me/rates');
        const disabledMcp = await mcpCall(app.baseUrl, tokenB, 'tools/call', { name: 'rateninja_list_my_sailings', arguments: {} });
        assert.equal(disabledHttp.status, 401);
        assert.equal(disabledHttp.body.error, 'invalid_token');
        assert.equal(disabledMcp.status, 401);
        assert.equal(disabledMcp.body.error.message, 'invalid_token');

        const loginC = await fetch(`${app.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'owner-c', password: PASSWORD })
        });
        const loginCBody = await loginC.json();
        const tokenC = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: cookieHeader(loginC),
            csrf: loginCBody.csrfToken,
            clientId: client.id,
            clientSecret: client.secret
        })).access_token;
        const beforeBump = await partnerGet(app.baseUrl, tokenC, '/api/partner/v1/me/rates');
        assert.equal(beforeBump.status, 200);
        app.db.prepare(`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = 'user-c'`).run();
        const epochHttp = await partnerGet(app.baseUrl, tokenC, '/api/partner/v1/me/predictive-pricing?after=2027-07-13');
        const epochMcp = await mcpCall(app.baseUrl, tokenC, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after: '2027-07-13' }
        });
        assert.equal(epochHttp.status, 401);
        assert.equal(epochHttp.body.error, 'invalid_token');
        assert.equal(epochMcp.status, 401);
        assert.equal(epochMcp.body.error.message, 'invalid_token');
    });

    await step('rejects the demo key, keeps the deployment gate, and refuses customer accounts', async () => {
        for (const path of ['/api/partner/v1/me/rates', '/api/partner/v1/me/sailings', '/api/partner/v1/me/predictive-pricing']) {
            const response = await fetch(`${app.baseUrl}${path}`, { headers: { 'x-api-key': 'demo-key' } });
            const body = await response.json();
            assert.equal(response.status, 401, path);
            assert.equal(body.error, 'invalid_token');
        }
        const mcp = await fetch(`${app.baseUrl}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'demo-key' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
        const mcpBody = await mcp.json();
        assert.equal(mcp.status, 401);
        assert.equal(mcpBody.error.message, 'invalid_token');

        const login = await fetch(`${app.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'customer-c', password: PASSWORD })
        });
        const customer = await login.json();
        const proof = helpers.pkce();
        const denied = await fetch(`${app.baseUrl}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: client.id,
            redirect_uri: REDIRECT_URI,
            scope: 'profile:read rates:read',
            state: proof.state,
            code_challenge: proof.challenge,
            code_challenge_method: 'S256'
        })}`, { headers: { cookie: cookieHeader(login) }, redirect: 'manual' });
        assert.equal(denied.status, 302);
        assert.match(denied.headers.get('location'), /only_contract_owner/);
        assert.equal(customer.user.isContractOwner, false);

        process.env.PARTNER_OAUTH_ENABLED = 'false';
        try {
            const blockedMcp = await mcpCall(app.baseUrl, tokenA, 'tools/list', {});
            assert.equal(blockedMcp.status, 403);
            assert.equal(blockedMcp.body.error.message, 'partner_oauth_disabled');
            const blockedRates = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/rates');
            assert.equal(blockedRates.status, 403);
            assert.equal(blockedRates.body.error, 'partner_oauth_disabled');
            const blockedPredictive = await partnerGet(app.baseUrl, tokenA, '/api/partner/v1/me/predictive-pricing?after=2027-07-13');
            assert.equal(blockedPredictive.status, 403);
            assert.equal(blockedPredictive.body.error, 'partner_oauth_disabled');
        } finally {
            process.env.PARTNER_OAUTH_ENABLED = 'true';
        }
    });

    await step('negotiates the protocol versions this server has exercised', async () => {
        const listed = await mcpCall(app.baseUrl, tokenA, 'tools/list', {});
        // tokenA was revoked in the previous test. Issue a replacement if needed.
        let token = tokenA;
        if (listed.status === 401) {
            const login = await fetch(`${app.baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'owner-a', password: PASSWORD })
            });
            const body = await login.json();
            token = (await authorizeAndToken({
                baseUrl: app.baseUrl,
                cookie: cookieHeader(login),
                csrf: body.csrfToken,
                clientId: client.id,
                clientSecret: client.secret
            })).access_token;
        }
        for (const version of ['2025-11-25', '2025-03-26']) {
            const response = await mcpCall(app.baseUrl, token, 'initialize', {
                protocolVersion: version,
                capabilities: {},
                clientInfo: { name: 'parity-test', version: '1' }
            });
            assert.equal(response.status, 200, response.text);
            assert.equal(response.body.result.protocolVersion, version);
        }
        const unknown = await mcpCall(app.baseUrl, token, 'initialize', { protocolVersion: '1999-01-01' });
        assert.equal(unknown.body.result.protocolVersion, '2025-11-25');
        const omitted = await mcpCall(app.baseUrl, token, 'initialize', {});
        assert.equal(omitted.body.result.protocolVersion, '2025-11-25');

        const tools = await mcpCall(app.baseUrl, token, 'tools/list', {});
        const predictive = tools.body.result.tools.find(tool => tool.name === 'rateninja_get_my_predictive_pricing');
        assert.match(predictive.description, /read-only/i);
        assert.match(predictive.description, /estimate/i);
        assert.deepEqual(predictive.inputSchema.required, ['after']);

        const header = await fetch(`${app.baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'mcp-protocol-version': '1999-01-01'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })
        });
        assert.equal(header.status, 400);
        const allowed = await fetch(`${app.baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'mcp-protocol-version': '2025-11-25'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })
        });
        assert.equal(allowed.status, 200);
    });

    await step('hides a deleted rate and sailing from partner and MCP list, detail, and predictive', async () => {
        const owner = app.company.id;
        app.db.prepare(`
            INSERT INTO rates (
                id, origin_port, destination_port, carrier, rate_20d, rate_40d, rate_40hc,
                rate_effective_date, rate_expiration_date, owner_company_id, contract_owner
            ) VALUES ('deleted-rate', 'SHA', 'LAX', 'MSC', 99999, 99999, 99999, '2026-01-01', '2028-06-01', ?, 'Owner A')
        `).run(owner);
        app.db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, vessel, owner_company_id)
            VALUES ('deleted-sailing', '2026-09-01T00:00:00.000Z', 'MSC', 'SHA', 'Gone', ?)
        `).run(owner);
        app.db.prepare(`UPDATE rates SET deleted_at = '2026-10-01T00:00:00.000Z', row_version = 2 WHERE id = 'deleted-rate'`).run();
        app.db.prepare(`UPDATE sailings SET deleted_at = '2026-10-01T00:00:00.000Z', row_version = 2 WHERE id = 'deleted-sailing'`).run();
        const login = await fetch(`${app.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'owner-a', password: PASSWORD })
        });
        const loggedIn = await login.json();
        const cookie = cookieHeader(login);
        const created = await fetch(`${app.baseUrl}/api/admin/oauth-clients`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': loggedIn.csrfToken },
            body: JSON.stringify({
                displayName: 'Deleted Row Partner',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        const token = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie,
            csrf: loggedIn.csrfToken,
            clientId: createdBody.client.id,
            clientSecret: createdBody.clientSecret
        })).access_token;
        const rates = await assertPair('/api/partner/v1/me/rates?carrier=MSC&originPort=SHA', 'rateninja_list_my_rates', {
            carrier: 'MSC', originPort: 'SHA'
        }, token);
        assert.equal(rates.data.some(rate => rate.id === 'deleted-rate' || rate.rate20D === 99999), false);
        const rate = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/rates/deleted-rate');
        assert.equal(rate.status, 404);
        const rateMcp = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_get_my_rate',
            arguments: { rateId: 'deleted-rate' }
        });
        assert.equal(rateMcp.body.result.structuredContent.error, 'not_found');
        const sailings = await assertPair(
            '/api/partner/v1/me/sailings?carrier=MSC&originPort=SHA&after=2026-06-01',
            'rateninja_list_my_sailings',
            { carrier: 'MSC', originPort: 'SHA', after: '2026-06-01' },
            token
        );
        assert.equal(sailings.data.some(sailing => sailing.id === 'deleted-sailing'), false);
        const sailing = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/sailings/deleted-sailing');
        assert.equal(sailing.status, 404);
        const sailingMcp = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_get_my_sailing',
            arguments: { sailingId: 'deleted-sailing' }
        });
        assert.equal(sailingMcp.body.result.structuredContent.error, 'not_found');
        const predictive = await assertPair(
            '/api/partner/v1/me/predictive-pricing?after=2027-07-13&carrier=MSC&originPort=SHA',
            'rateninja_get_my_predictive_pricing',
            { after: '2027-07-13', carrier: 'MSC', originPort: 'SHA' },
            token
        );
        assert.equal(predictive.data.some(rate => rate.id === 'deleted-rate' || rate.rate20D === 99999), false);
        assert.equal(predictive.data.some(rate => rate.id === 'pred-new'), true);
    });
    });
});
