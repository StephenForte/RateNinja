'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'r158-public-demo-key-value';
process.env.RATE_NINJA_ADMIN_API_KEY = 'r158-admin-key-32-characters-min';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const { startApp } = require('./helpers/app');
const { CODE, startCloudBbs } = require('./helpers/r1-37');
const {
    COMPANY_TYPE_CUSTOMER,
    insertCompany,
    insertUser,
    insertRate,
    insertMargin,
    activate,
    login,
    call
} = require('./helpers/r1-19');
const { authorizeAndToken, partnerGet, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const { agent: runnerAgent, fakeAdmin, fakeProviders, env: runnerEnv } = require('./helpers/r1-35');

const PUBLIC_KEY = process.env.RATE_NINJA_API_KEY;
const ADMIN_KEY = process.env.RATE_NINJA_ADMIN_API_KEY;
const ALL = 'profile:read rates:read sailings:read bookings:read bookings:write';
const EFFECTIVE = '2026-11-01';
const EXPIRATION = '2027-12-31';
const LANE = 'R158LANE';
const PRODUCTION_BODY_BYTES = 118415;
const PRODUCTION_RANGE_ROWS = 364;
const SIZE_CAP_STOP = 230000;

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

function slotView(row) {
    return {
        originPort: row.originPort,
        destinationPort: row.destinationPort,
        rateEffectiveDate: row.rateEffectiveDate,
        rateExpirationDate: row.rateExpirationDate,
        rateCount: row.rateCount,
        maxSlotsAllowedMin: row.maxSlotsAllowedMin,
        maxSlotsAllowedMax: row.maxSlotsAllowedMax
    };
}

describe('R1-58 max slots on the public API, reference rows, and managed agents', { concurrency: 1 }, () => {
    let app;
    let cloud;
    let ownerToken;
    let customer;

    before(async () => {
        cloud = await startCloudBbs();
        cloud.configureServer();
        app = await startApp({ companyName: 'R158 Owner', username: 'r158-owner' });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);

        insertCompany(app.db, { id: 'r158-buyer', name: 'R158 Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, { id: 'r158-buyer-user', username: 'r158-buyer', companyId: 'r158-buyer', role: 'company_admin' });
        activate('r158-buyer');
        insertMargin(app.db, { id: 'r158-margin', owner: app.company.id, customer: 'r158-buyer', percent: 0, number: 0 });
        customer = await login(app.baseUrl, 'r158-buyer');

        const owner = app.company.id;
        const lane = { owner, origin: LANE, destination: 'LAX', effective: EFFECTIVE, expiration: EXPIRATION, carrier: 'R158' };
        insertRate(app.db, { ...lane, id: 'r158-null', maxSlotsAllowed: null, rate20: 1000 });
        insertRate(app.db, { ...lane, id: 'r158-zero', maxSlotsAllowed: 0, rate20: 1100 });
        insertRate(app.db, { ...lane, id: 'r158-three', maxSlotsAllowed: 3, rate20: 1200 });
        insertRate(app.db, { ...lane, id: 'r158-five', maxSlotsAllowed: 5, rate20: 1300 });
        insertRate(app.db, { ...lane, id: 'r158-pricey', maxSlotsAllowed: 5, rate20: 9000 });
        insertRate(app.db, {
            id: 'r158-expired', owner, origin: LANE, destination: 'LAX', carrier: 'R158',
            effective: '2020-01-01', expiration: '2020-01-15', maxSlotsAllowed: null, rate20: 1000
        });
        for (const [id, maxSlotsAllowed] of [['r158-mix-2', 2], ['r158-mix-5', 5], ['r158-mix-null', null]]) {
            insertRate(app.db, {
                id, owner, origin: 'R158MIX', destination: 'LAX', carrier: 'R158',
                effective: EFFECTIVE, expiration: EXPIRATION, maxSlotsAllowed
            });
        }
        for (const id of ['r158-nil-a', 'r158-nil-b']) {
            insertRate(app.db, {
                id, owner, origin: 'R158NIL', destination: 'LAX', carrier: 'R158',
                effective: EFFECTIVE, expiration: null, maxSlotsAllowed: null
            });
        }
        for (const [id, maxSlotsAllowed] of [['r158-zm-0', 0], ['r158-zm-4', 4]]) {
            insertRate(app.db, {
                id, owner, origin: 'R158ZERO', destination: 'LAX', carrier: 'R158',
                effective: EFFECTIVE, expiration: EXPIRATION, maxSlotsAllowed
            });
        }
        app.db.prepare("UPDATE rates SET rate_type = 'FAK' WHERE id LIKE 'r158-%'").run();

        app.db.prepare(`
            INSERT INTO sailings (id, carrier, departure, departure_port, arrival_port, vessel, voyage, owner_company_id)
            VALUES ('r158-sailing', 'R158', '2027-01-15', ?, 'LAX', 'R158 Vessel', '158', ?)
        `).run(LANE, owner);

        const clientResponse = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'R158 Client',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ALL.split(' ')
            })
        });
        const clientBody = await clientResponse.json();
        assert.equal(clientResponse.status, 201, JSON.stringify(clientBody));
        ownerToken = await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: app.cookie,
            csrf: app.csrf,
            clientId: clientBody.client.id,
            clientSecret: clientBody.clientSecret,
            scope: ALL
        });
    });

    after(async () => {
        await app?.close();
        await cloud?.close();
    });

    async function publicGet(path) {
        const response = await fetch(`${app.baseUrl}${path}`, { headers: { 'x-api-key': PUBLIC_KEY } });
        const text = await response.text();
        return { status: response.status, text, body: text ? JSON.parse(text) : null };
    }

    async function adminGet(path) {
        const response = await fetch(`${app.baseUrl}${path}`, { headers: { 'x-admin-api-key': ADMIN_KEY } });
        const text = await response.text();
        return { status: response.status, text, body: text ? JSON.parse(text) : null };
    }

    async function rangesFor(origin) {
        const query = `originPort=${encodeURIComponent(origin)}&pageSize=100`;
        const partner = await partnerGet(app.baseUrl, ownerToken.access_token, `/api/partner/v1/me/rate-date-ranges?${query}`);
        const mcp = await mcpCall(app.baseUrl, ownerToken.access_token, 'tools/call', {
            name: 'rateninja_list_rate_date_ranges',
            arguments: { originPort: origin, pageSize: 100 }
        });
        const admin = await adminGet(`/api/admin/v1/reference/rate-date-ranges?${query}`);
        assert.equal(partner.status, 200, partner.text);
        assert.equal(mcp.body.result.isError, false, mcp.text);
        assert.equal(admin.status, 200, admin.text);
        assert.deepEqual(mcp.body.result.structuredContent, partner.body);
        return { partner: partner.body, admin: admin.body };
    }

    it('puts maxSlotsAllowed after rateExpirationDate on public rates only', async () => {
        const rates = await publicGet('/api/v1/rates?carrier=R158&pageSize=100');
        assert.equal(rates.status, 200, rates.text);
        const byId = Object.fromEntries(rates.body.data.map(row => [row.id, row]));
        assert.equal(byId['r158-three'].maxSlotsAllowed, 3);
        assert.equal(byId['r158-zero'].maxSlotsAllowed, 0);
        assert.equal(byId['r158-null'].maxSlotsAllowed, null);
        for (const id of ['r158-three', 'r158-zero', 'r158-null']) {
            const keys = Object.keys(byId[id]);
            assert.equal(keys[keys.indexOf('rateExpirationDate') + 1], 'maxSlotsAllowed');
        }

        const sailings = await publicGet(`/api/v1/sailings?carrier=R158&originPort=${encodeURIComponent(LANE)}&after=2027-01-01`);
        assert.equal(sailings.status, 200, sailings.text);
        assert.equal(sailings.body.data.some(row => row.vessel === 'R158 Vessel'), true);
        assert.equal(sailings.text.includes('maxSlotsAllowed'), false);

        const predictive = await publicGet(`/api/v1/predictive-pricing?carrier=R158&originPort=${encodeURIComponent(LANE)}&after=2027-06-15`);
        assert.equal(predictive.status, 200, predictive.text);
        assert.ok(predictive.body.data.length >= 1);
        assert.equal(predictive.text.includes('maxSlotsAllowed'), false);
    });

    it('adds min and max on rate-date rows without splitting groups', async () => {
        const mixed = await rangesFor('R158MIX');
        assert.equal(mixed.partner.data.length, 1);
        assert.equal(mixed.partner.data[0].rateCount, 3);
        assert.equal(mixed.partner.data[0].maxSlotsAllowedMin, 2);
        assert.equal(mixed.partner.data[0].maxSlotsAllowedMax, 5);
        const mixedKeys = Object.keys(mixed.partner.data[0]);
        assert.deepEqual(mixedKeys.slice(mixedKeys.indexOf('rateCount'), mixedKeys.indexOf('rateCount') + 3), [
            'rateCount', 'maxSlotsAllowedMin', 'maxSlotsAllowedMax'
        ]);

        const blanks = await rangesFor('R158NIL');
        assert.equal(blanks.partner.data.length, 1);
        assert.equal(blanks.partner.data[0].rateCount, 2);
        assert.equal(blanks.partner.data[0].maxSlotsAllowedMin, null);
        assert.equal(blanks.partner.data[0].maxSlotsAllowedMax, null);

        const zero = await rangesFor('R158ZERO');
        assert.equal(zero.partner.data.length, 1);
        assert.equal(zero.partner.data[0].rateCount, 2);
        assert.equal(zero.partner.data[0].maxSlotsAllowedMin, 0);
        assert.equal(zero.partner.data[0].maxSlotsAllowedMax, 4);

        for (const origin of ['R158MIX', 'R158NIL', 'R158ZERO']) {
            const { partner, admin } = origin === 'R158MIX' ? mixed : origin === 'R158NIL' ? blanks : zero;
            assert.deepEqual(admin.data.map(slotView), partner.data.map(slotView));
        }
    });

    it('keeps the CloudBBS reference schema and stays under the projected cap', async () => {
        const {
            REFERENCE_SCHEMA, BODY_SIZE_CAP, buildReferencePayload, buildAnnouncement, extractJsonBlock
        } = require('../lib/cloudbbs-post');
        const { listRateDateRangesAllOwners } = require('../lib/reference-ranges');
        const { distinctLanes } = require('../lib/client-agent');

        const sample = (await rangesFor('R158MIX')).partner.data;
        const reads = {
            rateDateRanges: sample,
            originPorts: [],
            destinationPorts: [],
            contractOwners: [],
            sailingDateRanges: [],
            predictiveDateRanges: []
        };
        const payload = buildReferencePayload({
            generatedAt: '2026-11-16T00:00:00.000Z',
            source: 'http://127.0.0.1/r158',
            bookingCode: 'SIZECHECK',
            reads
        });
        assert.equal(payload.schema, 'rateninja.reference.v1');
        assert.equal(payload.schema, REFERENCE_SCHEMA);
        assert.equal(payload.reads.rateDateRanges[0].maxSlotsAllowedMin, 2);
        const announcement = buildAnnouncement({
            generatedAt: '2026-11-16T00:00:00.000Z',
            source: 'http://127.0.0.1/r158',
            bookingCode: 'SIZECHECK',
            reads
        });
        const parsed = extractJsonBlock(announcement.body);
        const runnerAccepts = parsed?.schema === REFERENCE_SCHEMA && Array.isArray(parsed.reads?.rateDateRanges);
        assert.equal(runnerAccepts, true);
        assert.equal(distinctLanes(parsed.reads.rateDateRanges).length, 1);
        assert.ok(announcement.byteLength < BODY_SIZE_CAP);

        const owner = app.company.id;
        const insert = app.db.prepare(`
            INSERT INTO rates (
                id, carrier, origin_port, destination_port, contract_owner,
                rate_20d, rate_40d, rate_40hc, rate_effective_date, rate_expiration_date,
                owner_company_id, max_slots_allowed
            ) VALUES (?, 'R158', ?, 'LAX', 'Kings', 1000, 1800, 1900, ?, ?, ?, ?)
        `);
        const sizeIds = [];
        app.db.exec('BEGIN');
        try {
            for (let i = 0; i < 1000; i += 1) {
                const id = `r158-size-${i}`;
                sizeIds.push(id);
                insert.run(id, `R158SZ${String(i).padStart(4, '0')}`, EFFECTIVE, EXPIRATION, owner, i % 6);
            }
            app.db.exec('COMMIT');
        } catch (error) {
            app.db.exec('ROLLBACK');
            throw error;
        }
        try {
            const page = listRateDateRangesAllOwners({ page: 1, pageSize: 5000, carrier: '', originPort: '', destinationPort: '' });
            const rows = page.data.filter(row => String(row.originPort).startsWith('R158SZ'));
            assert.equal(rows.length, 1000);
            assert.equal(rows.every(row => row.rateCount === 1), true);
            const stripped = rows.map(row => {
                const copy = { ...row };
                delete copy.maxSlotsAllowedMin;
                delete copy.maxSlotsAllowedMax;
                return copy;
            });
            const nullRows = rows.map(row => ({ ...row, maxSlotsAllowedMin: null, maxSlotsAllowedMax: null }));
            const measure = rateRows => buildAnnouncement({
                generatedAt: '2026-11-16T00:00:00.000Z',
                source: 'http://127.0.0.1/r158-size',
                bookingCode: 'SIZECHECK',
                reads: {
                    rateDateRanges: rateRows,
                    originPorts: [],
                    destinationPorts: [],
                    contractOwners: [],
                    sailingDateRanges: [],
                    predictiveDateRanges: []
                }
            }).byteLength;
            const beforeBytes = measure(stripped);
            const afterBytes = measure(rows);
            const nullBytes = measure(nullRows);
            const perRow = (afterBytes - beforeBytes) / rows.length;
            const nullPerRow = (nullBytes - beforeBytes) / rows.length;
            const projected = PRODUCTION_BODY_BYTES + perRow * PRODUCTION_RANGE_ROWS;
            const projectedNull = PRODUCTION_BODY_BYTES + nullPerRow * PRODUCTION_RANGE_ROWS;
            console.log(JSON.stringify({
                beforeBytes, afterBytes, nullBytes, perRow, nullPerRow, projected, projectedNull, rows: rows.length
            }));
            assert.ok(afterBytes > beforeBytes);
            assert.ok(projected <= SIZE_CAP_STOP, `integer projection ${projected}`);
            assert.ok(projectedNull <= SIZE_CAP_STOP, `null projection ${projectedNull}`);
        } finally {
            app.db.prepare("DELETE FROM rates WHERE id LIKE 'r158-size-%'").run();
            assert.equal(sizeIds.length, 1000);
        }
    });

    it('marks a rate unbookable when the agent wants more slots than the rate allows', async () => {
        async function queue(bookingSlots) {
            const result = await call(app.baseUrl, customer, 'POST', '/api/managed-agents', [{
                rateType: 'FAK',
                originPort: LANE,
                destinationPort: 'LAX',
                sailingDate: todayUtc(),
                containerType: '20D',
                allowAlternativeRoutes: false,
                allowBookingRequest: true,
                priceMin: 0,
                priceMax: 5000,
                bookingSlots
            }]);
            assert.equal(result.status, 201, result.text);
            return result.json.agents[0];
        }

        const wide = await queue(5);
        const wideMatches = await adminGet(`/api/admin/v1/managed-agents/${wide.id}/matches`);
        assert.equal(wideMatches.status, 200, wideMatches.text);
        const found = Object.fromEntries(wideMatches.body.matches.map(row => [row.rateId, row]));
        assert.equal(found['r158-null'].maxSlotsAllowed, null);
        assert.equal(found['r158-null'].bookable, true);
        assert.equal(found['r158-zero'].maxSlotsAllowed, 0);
        assert.equal(found['r158-zero'].bookable, false);
        assert.equal(found['r158-three'].maxSlotsAllowed, 3);
        assert.equal(found['r158-three'].bookable, false);
        assert.equal(found['r158-five'].maxSlotsAllowed, 5);
        assert.equal(found['r158-five'].bookable, true);
        assert.equal(found['r158-pricey'].bookable, true);
        assert.equal(found['r158-pricey'].withinPriceRange, false);
        assert.equal(found['r158-five'].withinPriceRange, true);

        const tight = await queue(3);
        const tightMatches = await adminGet(`/api/admin/v1/managed-agents/${tight.id}/matches`);
        const tightFound = Object.fromEntries(tightMatches.body.matches.map(row => [row.rateId, row]));
        assert.equal(tightFound['r158-three'].bookable, true);
        assert.equal(tightFound['r158-five'].bookable, true);
        assert.equal(tightFound['r158-zero'].bookable, false);

        const expiredAgent = await queue(1);
        app.db.prepare('UPDATE managed_agents SET sailing_date = ? WHERE id = ?').run('2020-01-10', expiredAgent.id);
        const expiredMatches = await adminGet(`/api/admin/v1/managed-agents/${expiredAgent.id}/matches`);
        const expired = expiredMatches.body.matches.find(row => row.rateId === 'r158-expired');
        assert.equal(expired.maxSlotsAllowed, null);
        assert.equal(expired.bookable, false);

        const before = app.db.prepare('SELECT COUNT(*) AS count FROM booking_requests').get().count;
        const refused = await fetch(`${app.baseUrl}/api/admin/v1/managed-agents/${wide.id}/booking-requests`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-admin-api-key': ADMIN_KEY },
            body: JSON.stringify({ rateId: 'r158-three', bookingCode: CODE })
        });
        const refusedBody = await refused.json();
        assert.equal(refused.status, 400, JSON.stringify(refusedBody));
        assert.equal(refusedBody.error, 'invalid_request');
        assert.equal(refusedBody.error_description, 'This rate allows at most 3 slots per request.');
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM booking_requests').get().count, before);

        const { runManagedAgents } = require('../lib/managed-agent-runner');
        const admin = fakeAdmin([runnerAgent('r158-runner')], call => {
            if (call.step === 'matches') {
                return Response.json({
                    destinationPort: call.destination,
                    matches: [found['r158-three']],
                    sailings: [{ departure: '2027-01-15' }]
                });
            }
        });
        const provider = fakeProviders({
            judge: () => ({ rateId: 'r158-three', summary: 'Picked the three-slot rate.' })
        });
        let claudeBody = '';
        const result = await runManagedAgents({
            confirmed: true,
            env: runnerEnv,
            clock: () => Date.parse('2026-11-21T18:00:00Z'),
            sleep: async () => {},
            stdout: { write() {} },
            stderr: { write() {} },
            fetchImpl: async (url, options) => {
                const target = new URL(url);
                const body = options.body && JSON.parse(options.body);
                if (target.host === 'rateninja.invalid') return admin.reply(target, options.method, body, Date.now());
                if (target.host === 'claude.invalid') claudeBody += options.body;
                return provider.reply(target, options.method, body);
            }
        });
        assert.equal(result, 0);
        assert.match(claudeBody, /bookable already accounts for this agent's slot count/);
        assert.equal(admin.calls.some(call => call.step === 'booking-requests'), false);
        assert.match(admin.states.get('r158-runner').resultSummary, /not bookable/);
    });
});
