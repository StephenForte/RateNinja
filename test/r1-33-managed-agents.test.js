'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { describe, before, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { activate, login, call, utcDay } = require('./helpers/r1-19');
const { seedManagedAgents, search, BUYER, OTHER_BUYER, OTHER_RATE_TYPE, RATE_TYPE } = require('./helpers/r1-33');

const endpoint = '/api/managed-agents';
const booking = { allowBookingRequest: true, priceMin: 0, priceMax: 1350.75 };
let app;
let users;
let sessions;

function api(who, method, suffix = '', body, options) {
    return call(app.baseUrl, sessions[who], method, endpoint + suffix, body, options);
}

function count() {
    return app.db.prepare('SELECT COUNT(*) AS n FROM managed_agents').get().n;
}

function stored(id) {
    return app.db.prepare('SELECT * FROM managed_agents WHERE id = ?').get(id);
}

async function queue(who, ...rows) {
    const result = await api(who, 'POST', '', rows);
    assert.equal(result.status, 201, result.text);
    return result.json.agents;
}

async function rejectRow(who, method, suffix, body, row, message) {
    const size = count();
    const result = await api(who, method, suffix, body);
    assert.equal(result.status, 400, result.text);
    assert.match(result.json.error, new RegExp(`^Row ${row}: .*${message}`, 'i'));
    assert.equal(count(), size);
}

function rawGet(rawPath) {
    return new Promise((resolve, reject) => {
        const url = new URL(app.baseUrl);
        const req = http.get({ hostname: url.hostname, port: url.port, path: rawPath }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, text }));
            response.on('error', reject);
        });
        req.on('error', reject);
    });
}

describe('R1-33 managed agents', () => {
    before(async () => {
        app = await startApp();
        users = seedManagedAgents(app.db);
        sessions = {};
        for (const [role, username] of Object.entries(users)) {
            activate(username);
            sessions[role] = await login(app.baseUrl, username);
        }
    });

    after(async () => { await app?.close(); });

    it('serves the app shell on exact /agents routes with the existing slash and path guards', async () => {
        const shell = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
        for (const rawPath of ['/agents', '/agents/']) {
            assert.deepEqual(await rawGet(rawPath), { status: 200, text: shell });
        }
        for (const [rawPath, status] of [['/agents/x', 404], ['/agents%2F', 403], ['/agents/..', 403]]) {
            const response = await rawGet(rawPath);
            assert.equal(response.status, status, rawPath);
        }
        const { resolveRoute, isClientRoute } = await import('../public/js/router.js');
        const signedIn = { signedIn: true };
        for (const route of ['/agents', '/agents/']) {
            assert.equal(isClientRoute(route), true);
            const decision = resolveRoute(route, signedIn);
            assert.equal(decision.kind, 'section');
            assert.equal(decision.section.id, 'managed-agents');
            assert.equal(resolveRoute(route, { signedIn: false }).kind, 'access-denied');
        }
        for (const route of ['/agents/x', '/agents%2F', '/agents/..']) {
            assert.equal(isClientRoute(route), false);
            assert.equal(resolveRoute(route, signedIn).kind, 'not-found');
        }
    });

    it('limits options and create/edit validation to the acting user’s visible rates', async () => {
        const result = await api('creator', 'GET', '/options');
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.rateTypes, [RATE_TYPE, OTHER_RATE_TYPE]);
        assert.deepEqual(result.json.containerTypes, ['20D', '40D', '40HC']);
        assert.equal(result.json.maxSearches, 25);
        assert.equal(result.json.canRequestBooking, true);
        const { lanes } = result.json;
        assert.equal(lanes.length, 2);
        assert.deepEqual(lanes.find(lane => lane.destinationPort === 'LAX').windows, [
            { start: utcDay(-7), end: utcDay(-1) },
            { start: utcDay(2), end: utcDay(30) },
            { start: utcDay(33), end: utcDay(40) }
        ]);
        const [agent] = await queue('creator', search());
        const prior = stored(agent.id);
        for (const value of [
            search({ rateType: 'Private rate type', originPort: 'SIN', destinationPort: 'NYC' }),
            search({ sailingDate: utcDay(31) }),
            search({ rateType: OTHER_RATE_TYPE })
        ]) {
            await rejectRow('creator', 'POST', '', [value], 1, 'visible lane|rate window');
            await rejectRow('creator', 'PUT', `/${agent.id}`, value, 1, 'visible lane|rate window');
            assert.deepEqual(stored(agent.id), prior);
        }
    });

    it('accepts both inclusive boundaries and rejects gaps, out-of-window, past, and invalid dates', async () => {
        for (const offset of [2, 30, 33, 40]) {
            await queue('creator', search({ sailingDate: utcDay(offset) }));
        }
        for (const offset of [1, 31, 41, -1]) {
            await rejectRow('creator', 'POST', '', [search({ sailingDate: utcDay(offset) })], 1, 'date');
        }
        for (const date of ['2027-02-29', '2027-2-01', '2027-02-01T00:00:00Z']) {
            await rejectRow('creator', 'POST', '', [search({ sailingDate: date })], 1, 'date');
        }
    });

    it('enforces batch limits, normalized duplicates, and all-or-nothing row validation', async () => {
        const rows = Array.from({ length: 26 }, (_, index) => search({ sailingDate: utcDay(index + 2) }));
        const size = count();
        for (const batch of [[], rows, { agents: rows.slice(0, 1) }]) {
            const result = await api('creator', 'POST', '', batch);
            assert.equal(result.status, 400, result.text);
            assert.match(result.json.error, /1 to 25/);
        }
        assert.equal(count(), size);
        await rejectRow('creator', 'POST', '', [search(), search({ priceMin: 9 })], 2, 'duplicate');
        await rejectRow('creator', 'POST', '', [search(), search({ containerType: '45HC' })], 2, 'container');
        await rejectRow('creator', 'POST', '', [search({ allowAlternativeRoutes: 'false' })], 1, 'true or false');
        const accepted = await queue('creator', ...rows.slice(0, 25));
        assert.equal(accepted.length, 25);
        assert.equal(count(), size + 25);
        assert.equal(new Set(accepted.map(agent => agent.batchId)).size, 1);
        assert.ok(accepted.every(agent => agent.batchId && agent.companyId === BUYER && agent.status === 'queued'));
    });

    it('stores each agent’s settings and validates price ranges and booking permission', async () => {
        const [on, off] = await queue('creator', search({ ...booking, containerType: '20D' }),
            search({ containerType: '40D', allowAlternativeRoutes: false, priceMin: -3, priceMax: 7 }));
        assert.equal(on.batchId, off.batchId);
        assert.equal(on.creatorName, 'Synthetic Creator');
        assert.equal(on.createdByUserId, users.creator);
        assert.equal(on.allowBookingRequest, true);
        assert.equal(on.containerType, '20D');
        assert.equal(stored(on.id).price_min, 0);
        assert.equal(stored(on.id).price_max, 1350.75);
        assert.equal(off.containerType, '40D');
        assert.equal(off.allowAlternativeRoutes, false);
        assert.equal(stored(off.id).price_min, null);
        assert.equal(stored(off.id).price_max, null);
        for (const prices of [{ priceMin: undefined }, { priceMax: null }, { priceMin: -1 }, { priceMin: 1500 }, { priceMax: '1350' }]) {
            await rejectRow('creator', 'POST', '', [search({ ...booking, ...prices })], 1, 'price');
        }
        const ownerOptions = await api('owner', 'GET', '/options');
        assert.equal(ownerOptions.json.canRequestBooking, false);
        await rejectRow('owner', 'POST', '', [search(booking)], 1, 'cannot request bookings');
    });

    it('exposes only the user’s saved queries and stores a stable reference', async () => {
        const { createQuery, deleteQuery } = require('../lib/preferences');
        const criteria = { originPort: 'SHA', destinationPort: 'LAX', carrier: 'Synthetic carrier' };
        const own = createQuery(users.creator, { name: 'Own route', criteria });
        const theirs = createQuery(users.member, { name: 'Member route', criteria });
        const options = await api('creator', 'GET', '/options');
        assert.deepEqual(options.json.savedQueries, [{ id: own.id, name: 'Own route', originPort: 'SHA', destinationPort: 'LAX' }]);
        await rejectRow('creator', 'POST', '', [search({ savedQueryId: theirs.id })], 1, 'your account');
        await rejectRow('creator', 'POST', '', [search({ savedQueryId: own.id }), search()], 2, 'duplicate');
        const [agent] = await queue('creator', search({ savedQueryId: own.id }));
        await rejectRow('creator', 'PUT', `/${agent.id}`, search({ savedQueryId: theirs.id }), 1, 'your account');
        deleteQuery(users.creator, own.id);
        assert.equal(stored(agent.id).saved_query_id, own.id);
        assert.equal(stored(agent.id).destination_port, 'LAX');
    });

    it('validates admin edits against the agent company and preserves its booking and saved-query reference', async () => {
        const { createQuery, deleteQuery } = require('../lib/preferences');
        const query = createQuery(users.creator, { name: 'Customer lane', criteria: { originPort: 'SHA', destinationPort: 'LAX' } });
        const settings = search({ ...booking, savedQueryId: query.id });
        const [agent] = await queue('creator', settings);
        deleteQuery(users.creator, query.id);
        const suffix = `/${agent.id}`;

        const homeOptions = await api('nonCustomerAdmin', 'GET', '/options');
        assert.equal(homeOptions.json.canRequestBooking, false);
        assert.ok(homeOptions.json.lanes.some(lane => lane.originPort === 'SIN' && lane.destinationPort === 'NYC'));
        const editOptions = await api('nonCustomerAdmin', 'GET', `/options?agentId=${agent.id}`);
        const customerOptions = await api('creator', 'GET', '/options');
        assert.equal(editOptions.status, 200, editOptions.text);
        assert.equal(editOptions.json.canRequestBooking, true);
        assert.deepEqual(editOptions.json.lanes, customerOptions.json.lanes);
        assert.deepEqual(editOptions.json.rateTypes, customerOptions.json.rateTypes);
        assert.deepEqual(editOptions.json.savedQueries, []);

        const before = stored(agent.id);
        await rejectRow('nonCustomerAdmin', 'PUT', suffix, {
            ...settings, rateType: 'Private rate type', originPort: 'SIN', destinationPort: 'NYC'
        }, 1, 'visible lane');
        await rejectRow('nonCustomerAdmin', 'PUT', suffix, { ...settings, sailingDate: utcDay(31) }, 1, 'rate window');
        assert.deepEqual(stored(agent.id), before);

        const result = await api('nonCustomerAdmin', 'PUT', suffix, { ...settings, containerType: '40D' });
        assert.equal(result.status, 200, result.text);
        const updated = result.json.agent;
        assert.deepEqual(
            [updated.allowBookingRequest, updated.priceMin, updated.priceMax, updated.savedQueryId],
            [true, booking.priceMin, booking.priceMax, query.id]
        );
        assert.equal(updated.containerType, '40D');
        assert.equal(updated.companyId, BUYER);
    });

    it('limits edit options to callers allowed to edit a queued agent', async () => {
        const [agent] = await queue('creator', search());
        const options = `/options?agentId=${agent.id}`;
        for (const [who, status] of [['member', 403], ['otherBuyer', 404], ['companyless', 403], [null, 401]]) {
            const result = await api(who, 'GET', options);
            assert.equal(result.status, status, result.text);
            assert.equal(result.json.lanes, undefined);
            assert.equal(result.json.savedQueries, undefined);
        }
        assert.equal((await api('companyAdmin', 'GET', options)).status, 200);
        app.db.prepare("UPDATE managed_agents SET status = 'running' WHERE id = ?").run(agent.id);
        assert.equal((await api('creator', 'GET', options)).status, 409);
        assert.equal((await api('nonCustomerAdmin', 'GET', options)).status, 409);
    });

    it('lists by home company and gives system admins the cross-company view regardless of selected context', async () => {
        const [foreign] = await queue('otherBuyer', search());
        const [memberAgent] = await queue('member', search());
        const [own] = await queue('creator', search(booking));
        const identity = app.db.prepare('SELECT company_id, company_record_id FROM users WHERE id = ?');
        assert.deepEqual({ ...identity.get(users.creator) }, { company_id: '3.0', company_record_id: BUYER });
        assert.deepEqual({ ...identity.get(users.member) }, { company_id: '3', company_record_id: BUYER });
        assert.equal(stored(own.id).company_id, BUYER);
        assert.equal(stored(memberAgent.id).company_id, BUYER);
        const member = await api('member', 'GET');
        assert.equal(member.json.agents[0].id, own.id);
        assert.equal(member.json.agents[0].canEdit, false);
        assert.equal(member.json.agents[0].canDelete, false);
        assert.ok(member.json.agents.every(agent => agent.companyId === BUYER && !('companyName' in agent)));
        assert.ok((await api('creator', 'GET')).json.agents.some(agent => agent.id === memberAgent.id));
        const other = await api('otherBuyer', 'GET');
        assert.deepEqual(other.json.agents.map(agent => agent.id), [foreign.id]);
        const context = await call(app.baseUrl, sessions.systemAdmin, 'POST', '/api/admin/context', { companyId: OTHER_BUYER });
        assert.equal(context.status, 200, context.text);
        const [adminCreated] = await queue('systemAdmin', search());
        assert.equal(stored(adminCreated.id).company_id, BUYER);
        const system = await api('systemAdmin', 'GET');
        assert.equal(system.json.agents.find(agent => agent.id === foreign.id).companyName, 'Synthetic Other Buyer');
        assert.equal(system.json.agents.find(agent => agent.id === own.id).companyName, 'Synthetic Buyer');
        assert.equal(system.json.agents.find(agent => agent.id === foreign.id).canEdit, true);
    });

    it('checks edit and delete permissions, records audits and preserves immutable queue metadata', async () => {
        const [agent] = await queue('creator', search());
        const suffix = `/${agent.id}`;
        const initial = stored(agent.id);
        const changed = search({ containerType: '20D' });
        for (const [who, status] of [['member', 403], ['otherBuyer', 404], ['companyless', 403]]) {
            assert.equal((await api(who, 'PUT', suffix, changed)).status, status);
            assert.equal((await api(who, 'DELETE', suffix)).status, status);
        }
        assert.deepEqual(stored(agent.id), initial);
        const expectedAudits = [['managed_agent_created', users.creator]];
        for (const who of ['creator', 'companyAdmin', 'systemAdmin']) {
            const result = await api(who, 'PUT', suffix, changed);
            assert.equal(result.status, 200, result.text);
            assert.equal(result.json.agent.containerType, '20D');
            const updated = stored(agent.id);
            for (const field of ['batch_id', 'company_id', 'created_by_user_id', 'created_at', 'status', 'started_at', 'finished_at', 'result_summary']) {
                assert.equal(updated[field], initial[field], field);
            }
            expectedAudits.push(['managed_agent_updated', users[who]]);
        }
        assert.equal((await api('companyAdmin', 'DELETE', suffix)).status, 204);
        expectedAudits.push(['managed_agent_deleted', users.companyAdmin]);
        assert.equal(stored(agent.id), undefined);
        const events = app.db.prepare(`
            SELECT event_type, actor_user_id, detail FROM audit_events
            WHERE json_extract(detail, '$.agentId') = ? ORDER BY rowid
        `).all(agent.id);
        assert.deepEqual(events.map(event => [event.event_type, event.actor_user_id]), expectedAudits);
        assert.ok(events.every(event => JSON.parse(event.detail).companyId === BUYER));

        const [creatorDelete] = await queue('creator', search());
        assert.equal((await api('creator', 'DELETE', `/${creatorDelete.id}`)).status, 204);
        const [adminDelete] = await queue('otherBuyer', search());
        const updated = await api('systemAdmin', 'PUT', `/${adminDelete.id}`, changed);
        assert.equal(updated.status, 200, updated.text);
        assert.equal(updated.json.agent.companyId, OTHER_BUYER);
        assert.equal((await api('systemAdmin', 'DELETE', `/${adminDelete.id}`)).status, 204);
    });

    it('returns 409 for a running agent and leaves the row intact', async () => {
        const [agent] = await queue('creator', search());
        app.db.prepare("UPDATE managed_agents SET status = 'running' WHERE id = ?").run(agent.id);
        const original = stored(agent.id);
        for (const who of ['creator', 'companyAdmin', 'systemAdmin']) {
            assert.equal((await api(who, 'PUT', `/${agent.id}`, search())).status, 409);
            assert.equal((await api(who, 'DELETE', `/${agent.id}`)).status, 409);
        }
        assert.deepEqual(stored(agent.id), original);
        const list = await api('creator', 'GET');
        const running = list.json.agents.find(item => item.id === agent.id);
        assert.deepEqual([running.status, running.canEdit, running.canDelete], ['running', false, false]);
    });

    it('requires a session and CSRF and gives companyless accounts an empty list and clear 403', async () => {
        const [agent] = await queue('creator', search());
        const suffix = `/${agent.id}`;
        const before = stored(agent.id);
        for (const [method, path, body] of [
            ['POST', '', [search()]], ['PUT', suffix, search()], ['DELETE', suffix]
        ]) {
            assert.equal((await api(null, method, path, body)).status, 401);
            assert.equal((await api('creator', method, path, body, { csrf: false })).status, 403);
            const companyless = await api('companyless', method, path, body);
            assert.equal(companyless.status, 403);
            assert.match(companyless.json.error, /belong to a company/);
        }
        assert.equal((await api(null, 'GET')).status, 401);
        assert.equal((await api(null, 'GET', '/options')).status, 401);
        assert.deepEqual((await api('companyless', 'GET')).json.agents, []);
        assert.deepEqual(stored(agent.id), before);
    });
});
