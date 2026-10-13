'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { insertCompany, insertUser, insertRate, insertSailing } = require('./helpers/r1-12');
const { login, authed, ratePatch } = require('./helpers/r1-08');

const DATA_ROUTES = [
    ['GET', '/api/admin/data/rates'],
    ['GET', '/api/admin/data/sailings'],
    ['PATCH', '/api/admin/data/rates/any-id'],
    ['PATCH', '/api/admin/data/sailings/any-id'],
    ['POST', '/api/admin/data/delete/preview'],
    ['POST', '/api/admin/data/delete'],
    ['GET', '/api/admin/data/operations'],
    ['POST', '/api/admin/data/operations/any-id/restore']
];

function live(row) {
    return row && row.deleted_at == null;
}

describe('r1-08 data operations', { concurrency: 1 }, () => {
    let app;
    let ownerId;
    let ownerSession;

    before(async () => {
        app = await startApp({ companyName: 'Owner A', username: 'owner-a' });
        ownerId = app.company.id;
        ownerSession = { cookie: app.cookie, csrf: app.csrf };
        const db = app.db;
        insertCompany(db, { id: 'owner-b', name: 'Owner B', type: 'Contract Owner', typeId: 'contract_owner', admin: 1 });
        insertCompany(db, { id: 'customer-c', name: 'Customer C', type: 'Freight Forwarder/Customer', typeId: 'freight_forwarder_customer' });
        insertUser(db, { id: 'user-b', username: 'owner-b', companyId: 'owner-b', admin: 1 });
        insertUser(db, { id: 'user-customer', username: 'customer-c', companyId: 'customer-c', admin: 1 });
        insertUser(db, { id: 'user-steve', username: 'steve-context', companyId: ownerId, admin: 1 });
        db.prepare(`UPDATE users SET is_system_admin = 1 WHERE id = 'user-steve'`).run();
        const { setPasswordByUsername } = require('../lib/accounts');
        for (const name of ['owner-b', 'customer-c', 'steve-context']) {
            assert.equal(setPasswordByUsername(name, 'sail-the-ocean').ok, true);
        }
        insertRate(db, { id: 'a-live', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1000, d40: 1800, d40hc: 1900, owner: ownerId });
        insertRate(db, { id: 'b-live', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 9000, d40: 9000, d40hc: 9000, owner: 'owner-b' });
        insertSailing(db, { id: 'a-sail', departure: '2026-08-01T00:00:00.000Z', carrier: 'MSC', origin: 'SHA', owner: ownerId });
        insertSailing(db, { id: 'b-sail', departure: '2026-08-01T00:00:00.000Z', carrier: 'MSC', origin: 'SHA', owner: 'owner-b' });
    });

    after(async () => {
        if (app) await app.close();
    });

    async function call(session, method, path, body) {
        return authed(app.baseUrl, session, path, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    }

    it('rejects a customer company admin on every data route', async () => {
        const customer = await login(app.baseUrl, 'customer-c');
        for (const [method, path] of DATA_ROUTES) {
            const response = await call(customer, method, path, method === 'GET' ? undefined : { companyId: 'customer-c' });
            assert.equal(response.status, 403, `${method} ${path} ${response.text}`);
        }
    });

    it('keeps missing prices null and rejects owner changes and a stale version', async () => {
        const before = app.db.prepare(`SELECT owner_company_id, rate_20d, carrier, row_version FROM rates WHERE id = 'a-live'`).get();
        const rejectedOwner = await call(ownerSession, 'PATCH', '/api/admin/data/rates/a-live', ratePatch(ownerId, before.row_version, {
            owner_company_id: 'owner-b'
        }));
        assert.equal(rejectedOwner.status, 400, rejectedOwner.text);
        assert.equal(rejectedOwner.body.code, 'field_not_editable');
        assert.equal(app.db.prepare(`SELECT owner_company_id, carrier FROM rates WHERE id = 'a-live'`).get().owner_company_id, ownerId);

        const saved = await call(ownerSession, 'PATCH', '/api/admin/data/rates/a-live', ratePatch(ownerId, before.row_version, {
            carrier: 'EDITED',
            rate20D: null,
            rate40D: null,
            rate40HC: 100
        }));
        assert.equal(saved.status, 200, saved.text);
        const row = app.db.prepare(`SELECT carrier, rate_20d, rate_40d, rate_40hc, row_version, owner_company_id FROM rates WHERE id = 'a-live'`).get();
        assert.equal(row.carrier, 'EDITED');
        assert.equal(row.rate_20d, null);
        assert.equal(row.rate_40d, null);
        assert.equal(row.rate_40hc, 100);
        assert.equal(row.row_version, before.row_version + 1);
        assert.equal(row.owner_company_id, ownerId);
        const items = app.db.prepare(`SELECT prior_json FROM data_operation_items WHERE record_id = 'a-live' AND action = 'edit'`).all();
        assert.equal(items.length, 1);
        assert.equal(JSON.parse(items[0].prior_json).carrier, 'MSC');

        const stale = await call(ownerSession, 'PATCH', '/api/admin/data/rates/a-live', ratePatch(ownerId, before.row_version, {
            carrier: 'SHOULD-NOT-STICK'
        }));
        assert.equal(stale.status, 409, stale.text);
        assert.equal(stale.body.code, 'stale_row_version');
        assert.equal(app.db.prepare(`SELECT carrier, row_version FROM rates WHERE id = 'a-live'`).get().carrier, 'EDITED');

        const mismatch = await call(ownerSession, 'PATCH', '/api/admin/data/rates/a-live', ratePatch('owner-b', row.row_version));
        assert.equal(mismatch.status, 409, mismatch.text);
        assert.equal(mismatch.body.code, 'company_context_mismatch');
    });

    it('leaves fields out of the patch untouched, including a sailing clock time', async () => {
        insertRate(app.db, {
            id: 'partial-rate',
            origin: 'SHA',
            destination: 'LAX',
            carrier: 'MSC',
            d20: 1000,
            d40: 1800,
            d40hc: 1900,
            effective: '2026-04-01',
            expiration: '2026-10-01',
            owner: ownerId,
            rateType: 'NAC',
            inland: 'Chicago',
            commodity: 'Widgets',
            contractOwner: 'Kept Owner',
            notes: 'keep-note'
        });
        app.db.prepare(`UPDATE rates SET rate_view = 'view-9' WHERE id = 'partial-rate'`).run();
        const saved = await call(ownerSession, 'PATCH', '/api/admin/data/rates/partial-rate', ratePatch(ownerId, 1, {
            carrier: 'PARTIAL'
        }));
        assert.equal(saved.status, 200, saved.text);
        const row = app.db.prepare(`
            SELECT carrier, rate_view, contract_owner, inland_delivery_location, commodity_type, notes_1, rate_type, rate_20d
            FROM rates WHERE id = 'partial-rate'
        `).get();
        assert.equal(row.carrier, 'PARTIAL');
        assert.equal(row.rate_20d, null);
        assert.equal(row.rate_view, 'view-9');
        assert.equal(row.contract_owner, 'Kept Owner');
        assert.equal(row.inland_delivery_location, 'Chicago');
        assert.equal(row.commodity_type, 'Widgets');
        assert.equal(row.notes_1, 'keep-note');
        assert.equal(row.rate_type, 'NAC');

        insertSailing(app.db, {
            id: 'timed-sail',
            departure: '2026-08-01T15:45:00.000Z',
            arrival: '2026-08-20T08:00:00.000Z',
            carrier: 'MSC',
            origin: 'SHA',
            vessel: 'Old Vessel',
            voyage: 'VY-9',
            owner: ownerId
        });
        app.db.prepare(`UPDATE sailings SET service = 'AE1', transit_time = '19' WHERE id = 'timed-sail'`).run();
        const vesselOnly = await call(ownerSession, 'PATCH', '/api/admin/data/sailings/timed-sail', {
            vessel: 'New Vessel',
            expectedRowVersion: 1,
            companyId: ownerId
        });
        assert.equal(vesselOnly.status, 200, vesselOnly.text);
        const sailing = app.db.prepare(`
            SELECT departure, arrival, vessel, voyage, service, transit_time, carrier FROM sailings WHERE id = 'timed-sail'
        `).get();
        assert.equal(sailing.vessel, 'New Vessel');
        assert.equal(sailing.departure, '2026-08-01T15:45:00.000Z');
        assert.equal(sailing.arrival, '2026-08-20T08:00:00.000Z');
        assert.equal(sailing.voyage, 'VY-9');
        assert.equal(sailing.service, 'AE1');
        assert.equal(sailing.transit_time, '19');
        assert.equal(sailing.carrier, 'MSC');

        const dated = await call(ownerSession, 'PATCH', '/api/admin/data/sailings/timed-sail', {
            departure: '2026-08-02T15:45:00.000Z',
            expectedRowVersion: 2,
            companyId: ownerId
        });
        assert.equal(dated.status, 200, dated.text);
        assert.equal(
            app.db.prepare(`SELECT departure, arrival, vessel FROM sailings WHERE id = 'timed-sail'`).get().departure,
            '2026-08-02T15:45:00.000Z'
        );
    });

    async function deleteIds(ids, submissionId) {
        const preview = await call(ownerSession, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            companyId: ownerId,
            selection: { ids }
        });
        assert.equal(preview.status, 200, preview.text);
        const commit = await call(ownerSession, 'POST', '/api/admin/data/delete', {
            previewId: preview.body.previewId,
            submissionId,
            companyId: ownerId
        });
        assert.equal(commit.status, 200, commit.text);
        return { preview: preview.body, commit: commit.body };
    }

    it('commits only the previewed ids, rejects a stale preview, and replays a submission', async () => {
        insertRate(app.db, { id: 'filter-1', origin: 'SHA', destination: 'LAX', carrier: 'FILT', d20: 10, d40: 10, d40hc: 10, owner: ownerId });
        insertRate(app.db, { id: 'filter-2', origin: 'SHA', destination: 'NYC', carrier: 'FILT', d20: 11, d40: 11, d40hc: 11, owner: ownerId });
        insertRate(app.db, { id: 'filter-other', origin: 'SHA', destination: 'LAX', carrier: 'KEEP', d20: 12, d40: 12, d40hc: 12, owner: ownerId });
        const preview = await call(ownerSession, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            companyId: ownerId,
            selection: { filter: { carrier: 'FILT' } }
        });
        assert.equal(preview.status, 200, preview.text);
        assert.deepEqual(preview.body.records.map(row => row.id).sort(), ['filter-1', 'filter-2']);
        assert.equal(preview.body.company.name, 'Owner A');
        insertRate(app.db, { id: 'filter-new', origin: 'NGB', destination: 'LAX', carrier: 'FILT', d20: 13, d40: 13, d40hc: 13, owner: ownerId });
        const commit = await call(ownerSession, 'POST', '/api/admin/data/delete', {
            previewId: preview.body.previewId,
            submissionId: 'filter-submission',
            companyId: ownerId
        });
        assert.equal(commit.status, 200, commit.text);
        assert.equal(commit.body.affectedCount, 2);
        assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'filter-1'`).get()), false);
        assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'filter-2'`).get()), false);
        assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'filter-new'`).get()), true);
        assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'filter-other'`).get()), true);
        const again = await call(ownerSession, 'POST', '/api/admin/data/delete', {
            previewId: preview.body.previewId,
            submissionId: 'filter-submission',
            companyId: ownerId
        });
        assert.equal(again.status, 200, again.text);
        assert.deepEqual(again.body, commit.body);
        const ops = app.db.prepare(`SELECT affected_count FROM data_operations WHERE submission_id = 'filter-submission'`).all();
        assert.equal(ops.length, 1);
        assert.equal(ops[0].affected_count, 2);

        insertRate(app.db, { id: 'stale-1', origin: 'SHA', destination: 'LAX', carrier: 'STALE', d20: 1, d40: 1, d40hc: 1, owner: ownerId });
        insertRate(app.db, { id: 'stale-2', origin: 'SHA', destination: 'LAX', carrier: 'STALE', d20: 2, d40: 2, d40hc: 2, owner: ownerId });
        const stalePreview = await call(ownerSession, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            selection: { ids: ['stale-1', 'stale-2'] }
        });
        assert.equal(stalePreview.status, 200, stalePreview.text);
        const version = stalePreview.body.records.find(row => row.id === 'stale-1').rowVersion;
        const edited = await call(ownerSession, 'PATCH', '/api/admin/data/rates/stale-1', ratePatch(ownerId, version, { carrier: 'STALE' }));
        assert.equal(edited.status, 200, edited.text);
        const staleCommit = await call(ownerSession, 'POST', '/api/admin/data/delete', {
            previewId: stalePreview.body.previewId,
            submissionId: 'stale-submission',
            companyId: ownerId
        });
        assert.equal(staleCommit.status, 409, staleCommit.text);
        assert.equal(staleCommit.body.code, 'preview_stale');
        for (const id of ['stale-1', 'stale-2']) {
            assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = ?`).get(id)), true, id);
        }
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'stale-submission'`).get().count, 0);
    });

    it('rolls back a delete when a write fails mid-commit', async () => {
        insertRate(app.db, { id: 'fail-1', origin: 'SHA', destination: 'LAX', carrier: 'FAIL', d20: 1, d40: 1, d40hc: 1, owner: ownerId });
        insertRate(app.db, { id: 'fail-2', origin: 'SHA', destination: 'LAX', carrier: 'FAIL', d20: 2, d40: 2, d40hc: 2, owner: ownerId });
        const preview = await call(ownerSession, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            selection: { ids: ['fail-1', 'fail-2'] }
        });
        assert.equal(preview.status, 200, preview.text);
        const beforeOps = app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations`).get().count;
        app.db.exec(`
            CREATE TRIGGER r108_fail_second
            AFTER UPDATE OF deleted_at ON rates
            WHEN NEW.deleted_at IS NOT NULL AND NEW.id IN ('fail-1', 'fail-2')
            BEGIN
                SELECT RAISE(ABORT, 'injected-mid-commit')
                WHERE (SELECT COUNT(*) FROM rates WHERE deleted_at IS NOT NULL AND id IN ('fail-1', 'fail-2')) >= 2;
            END;
        `);
        try {
            const commit = await call(ownerSession, 'POST', '/api/admin/data/delete', {
                previewId: preview.body.previewId,
                submissionId: 'fail-submission'
            });
            assert.equal(commit.status, 500, commit.text);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations`).get().count, beforeOps);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'fail-submission'`).get().count, 0);
            for (const id of ['fail-1', 'fail-2']) {
                assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = ?`).get(id)), true, id);
            }
        } finally {
            app.db.exec('DROP TRIGGER IF EXISTS r108_fail_second');
        }
    });

    it('restores inside the window, refuses a late restore, and will not overwrite a later edit', async () => {
        insertRate(app.db, { id: 'restore-ok', origin: 'SHA', destination: 'LAX', carrier: 'BACK', d20: 5, d40: 5, d40hc: 5, owner: ownerId });
        const restored = await deleteIds(['restore-ok'], 'restore-ok-delete');
        const broughtBack = await call(ownerSession, 'POST', `/api/admin/data/operations/${restored.commit.operationId}/restore`, {
            submissionId: 'restore-ok-submission',
            companyId: ownerId
        });
        assert.equal(broughtBack.status, 200, broughtBack.text);
        const back = app.db.prepare(`SELECT deleted_at, owner_company_id FROM rates WHERE id = 'restore-ok'`).get();
        assert.equal(back.deleted_at, null);
        assert.equal(back.owner_company_id, ownerId);

        insertRate(app.db, { id: 'restore-late', origin: 'SHA', destination: 'LAX', carrier: 'LATE', d20: 6, d40: 6, d40hc: 6, owner: ownerId });
        const late = await deleteIds(['restore-late'], 'restore-late-delete');
        const old = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)).toISOString();
        app.db.prepare(`UPDATE rates SET deleted_at = ? WHERE id = 'restore-late'`).run(old);
        const refused = await call(ownerSession, 'POST', `/api/admin/data/operations/${late.commit.operationId}/restore`, {
            submissionId: 'restore-late-submission'
        });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.body.code, 'restore_window');
        assert.equal(live(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'restore-late'`).get()), false);

        insertRate(app.db, { id: 'restore-edit', origin: 'SHA', destination: 'LAX', carrier: 'CONF', d20: 7, d40: 7, d40hc: 7, owner: ownerId });
        const conflicted = await deleteIds(['restore-edit'], 'restore-edit-delete');
        app.db.prepare(`UPDATE rates SET carrier = 'CHANGED', row_version = row_version + 1 WHERE id = 'restore-edit'`).run();
        const conflict = await call(ownerSession, 'POST', `/api/admin/data/operations/${conflicted.commit.operationId}/restore`, {
            submissionId: 'restore-edit-submission'
        });
        assert.equal(conflict.status, 409, conflict.text);
        assert.equal(conflict.body.code, 'restore_conflict');
        const changed = app.db.prepare(`SELECT carrier, deleted_at FROM rates WHERE id = 'restore-edit'`).get();
        assert.equal(changed.carrier, 'CHANGED');
        assert.ok(changed.deleted_at);
    });

    it('hides owner A from owner B and from a system admin working in owner B', async () => {
        const history = await call(ownerSession, 'GET', '/api/admin/data/operations');
        assert.equal(history.status, 200, history.text);
        assert.ok(history.body.operations.some(row => row.company.name === 'Owner A'));
        assert.equal(history.body.operations.every(row => row.actor && row.createdAt && row.status), true);

        const ownerB = await login(app.baseUrl, 'owner-b');
        const search = await call(ownerB, 'GET', '/api/admin/data/rates');
        assert.equal(search.status, 200, search.text);
        assert.equal(search.body.records.some(row => row.id === 'a-live'), false);
        assert.ok(search.body.records.some(row => row.id === 'b-live'));
        const edit = await call(ownerB, 'PATCH', '/api/admin/data/rates/a-live', ratePatch('owner-b', 1));
        assert.equal(edit.status, 404, edit.text);
        const preview = await call(ownerB, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            selection: { ids: ['a-live'] }
        });
        assert.equal(preview.status, 404, preview.text);
        const theirs = await call(ownerB, 'GET', '/api/admin/data/operations');
        assert.equal(theirs.body.operations.some(row => row.company.id === ownerId), false);
        const restore = await call(ownerB, 'POST', `/api/admin/data/operations/${history.body.operations[0].id}/restore`, {
            submissionId: 'owner-b-restore'
        });
        assert.equal(restore.status, 404, restore.text);

        const steve = await login(app.baseUrl, 'steve-context');
        const missing = await call(steve, 'GET', '/api/admin/data/rates');
        assert.equal(missing.status, 409, missing.text);
        assert.equal(missing.body.code, 'company_context_required');
        const context = await call(steve, 'POST', '/api/admin/context', { companyId: 'owner-b' });
        assert.equal(context.status, 200, context.text);
        const asB = await call(steve, 'GET', '/api/admin/data/rates');
        assert.equal(asB.body.records.some(row => row.id === 'a-live'), false);
        assert.ok(asB.body.records.some(row => row.id === 'b-live'));
        const steveEdit = await call(steve, 'PATCH', '/api/admin/data/rates/a-live', ratePatch('owner-b', 1, { carrier: 'NOPE' }));
        assert.equal(steveEdit.status, 404, steveEdit.text);
        const steveHistory = await call(steve, 'GET', '/api/admin/data/operations');
        assert.equal(steveHistory.body.operations.some(row => row.company.id === ownerId), false);
        assert.equal(app.db.prepare(`SELECT carrier FROM rates WHERE id = 'a-live'`).get().carrier, 'EDITED');
    });
});
