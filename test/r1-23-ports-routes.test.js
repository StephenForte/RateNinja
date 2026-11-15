'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    insertCompany,
    insertUser,
    insertRate,
    insertSailing,
    activate
} = require('./helpers/r1-23');

describe('r1-23 ports admin routes', { concurrency: 1 }, () => {
    let app;
    let system;
    let ownerAdmin;
    let customer;

    before(async () => {
        app = await startApp({ companyType: 'Contract Owner', role: 'admin', username: 'r123-seed' });

        insertCompany(app.db, { id: 'own-a', name: 'Owner A', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(app.db, { id: 'cus-a', name: 'Customer A', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, {
            id: 'sys-1',
            username: 'r123-system',
            companyId: 'own-a',
            role: 'company_admin',
            systemAdmin: true,
            displayName: 'System Admin'
        });
        insertUser(app.db, {
            id: 'own-1',
            username: 'r123-owner-admin',
            companyId: 'own-a',
            role: 'company_admin',
            displayName: 'Owner Admin'
        });
        insertUser(app.db, {
            id: 'cus-1',
            username: 'r123-customer',
            companyId: 'cus-a',
            role: 'member',
            displayName: 'Customer User'
        });
        activate('r123-system');
        activate('r123-owner-admin');
        activate('r123-customer');

        insertRate(app.db, { id: 'rate-1', owner: 'own-a', origin: 'Port Klang', destination: 'Seattle' });
        insertRate(app.db, { id: 'rate-deleted', owner: 'own-a', origin: 'Ghost Port', destination: 'Nowhere', deletedAt: '2026-01-01T00:00:00.000Z' });
        insertSailing(app.db, { id: 'sail-1', owner: 'own-a', departurePort: 'LALB', arrivalPort: 'Port Klang' });

        system = await login(app.baseUrl, 'r123-system');
        ownerAdmin = await login(app.baseUrl, 'r123-owner-admin');
        customer = await login(app.baseUrl, 'r123-customer');
    });

    after(async () => {
        if (app) await app.close();
    });

    it('refuses owner admin, customer, and anonymous callers', async () => {
        for (const [label, session] of [
            ['owner-admin', ownerAdmin],
            ['customer', customer]
        ]) {
            const listed = await call(app.baseUrl, session, 'GET', '/api/admin/ports');
            assert.equal(listed.status, 403, label);
            assert.equal(listed.json.error, 'Administrator access is required.');

            const created = await call(app.baseUrl, session, 'POST', '/api/admin/ports', {
                code: 'X',
                name: 'X'
            });
            assert.equal(created.status, 403, label);
            assert.equal(created.json.error, 'Administrator access is required.');
        }

        const anonymous = await call(app.baseUrl, null, 'GET', '/api/admin/ports');
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.json.error, 'Please sign in to continue.');
    });

    it('lists unmatched stored values and lets a system admin CRUD ports with audit', async () => {
        const before = await call(app.baseUrl, system, 'GET', '/api/admin/ports');
        assert.equal(before.status, 200);
        assert.deepEqual(before.json.ports, []);
        assert.deepEqual(before.json.unmatched, ['LALB', 'Port Klang', 'Seattle']);
        assert.equal(before.json.unmatched.includes('Ghost Port'), false);

        const blank = await call(app.baseUrl, system, 'POST', '/api/admin/ports', { code: '  ', name: 'Named' });
        assert.equal(blank.status, 400);

        const blankName = await call(app.baseUrl, system, 'POST', '/api/admin/ports', { code: 'ABC', name: '' });
        assert.equal(blankName.status, 400);

        const created = await call(app.baseUrl, system, 'POST', '/api/admin/ports', {
            code: ' lalb ',
            name: ' Los Angeles / Long Beach '
        });
        assert.equal(created.status, 201);
        assert.equal(created.json.port.code, 'LALB');
        assert.equal(created.json.port.name, 'Los Angeles / Long Beach');
        const portId = created.json.port.id;

        const duplicate = await call(app.baseUrl, system, 'POST', '/api/admin/ports', {
            code: 'lalb',
            name: 'Other Name'
        });
        assert.equal(duplicate.status, 409);

        const pkg = await call(app.baseUrl, system, 'POST', '/api/admin/ports', {
            code: 'PKG',
            name: 'Port Klang'
        });
        assert.equal(pkg.status, 201);

        const listed = await call(app.baseUrl, system, 'GET', '/api/admin/ports');
        assert.equal(listed.status, 200);
        assert.equal(listed.json.ports.length, 2);
        assert.deepEqual(listed.json.unmatched, ['Seattle']);

        const updated = await call(app.baseUrl, system, 'PATCH', `/api/admin/ports/${portId}`, {
            name: 'LA / LB'
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.json.port.name, 'LA / LB');
        assert.equal(updated.json.port.code, 'LALB');

        const missingCsrf = await call(app.baseUrl, system, 'POST', '/api/admin/ports', {
            code: 'SEA',
            name: 'Seattle'
        }, { csrf: false });
        assert.equal(missingCsrf.status, 403);
        assert.match(missingCsrf.json.error, /session could not be verified/i);

        const removed = await call(app.baseUrl, system, 'DELETE', `/api/admin/ports/${pkg.json.port.id}`, {});
        assert.equal(removed.status, 200);

        const afterDelete = await call(app.baseUrl, system, 'GET', '/api/admin/ports');
        assert.deepEqual(afterDelete.json.unmatched.sort(), ['Port Klang', 'Seattle'].sort());

        const audit = app.db.prepare(`
            SELECT event_type, detail FROM audit_events
            WHERE event_type IN ('port_created', 'port_updated', 'port_deleted')
            ORDER BY created_at, event_type
        `).all();
        const types = audit.map(row => row.event_type);
        assert.ok(types.includes('port_created'));
        assert.ok(types.includes('port_updated'));
        assert.ok(types.includes('port_deleted'));
        const createdDetail = JSON.parse(audit.find(row => row.event_type === 'port_created').detail);
        assert.equal(createdDetail.portKey, 'LALB');
        assert.equal(createdDetail.name, 'Los Angeles / Long Beach');
    });
});
