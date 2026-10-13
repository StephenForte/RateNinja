'use strict';

process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || 'test-oauth-signing-secret-value-long';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, partnerGet, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const { ymd } = require('./helpers/r1-08');

function idsOf(list) {
    return (list || []).map(row => row.id);
}

describe('r1-08 deleted rows stay off every data route', { concurrency: 1 }, () => {
    let app;

    before(async () => {
        app = await startApp({ companyName: 'Owner A', username: 'owner-a' });
    });

    after(async () => {
        if (app) await app.close();
    });

    it('hides one deleted rate and one deleted sailing from app, demo, partner, MCP, and pull-forward', async () => {
        const owner = app.company.id;
        const db = app.db;
        const sourceStart = ymd(-200);
        const sourceEnd = ymd(-190);
        const targetStart = ymd(20);
        const targetEnd = ymd(30);
        const inSource = ymd(-195);
        const after = ymd(120);
        db.prepare(`
            INSERT INTO rates (
                id, origin_port, destination_port, carrier, rate_20d, rate_40d, rate_40hc,
                rate_effective_date, rate_expiration_date, notes_1, rate_view, owner_company_id
            ) VALUES
                ('live-rate', 'QQQ', 'LAX', 'PATH', 100, 200, 300, ?, '2026-12-01', 'DO-COPY', 'view-9', ?),
                ('deleted-rate', 'QQQ', 'LAX', 'PATH', 99999, 99999, 99999, ?, '2099-01-01', 'DO-NOT-COPY', 'view-9', ?)
        `).run(inSource, owner, inSource, owner);
        db.prepare(`
            INSERT INTO sailings (id, departure, arrival, carrier, departure_port, vessel, owner_company_id)
            VALUES
                ('live-sailing', ?, ?, 'PATH', 'QQQ', 'Kept', ?),
                ('deleted-sailing', ?, ?, 'PATH', 'QQQ', 'Gone', ?)
        `).run(`${inSource}T08:00:00.000Z`, `${ymd(-190)}T08:00:00.000Z`, owner, `${inSource}T09:00:00.000Z`, `${ymd(-190)}T09:00:00.000Z`, owner);
        db.prepare(`
            UPDATE rates SET deleted_at = ?, deleted_operation_id = 'gone', row_version = row_version + 1 WHERE id = 'deleted-rate'
        `).run(new Date().toISOString());
        db.prepare(`
            UPDATE sailings SET deleted_at = ?, deleted_operation_id = 'gone', row_version = row_version + 1 WHERE id = 'deleted-sailing'
        `).run(new Date().toISOString());

        const store = require('../lib/store');
        assert.equal(store.getAllRates().some(row => row.id === 'deleted-rate'), false);
        assert.equal(store.getRatesForView('view-9').some(row => row.id === 'deleted-rate'), false);
        assert.equal(store.getRatesForView('view-9').some(row => row.id === 'live-rate'), true);
        assert.equal(store.getRatesByCarrierOrigin('PATH', 'QQQ').some(row => row.id === 'deleted-rate'), false);
        assert.equal(store.getRatesByOwner(owner).some(row => row.id === 'deleted-rate'), false);
        assert.equal(store.getSailings({ carrier: 'PATH', originPort: 'QQQ', after: '2000-01-01' }).some(row => row.id === 'deleted-sailing'), false);

        const session = { cookie: app.cookie, csrf: app.csrf };
        async function get(path, extraHeaders) {
            const headers = { cookie: session.cookie, ...(extraHeaders || {}) };
            const response = await fetch(`${app.baseUrl}${path}`, { headers });
            const body = await response.json();
            assert.equal(response.status, 200, `${path} ${JSON.stringify(body)}`);
            return body;
        }

        const appRates = await get('/api/rates');
        assert.equal(idsOf(appRates.rates).includes('deleted-rate'), false);
        assert.equal(idsOf(appRates.rates).includes('live-rate'), true);
        const appPredictive = await get(`/api/rates/predictive?after=${after}`);
        assert.equal(idsOf(appPredictive.rates).includes('deleted-rate'), false);
        assert.equal(idsOf(appPredictive.rates).includes('live-rate'), true);
        assert.equal(appPredictive.rates.some(row => row.rate20D === 99999), false);
        const appSailings = await get(`/api/sailings?carrier=PATH&originPort=QQQ&after=2000-01-01`);
        assert.equal(idsOf(appSailings.sailings).includes('deleted-sailing'), false);
        assert.equal(idsOf(appSailings.sailings).includes('live-sailing'), true);

        const demoHeaders = { 'x-api-key': 'demo-key' };
        const demoRates = await get('/api/v1/rates?carrier=PATH&originPort=QQQ', demoHeaders);
        assert.equal(idsOf(demoRates.data).includes('deleted-rate'), false);
        assert.equal(idsOf(demoRates.data).includes('live-rate'), true);
        const demoSailings = await get('/api/v1/sailings?carrier=PATH&originPort=QQQ&after=2000-01-01', demoHeaders);
        assert.equal(idsOf(demoSailings.data).includes('deleted-sailing'), false);
        assert.equal(idsOf(demoSailings.data).includes('live-sailing'), true);
        const demoPredictive = await get(`/api/v1/predictive-pricing?carrier=PATH&originPort=QQQ&after=${after}`, demoHeaders);
        assert.equal(demoPredictive.data.length, 1);
        assert.ok(demoPredictive.data[0].rate20D < 1000, JSON.stringify(demoPredictive.data));

        db.prepare(`UPDATE users SET is_system_admin = 1 WHERE username = 'owner-a'`).run();
        const context = await fetch(`${app.baseUrl}/api/admin/context`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
            body: JSON.stringify({ companyId: owner })
        });
        assert.equal(context.status, 200, await context.text());
        const created = await fetch(`${app.baseUrl}/api/admin/oauth-clients`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
            body: JSON.stringify({
                displayName: 'Deleted Path Partner',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        const token = (await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: session.cookie,
            csrf: session.csrf,
            clientId: createdBody.client.id,
            clientSecret: createdBody.clientSecret
        })).access_token;

        const partnerRates = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/rates?carrier=PATH&originPort=QQQ');
        assert.equal(partnerRates.status, 200, partnerRates.text);
        assert.equal(idsOf(partnerRates.body.data).includes('deleted-rate'), false);
        assert.equal(idsOf(partnerRates.body.data).includes('live-rate'), true);
        const partnerRate = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/rates/deleted-rate');
        assert.equal(partnerRate.status, 404, partnerRate.text);
        const partnerSailings = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/sailings?carrier=PATH&originPort=QQQ&after=2000-01-01');
        assert.equal(idsOf(partnerSailings.body.data).includes('deleted-sailing'), false);
        assert.equal(idsOf(partnerSailings.body.data).includes('live-sailing'), true);
        const partnerSailing = await partnerGet(app.baseUrl, token, '/api/partner/v1/me/sailings/deleted-sailing');
        assert.equal(partnerSailing.status, 404, partnerSailing.text);
        const partnerPredictive = await partnerGet(app.baseUrl, token, `/api/partner/v1/me/predictive-pricing?after=${after}&carrier=PATH&originPort=QQQ`);
        assert.equal(idsOf(partnerPredictive.body.data).includes('deleted-rate'), false);
        assert.equal(partnerPredictive.body.data.some(row => row.rate20D === 99999), false);

        const mcpRates = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_list_my_rates',
            arguments: { carrier: 'PATH', originPort: 'QQQ' }
        });
        assert.equal(idsOf(mcpRates.body.result.structuredContent.data).includes('deleted-rate'), false);
        const mcpRate = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_get_my_rate',
            arguments: { rateId: 'deleted-rate' }
        });
        assert.equal(mcpRate.body.result.isError, true);
        assert.equal(mcpRate.body.result.structuredContent.error, 'not_found');
        const mcpSailings = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_list_my_sailings',
            arguments: { carrier: 'PATH', originPort: 'QQQ', after: '2000-01-01' }
        });
        assert.equal(idsOf(mcpSailings.body.result.structuredContent.data).includes('deleted-sailing'), false);
        const mcpSailing = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_get_my_sailing',
            arguments: { sailingId: 'deleted-sailing' }
        });
        assert.equal(mcpSailing.body.result.structuredContent.error, 'not_found');
        const mcpPredictive = await mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_get_my_predictive_pricing',
            arguments: { after, carrier: 'PATH', originPort: 'QQQ' }
        });
        assert.equal(idsOf(mcpPredictive.body.result.structuredContent.data).includes('deleted-rate'), false);
        assert.equal(mcpPredictive.body.result.structuredContent.data.some(row => row.rate20D === 99999), false);

        const forwardRates = await fetch(`${app.baseUrl}/api/admin/pull-forward/rates`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
            body: JSON.stringify({
                sourceStart, sourceEnd, targetStart, targetEnd,
                priceIncreasePercent: 0,
                deleteExisting: false,
                companyId: owner
            })
        });
        const forwardRatesBody = await forwardRates.json();
        assert.equal(forwardRates.status, 200, JSON.stringify(forwardRatesBody));
        assert.equal(forwardRatesBody.copied, 1);
        const notes = db.prepare(`SELECT notes_1, deleted_at FROM rates WHERE notes_1 IN ('DO-COPY', 'DO-NOT-COPY')`).all();
        assert.equal(notes.filter(row => row.notes_1 === 'DO-NOT-COPY').length, 1);
        assert.equal(notes.filter(row => row.notes_1 === 'DO-COPY').length, 2);
        assert.equal(notes.find(row => row.notes_1 === 'DO-NOT-COPY').deleted_at == null, false);

        const forwardSailings = await fetch(`${app.baseUrl}/api/admin/pull-forward/sailings`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf },
            body: JSON.stringify({
                sourceStart, sourceEnd, targetStart, targetEnd,
                deleteExisting: false,
                companyId: owner
            })
        });
        const forwardSailingsBody = await forwardSailings.json();
        assert.equal(forwardSailings.status, 200, JSON.stringify(forwardSailingsBody));
        assert.equal(forwardSailingsBody.copied, 1);
        const vessels = db.prepare(`SELECT vessel, deleted_at FROM sailings WHERE vessel IN ('Kept', 'Gone')`).all();
        assert.equal(vessels.filter(row => row.vessel === 'Gone').length, 1);
        assert.equal(vessels.filter(row => row.vessel === 'Kept').length, 2);
    });
});
