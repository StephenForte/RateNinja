'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    sessionToken,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    userRow
} = require('./helpers/r1-02');

const PASSWORD = 'sail-the-ocean';
const NEXT_PASSWORD = 'harbor-lantern-9';
const sourceDay = utcDay(-30);
const targetDay = utcDay(20);

function forwardBody(kind, companyId) {
    const body = {
        sourceStart: sourceDay,
        sourceEnd: sourceDay,
        targetStart: targetDay,
        targetEnd: targetDay,
        deleteExisting: false
    };
    if (kind === 'rates') body.priceIncreasePercent = 0;
    if (companyId !== undefined) body.companyId = companyId;
    return body;
}

function assertSessionShape(user, expected) {
    assert.deepEqual(Object.keys(user).sort(), [
        'companyContext',
        'companyName',
        'companyType',
        'isAdmin',
        'isContractOwner',
        'loginName',
        'mustChangePassword',
        'permissions',
        'username'
    ]);
    assert.equal(user.mustChangePassword, false);
    assert.deepEqual(user.permissions, expected.permissions);
    assert.equal(user.isAdmin, expected.permissions.companyAdmin);
    assert.equal(user.isContractOwner, expected.permissions.contractOwner);
    assert.equal(user.loginName, expected.loginName);
    assert.equal(user.username, expected.displayName);
    assert.equal(user.companyName, expected.companyName);
    assert.equal(user.companyType, expected.companyType);
    assert.deepEqual(user.companyContext, expected.companyContext);
}

describe('r1-02 roles and company isolation', { concurrency: 1 }, () => {
    let app;
    let actor;
    let setPasswordByUsername;
    let setSessionCompanyContext;

    before(async () => {
        app = await startApp({ role: 'member', username: 'r102-unused', companyName: 'Unused Co' });
        ({ setPasswordByUsername } = require('../lib/accounts'));
        ({ setSessionCompanyContext } = require('../lib/session'));
        const { db } = app;
        insertCompany(db, { id: 'owner-a', name: 'Owner A', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'owner-b', name: 'Owner B', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'customer-c', name: 'Customer C', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'customer-d', name: 'Customer D', type: COMPANY_TYPE_CUSTOMER });
        const people = [
            ['member', 'customer-c', 'member', false, 'Member Person'],
            ['customer-admin', 'customer-c', 'company_admin', false, 'Customer Admin'],
            ['owner-admin', 'owner-a', 'company_admin', false, 'Owner Admin'],
            ['peer-admin', 'owner-a', 'company_admin', false, 'Peer Admin'],
            ['system-admin', 'owner-a', 'company_admin', true, 'System Admin'],
            ['owner-b-user', 'owner-b', 'member', false, 'Owner B User'],
            ['editable', 'customer-c', 'member', false, 'Editable Person'],
            ['departing', 'customer-c', 'member', false, 'Departing Person']
        ];
        for (const [id, companyId, role, systemAdmin, displayName] of people) {
            insertUser(db, { id, username: id, companyId, role, systemAdmin, displayName });
            assert.equal(setPasswordByUsername(id, PASSWORD).ok, true);
        }
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
            VALUES ('rate-a', 'MSC', 'SHA', 'LAX', 1000, ?, 'owner-a')
        `).run(sourceDay);
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
            VALUES ('rate-b', 'MSC', 'SHA', 'LAX', 2000, ?, 'owner-b')
        `).run(sourceDay);
        db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
            VALUES ('sailing-b', ?, 'MSC', 'SHA', 'owner-b')
        `).run(`${sourceDay}T00:00:00.000Z`);
        db.prepare(`
            INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
            VALUES ('margin-c', 'owner-a', 'customer-c', 0.1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run();
        db.prepare(`
            INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
            VALUES ('margin-d-a', 'owner-a', 'customer-d', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run();
        db.prepare(`
            INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
            VALUES ('margin-d-b', 'owner-b', 'customer-d', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `).run();
        actor = {};
        for (const id of ['member', 'customer-admin', 'owner-admin', 'system-admin', 'departing']) {
            actor[id] = await login(app.baseUrl, id, PASSWORD);
        }
    });

    after(async () => {
        if (app) await app.close();
    });

    it('returns the session contract from the live row', async () => {
        const member = await call(app.baseUrl, actor.member, 'GET', '/api/session');
        assert.equal(member.status, 200);
        assertSessionShape(member.json.user, {
            loginName: 'member',
            displayName: 'Member Person',
            companyName: 'Customer C',
            companyType: COMPANY_TYPE_CUSTOMER,
            companyContext: null,
            permissions: { systemAdmin: false, companyAdmin: false, contractOwner: false }
        });
        const customer = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/session');
        assertSessionShape(customer.json.user, {
            loginName: 'customer-admin',
            displayName: 'Customer Admin',
            companyName: 'Customer C',
            companyType: COMPANY_TYPE_CUSTOMER,
            companyContext: { id: 'customer-c', name: 'Customer C' },
            permissions: { systemAdmin: false, companyAdmin: true, contractOwner: false }
        });
        const owner = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/session');
        assertSessionShape(owner.json.user, {
            loginName: 'owner-admin',
            displayName: 'Owner Admin',
            companyName: 'Owner A',
            companyType: COMPANY_TYPE_CONTRACT_OWNER,
            companyContext: { id: 'owner-a', name: 'Owner A' },
            permissions: { systemAdmin: false, companyAdmin: true, contractOwner: true }
        });
        const system = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/session');
        assertSessionShape(system.json.user, {
            loginName: 'system-admin',
            displayName: 'System Admin',
            companyName: 'Owner A',
            companyType: COMPANY_TYPE_CONTRACT_OWNER,
            companyContext: null,
            permissions: { systemAdmin: true, companyAdmin: true, contractOwner: true }
        });
    });

    it('lists every company to a system admin and refuses company admins and members', async () => {
        const listed = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/admin/context/companies');
        assert.equal(listed.status, 200);
        assert.deepEqual(Object.keys(listed.json), ['companies']);
        const expected = app.db.prepare(`
            SELECT id, company_name AS name, company_type AS companyType FROM companies
        `).all().map(row => ({
            id: row.id,
            name: row.name,
            companyType: row.companyType
        })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        assert.deepEqual(listed.json.companies, expected);
        assert.ok(expected.length > 4);
        for (const company of listed.json.companies) {
            assert.deepEqual(Object.keys(company).sort(), ['companyType', 'id', 'name']);
        }
        const customer = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/admin/context/companies');
        assert.equal(customer.status, 403);
        const owner = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/context/companies');
        assert.equal(owner.status, 403);
        const member = await call(app.baseUrl, actor.member, 'GET', '/api/admin/context/companies');
        assert.equal(member.status, 403);
        const stillClosed = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/admin/users');
        assert.equal(stillClosed.status, 409);
        assert.equal(stillClosed.json.code, 'company_context_required');
    });

    it('lets every role browse, including a system admin whose context is another company', async () => {
        const selected = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-b' });
        assert.equal(selected.status, 200);
        const predictiveAfter = utcDay(120);
        for (const name of ['member', 'customer-admin', 'owner-admin', 'system-admin']) {
            const rates = await call(app.baseUrl, actor[name], 'GET', '/api/rates');
            assert.equal(rates.status, 200, name);
            assert.ok(Array.isArray(rates.json.rates));
            const predictive = await call(app.baseUrl, actor[name], 'GET', `/api/rates/predictive?after=${predictiveAfter}`);
            assert.equal(predictive.status, 200, name);
            const sailings = await call(app.baseUrl, actor[name], 'GET', '/api/sailings?carrier=MSC&originPort=SHA&after=2020-01-01');
            assert.equal(sailings.status, 200, name);
        }
        const home = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/rates');
        assert.deepEqual(home.json.rates.map(rate => rate.id), ['rate-a']);
        const session = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/session');
        assert.deepEqual(session.json.user.companyContext, { id: 'owner-b', name: 'Owner B' });
        assert.equal(session.json.user.permissions.contractOwner, true);
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-a' });
    });

    it('refuses every admin endpoint to a member and to a signed-out caller', async () => {
        const paths = [
            ['GET', '/api/admin/users'],
            ['POST', '/api/admin/users/owner-admin/password', { password: NEXT_PASSWORD }],
            ['PATCH', '/api/admin/users/owner-admin', { email: 'nope@example.com' }],
            ['DELETE', '/api/admin/users/owner-admin/two-factor', {}],
            ['GET', '/api/admin/companies'],
            ['PATCH', '/api/admin/companies/customer-d', { marginPercent: 0.2, marginNumber: 5 }],
            ['POST', '/api/admin/pull-forward/rates', forwardBody('rates')],
            ['POST', '/api/admin/pull-forward/sailings', forwardBody('sailings')],
            ['GET', '/api/admin/oauth-clients'],
            ['POST', '/api/admin/oauth-clients', { displayName: 'Nope', clientType: 'public', redirectUris: ['http://127.0.0.1:9/nope'], allowedScopes: ['profile:read'] }],
            ['PATCH', '/api/admin/oauth-clients/missing', { redirectUris: ['http://127.0.0.1:9/nope'] }],
            ['POST', '/api/admin/oauth-clients/missing/rotate-secret', {}],
            ['GET', '/api/admin/context'],
            ['GET', '/api/admin/context/companies'],
            ['POST', '/api/admin/context', { companyId: 'owner-a' }]
        ];
        for (const [method, path, body] of paths) {
            const denied = await call(app.baseUrl, actor.member, method, path, body);
            assert.equal(denied.status, 403, `${method} ${path}`);
            const anonymous = await fetch(new URL(path, app.baseUrl), { method });
            assert.equal(anonymous.status, 401, `${method} ${path}`);
        }
        assert.deepEqual(userRow(app.db, 'owner-admin').email, null);
    });

    it('scopes a customer company admin to that company and refuses owner and platform actions', async () => {
        const before = userRow(app.db, 'owner-admin');
        const users = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/admin/users');
        assert.equal(users.status, 200);
        assert.deepEqual(users.json.users.map(user => user.username).sort(), ['customer-admin', 'departing', 'editable', 'member']);
        assert.equal(users.json.users.every(user => user.companyName === 'Customer C'), true);
        for (const [method, path, body] of [
            ['POST', '/api/admin/users/owner-admin/password', { password: NEXT_PASSWORD }],
            ['PATCH', '/api/admin/users/owner-admin', { email: 'other@example.com', disabled: true }],
            ['DELETE', '/api/admin/users/owner-admin/two-factor', {}]
        ]) {
            const hidden = await call(app.baseUrl, actor['customer-admin'], method, path, body);
            assert.equal(hidden.status, 404, `${method} ${path}`);
            assert.equal(hidden.json.error, 'User was not found.');
        }
        assert.deepEqual(userRow(app.db, 'owner-admin'), before);
        const email = await call(app.baseUrl, actor['customer-admin'], 'PATCH', '/api/admin/users/editable', { email: 'editable@example.com' });
        assert.equal(email.status, 200);
        const password = await call(app.baseUrl, actor['customer-admin'], 'POST', '/api/admin/users/editable/password', { password: NEXT_PASSWORD });
        assert.equal(password.status, 200);
        const cleared = await call(app.baseUrl, actor['customer-admin'], 'DELETE', '/api/admin/users/editable/two-factor', {});
        assert.equal(cleared.status, 200);
        assert.equal(userRow(app.db, 'editable').email, 'editable@example.com');
        for (const [method, path, body] of [
            ['GET', '/api/admin/companies'],
            ['PATCH', '/api/admin/companies/customer-d', { marginPercent: 0.2, marginNumber: 1 }],
            ['POST', '/api/admin/pull-forward/rates', forwardBody('rates')],
            ['POST', '/api/admin/pull-forward/sailings', forwardBody('sailings')],
            ['GET', '/api/admin/oauth-clients'],
            ['POST', '/api/admin/oauth-clients', { displayName: 'Nope', clientType: 'public', redirectUris: ['http://127.0.0.1:9/nope'], allowedScopes: ['profile:read'] }]
        ]) {
            const denied = await call(app.baseUrl, actor['customer-admin'], method, path, body);
            assert.equal(denied.status, 403, `${method} ${path}`);
        }
        const context = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/admin/context');
        assert.equal(context.status, 200);
        assert.deepEqual(context.json.companyContext, { id: 'customer-c', name: 'Customer C' });
        const set = await call(app.baseUrl, actor['customer-admin'], 'POST', '/api/admin/context', { companyId: 'owner-a' });
        assert.equal(set.status, 403);
        const mismatch = await call(app.baseUrl, actor['customer-admin'], 'PATCH', '/api/admin/users/editable', {
            email: 'changed@example.com',
            companyId: 'owner-a'
        });
        assert.equal(mismatch.status, 409);
        assert.equal(mismatch.json.code, 'company_context_mismatch');
        assert.equal(userRow(app.db, 'editable').email, 'editable@example.com');
    });

    it('lets an owner company admin maintain that owner and not another company or oauth clients', async () => {
        const users = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/users');
        assert.equal(users.status, 200);
        assert.deepEqual(users.json.users.map(user => user.username).sort(), ['owner-admin', 'peer-admin', 'system-admin']);
        const hidden = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/users/member', { email: 'member@example.com' });
        assert.equal(hidden.status, 404);
        assert.equal(userRow(app.db, 'member').email, null);
        const companies = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/companies');
        assert.equal(companies.status, 200);
        const margin = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/companies/customer-d', { marginPercent: 2, marginNumber: 5 });
        assert.equal(margin.status, 200);
        const saved = app.db.prepare(`
            SELECT owner_company_id, margin_percent FROM company_margins
            WHERE owner_company_id = 'owner-a' AND customer_company_id = 'customer-d'
        `).get();
        assert.equal(saved.owner_company_id, 'owner-a');
        assert.equal(saved.margin_percent, 2);
        const rates = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/pull-forward/rates', forwardBody('rates'));
        assert.equal(rates.status, 200);
        const sailings = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/pull-forward/sailings', forwardBody('sailings'));
        assert.equal(sailings.status, 200);
        const oauth = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/oauth-clients');
        assert.equal(oauth.status, 403);
        const context = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/context');
        assert.deepEqual(context.json.companyContext, { id: 'owner-a', name: 'Owner A' });
    });

    it('fails closed when a system admin has no company context, including one who is also a company admin', async () => {
        const fresh = await login(app.baseUrl, 'system-admin', PASSWORD);
        const beforeUsers = app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
        const beforeRates = app.db.prepare('SELECT COUNT(*) AS count FROM rates').get().count;
        const peerBefore = userRow(app.db, 'peer-admin');
        const context = await call(app.baseUrl, fresh, 'GET', '/api/admin/context');
        assert.equal(context.status, 200);
        assert.equal(context.json.companyContext, null);
        for (const [method, path, body] of [
            ['GET', '/api/admin/users'],
            ['POST', '/api/admin/users/peer-admin/password', { password: NEXT_PASSWORD }],
            ['PATCH', '/api/admin/users/peer-admin', { email: 'peer@example.com', disabled: true }],
            ['DELETE', '/api/admin/users/peer-admin/two-factor', {}],
            ['GET', '/api/admin/companies'],
            ['PATCH', '/api/admin/companies/customer-d', { marginPercent: 0.3, marginNumber: 0 }],
            ['POST', '/api/admin/pull-forward/rates', forwardBody('rates')],
            ['POST', '/api/admin/pull-forward/sailings', forwardBody('sailings')]
        ]) {
            const required = await call(app.baseUrl, fresh, method, path, body);
            assert.equal(required.status, 409, `${method} ${path}`);
            assert.equal(required.json.code, 'company_context_required');
            assert.equal(required.json.users, undefined);
        }
        assert.deepEqual(userRow(app.db, 'peer-admin'), peerBefore);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, beforeUsers);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM rates').get().count, beforeRates);
        const clients = await call(app.baseUrl, fresh, 'GET', '/api/admin/oauth-clients');
        assert.equal(clients.status, 200);
        const missing = await call(app.baseUrl, fresh, 'POST', '/api/admin/context', { companyId: 'owner-b-biz' });
        assert.equal(missing.status, 404);
        const absent = await call(app.baseUrl, fresh, 'POST', '/api/admin/context', { companyId: 'missing-company' });
        assert.equal(absent.status, 404);
    });

    it('lets a system admin act only on the selected company', async () => {
        const selected = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-b' });
        assert.equal(selected.status, 200);
        assert.deepEqual(selected.json.companyContext, { id: 'owner-b', name: 'Owner B' });
        const users = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/admin/users');
        assert.equal(users.status, 200);
        assert.deepEqual(users.json.users.map(user => user.username), ['owner-b-user']);
        const home = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/users/peer-admin', { email: 'home@example.com' });
        assert.equal(home.status, 404);
        assert.equal(userRow(app.db, 'peer-admin').email, null);
        const email = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/users/owner-b-user', { email: 'b@example.com' });
        assert.equal(email.status, 200);
        const mismatch = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/users/owner-b-user', {
            email: 'elsewhere@example.com',
            companyId: 'owner-a'
        });
        assert.equal(mismatch.status, 409);
        assert.equal(mismatch.json.code, 'company_context_mismatch');
        assert.equal(userRow(app.db, 'owner-b-user').email, 'b@example.com');
        const customerContext = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'customer-c' });
        assert.equal(customerContext.status, 200);
        const notOwner = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/admin/companies');
        assert.equal(notOwner.status, 403);
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-b' });
        const ownerBBefore = app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = 'owner-b'`).get().count;
        const ownerABefore = app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = 'owner-a'`).get().count;
        const copied = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/pull-forward/rates', forwardBody('rates'));
        assert.equal(copied.status, 200, JSON.stringify(copied.json));
        assert.equal(copied.json.copied, 1);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = 'owner-b'`).get().count, ownerBBefore + 1);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = 'owner-a'`).get().count, ownerABefore);
        const sailing = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/pull-forward/sailings', forwardBody('sailings'));
        assert.equal(sailing.status, 200);
        assert.equal(sailing.json.copied, 1);
        const margin = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/companies/customer-d', { marginPercent: 4, marginNumber: 7 });
        assert.equal(margin.status, 200);
        const marginRow = app.db.prepare(`
            SELECT owner_company_id, margin_percent FROM company_margins
            WHERE owner_company_id = 'owner-b' AND customer_company_id = 'customer-d'
        `).get();
        assert.equal(marginRow.margin_percent, 4);
        const created = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/oauth-clients', {
            displayName: 'Scoped Partner',
            clientType: 'confidential',
            redirectUris: ['http://127.0.0.1:9/callback'],
            allowedScopes: ['profile:read']
        });
        assert.equal(created.status, 201);
        const clientId = created.json.client.id;
        const updated = await call(app.baseUrl, actor['system-admin'], 'PATCH', `/api/admin/oauth-clients/${clientId}`, {
            redirectUris: ['http://127.0.0.1:9/other']
        });
        assert.equal(updated.status, 200);
        const rotated = await call(app.baseUrl, actor['system-admin'], 'POST', `/api/admin/oauth-clients/${clientId}/rotate-secret`, {});
        assert.equal(rotated.status, 200);
        assert.equal(typeof rotated.json.clientSecret, 'string');
    });

    it('ignores a company-context value stored for a company admin', async () => {
        assert.equal(setSessionCompanyContext(sessionToken(actor['customer-admin'].cookie), 'owner-b'), true);
        const users = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/admin/users');
        assert.equal(users.status, 200);
        assert.equal(users.json.users.some(user => user.username === 'owner-b-user'), false);
        assert.equal(users.json.users.some(user => user.username === 'editable'), true);
        const context = await call(app.baseUrl, actor['customer-admin'], 'GET', '/api/admin/context');
        assert.deepEqual(context.json.companyContext, { id: 'customer-c', name: 'Customer C' });
    });

    it('does not grant administration from the login snapshot or from admin_screen', async () => {
        const demoted = await login(app.baseUrl, 'peer-admin', PASSWORD);
        const before = await call(app.baseUrl, demoted, 'GET', '/api/admin/users');
        assert.equal(before.status, 200);
        app.db.prepare(`UPDATE users SET company_role = 'member' WHERE id = 'peer-admin'`).run();
        const session = await call(app.baseUrl, demoted, 'GET', '/api/session');
        assert.equal(session.status, 200);
        assert.equal(session.json.user.permissions.companyAdmin, false);
        assert.equal(session.json.user.isAdmin, false);
        const users = await call(app.baseUrl, demoted, 'GET', '/api/admin/users');
        assert.equal(users.status, 403);
        const rates = await call(app.baseUrl, demoted, 'GET', '/api/rates');
        assert.equal(rates.status, 200);
        app.db.prepare(`UPDATE users SET admin_screen = 1, company_role = 'member' WHERE id = 'member'`).run();
        const flagged = await call(app.baseUrl, actor.member, 'GET', '/api/admin/users');
        assert.equal(flagged.status, 403);
        const flaggedSession = await call(app.baseUrl, actor.member, 'GET', '/api/session');
        assert.equal(flaggedSession.json.user.isAdmin, false);
        assert.equal(flaggedSession.json.user.permissions.companyAdmin, false);
    });

    it('refuses self-deactivation, the last company admin, and the last system admin', async () => {
        const selfBefore = userRow(app.db, 'owner-admin');
        const self = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/users/owner-admin', { disabled: true });
        assert.equal(self.status, 400);
        assert.deepEqual(userRow(app.db, 'owner-admin'), selfBefore);
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'customer-c' });
        const companyBefore = userRow(app.db, 'customer-admin');
        const lastCompany = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/users/customer-admin', { disabled: true });
        assert.equal(lastCompany.status, 409);
        assert.match(lastCompany.json.error, /company administrator/i);
        assert.deepEqual(userRow(app.db, 'customer-admin'), companyBefore);
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-a' });
        const systemBefore = userRow(app.db, 'system-admin');
        const lastSystem = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/users/system-admin', { disabled: true });
        assert.equal(lastSystem.status, 409);
        assert.match(lastSystem.json.error, /system administrator/i);
        assert.deepEqual(userRow(app.db, 'system-admin'), systemBefore);
    });

    it('drops a session that was created before deactivation', async () => {
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'customer-c' });
        const epochBefore = userRow(app.db, 'departing').session_epoch;
        const disabled = await call(app.baseUrl, actor['system-admin'], 'PATCH', '/api/admin/users/departing', { disabled: true });
        assert.equal(disabled.status, 200);
        const row = userRow(app.db, 'departing');
        assert.equal(row.disabled, 1);
        assert.equal(row.session_epoch, epochBefore + 1);
        const session = await call(app.baseUrl, actor.departing, 'GET', '/api/session');
        assert.equal(session.status, 401);
        const rates = await call(app.baseUrl, actor.departing, 'GET', '/api/rates');
        assert.equal(rates.status, 401);
    });
});
