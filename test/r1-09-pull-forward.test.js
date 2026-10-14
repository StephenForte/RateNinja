'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { insertCompany, insertUser, insertRate, insertSailing } = require('./helpers/r1-12');
const { ymd, login, authed, ratePatch } = require('./helpers/r1-08');

const repoRoot = path.join(__dirname, '..');

function walkJs(directory, files) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'data') continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walkJs(full, files);
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

describe('r1-09 pull-forward and undo', { concurrency: 1 }, () => {
    let app;
    let ownerId;
    let ownerSession;
    const source = ymd(-15);
    const target = ymd(20);

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
    });

    after(async () => {
        if (app) await app.close();
    });

    async function call(session, method, pathName, body) {
        return authed(app.baseUrl, session, pathName, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    }

    function rateCount(where = '', params = []) {
        const sql = `SELECT COUNT(*) AS count FROM rates ${where}`;
        return Number(app.db.prepare(sql).get(...params).count);
    }

    async function previewForward(extra = {}) {
        return call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'rates',
            companyId: ownerId,
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            priceIncreasePercent: 10,
            conflict: 'keep',
            filter: { carrier: 'MSC', origin: 'SHA', destination: 'LAX' },
            ...extra
        });
    }

    async function commitForward(previewId, submissionId) {
        return call(ownerSession, 'POST', '/api/admin/data/pull-forward', {
            previewId,
            submissionId,
            companyId: ownerId
        });
    }

    it('has no hard delete of rates or sailings in lib or server.js', () => {
        const files = [...walkJs(path.join(repoRoot, 'lib'), []), path.join(repoRoot, 'server.js')];
        const hits = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            if (/DELETE\s+FROM\s+(rates|sailings)/i.test(text)) hits.push(file);
        }
        assert.deepEqual(hits, []);
        const wizard = fs.readFileSync(path.join(repoRoot, 'public', 'js', 'admin', 'pull-forward.js'), 'utf8');
        assert.match(wizard, /keep\.checked = true/);
        assert.doesNotMatch(wizard, /replace\.checked = true/);
        assert.match(wizard, /pf-conflict-replace/);
        for (const label of ['Dataset', 'Source', 'Target start', 'Conflict', 'Preview', 'Confirm']) {
            assert.match(wizard, new RegExp(label));
        }
        const history = fs.readFileSync(path.join(repoRoot, 'public', 'js', 'admin', 'data.js'), 'utf8');
        assert.match(history, /dataUndoConflicts/);
        assert.match(history, /'Undo'/);
    });

    it('keeps target rows and applies the price increase once', async () => {
        insertRate(app.db, {
            id: 'keep-source', origin: 'SHA', destination: 'LAX', carrier: 'KEEP',
            d20: 2000, d40: 3000, d40hc: 4000, effective: source, expiration: source, owner: ownerId
        });
        insertRate(app.db, {
            id: 'keep-target', origin: 'SHA', destination: 'LAX', carrier: 'KEEP',
            d20: 50, d40: 60, d40hc: 70, effective: target, expiration: target, owner: ownerId
        });
        const beforeTarget = app.db.prepare(`SELECT rate_20d, row_version, deleted_at FROM rates WHERE id = 'keep-target'`).get();
        const preview = await previewForward({ filter: { carrier: 'KEEP', origin: 'SHA', destination: 'LAX' } });
        assert.equal(preview.status, 200, preview.text);
        assert.equal(preview.body.conflict, 'keep');
        assert.equal(preview.body.targetEnd, target);
        assert.equal(preview.body.copied, 1);
        assert.equal(preview.body.replaced, 0);
        const committed = await commitForward(preview.body.previewId, 'keep-submission');
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.copied, 1);
        assert.equal(committed.body.deleted, 0);
        const targetRow = app.db.prepare(`SELECT rate_20d, row_version, deleted_at FROM rates WHERE id = 'keep-target'`).get();
        assert.deepEqual(targetRow, beforeTarget);
        const copies = app.db.prepare(`
            SELECT rate_20d, rate_40d, rate_40hc, rate_effective_date, rate_expiration_date, row_version, deleted_at
            FROM rates WHERE owner_company_id = ? AND rate_effective_date = ? AND id != 'keep-target' AND deleted_at IS NULL
        `).all(ownerId, target);
        assert.equal(copies.length, 1);
        assert.equal(copies[0].rate_20d, 2200);
        assert.equal(copies[0].rate_40d, 3300);
        assert.equal(copies[0].rate_40hc, 4400);
        assert.equal(copies[0].rate_expiration_date, target);
        assert.equal(copies[0].row_version, 1);
        assert.equal(copies[0].deleted_at, null);
        const items = app.db.prepare(`
            SELECT action FROM data_operation_items WHERE operation_id = ?
        `).all(committed.body.operationId);
        assert.deepEqual(items.map(item => item.action), ['create']);
    });

    it('replaces only matching target rows and leaves a prior deletion restorable', async () => {
        insertRate(app.db, {
            id: 'rep-source', origin: 'SHA', destination: 'LAX', carrier: 'REP',
            d20: 1000, d40: 1000, d40hc: 1000, effective: source, expiration: source, owner: ownerId
        });
        insertRate(app.db, {
            id: 'rep-match', origin: 'SHA', destination: 'LAX', carrier: 'REP',
            d20: 40, d40: 40, d40hc: 40, effective: target, expiration: target, owner: ownerId
        });
        insertRate(app.db, {
            id: 'rep-other-carrier', origin: 'SHA', destination: 'LAX', carrier: 'CMA',
            d20: 70, d40: 70, d40hc: 70, effective: target, expiration: target, owner: ownerId
        });
        insertRate(app.db, {
            id: 'rep-other-owner', origin: 'SHA', destination: 'LAX', carrier: 'REP',
            d20: 80, d40: 80, d40hc: 80, effective: target, expiration: target, owner: 'owner-b'
        });
        insertRate(app.db, {
            id: 'rep-already', origin: 'SHA', destination: 'LAX', carrier: 'REP',
            d20: 90, d40: 90, d40hc: 90, effective: target, expiration: target, owner: ownerId
        });
        const previewDelete = await call(ownerSession, 'POST', '/api/admin/data/delete/preview', {
            dataset: 'rates',
            companyId: ownerId,
            selection: { ids: ['rep-already'] }
        });
        assert.equal(previewDelete.status, 200, previewDelete.text);
        const deleted = await call(ownerSession, 'POST', '/api/admin/data/delete', {
            previewId: previewDelete.body.previewId,
            submissionId: 'rep-already-delete',
            companyId: ownerId
        });
        assert.equal(deleted.status, 200, deleted.text);
        const goneBefore = app.db.prepare(`SELECT deleted_at, deleted_operation_id, row_version FROM rates WHERE id = 'rep-already'`).get();
        const replacing = await previewForward({
            conflict: 'replace',
            filter: { carrier: 'REP', origin: 'SHA', destination: 'LAX' },
            priceIncreasePercent: 0
        });
        assert.equal(replacing.status, 200, replacing.text);
        assert.equal(replacing.body.conflict, 'replace');
        assert.equal(replacing.body.replaced, 1);
        assert.deepEqual(replacing.body.replacedRecords.map(row => row.id), ['rep-match']);
        const committed = await commitForward(replacing.body.previewId, 'replace-submission');
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.deleted, 1);
        const match = app.db.prepare(`SELECT deleted_at, deleted_operation_id, rate_20d FROM rates WHERE id = 'rep-match'`).get();
        assert.ok(match.deleted_at);
        assert.equal(match.deleted_operation_id, committed.body.operationId);
        assert.equal(match.rate_20d, 40);
        const otherCarrier = app.db.prepare(`SELECT deleted_at, row_version, rate_20d FROM rates WHERE id = 'rep-other-carrier'`).get();
        assert.equal(otherCarrier.deleted_at, null);
        assert.equal(otherCarrier.row_version, 1);
        assert.equal(otherCarrier.rate_20d, 70);
        const otherOwner = app.db.prepare(`SELECT deleted_at, row_version, rate_20d FROM rates WHERE id = 'rep-other-owner'`).get();
        assert.equal(otherOwner.deleted_at, null);
        assert.equal(otherOwner.row_version, 1);
        const goneAfter = app.db.prepare(`SELECT deleted_at, deleted_operation_id, row_version FROM rates WHERE id = 'rep-already'`).get();
        assert.deepEqual(goneAfter, goneBefore);
        const restored = await call(ownerSession, 'POST', `/api/admin/data/operations/${deleted.body.operationId}/restore`, {
            submissionId: 'rep-already-restore',
            companyId: ownerId
        });
        assert.equal(restored.status, 200, restored.text);
        assert.equal(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'rep-already'`).get().deleted_at, null);
    });

    it('undoes a pull-forward by removing created rows and restoring replaced rows', async () => {
        const operation = app.db.prepare(`SELECT id FROM data_operations WHERE submission_id = 'replace-submission'`).get();
        const created = app.db.prepare(`
            SELECT record_id FROM data_operation_items WHERE operation_id = ? AND action = 'create'
        `).get(operation.id);
        const undone = await call(ownerSession, 'POST', `/api/admin/data/operations/${operation.id}/undo`, {
            submissionId: 'undo-replace',
            companyId: ownerId
        });
        assert.equal(undone.status, 200, undone.text);
        assert.equal(undone.body.undoneOperationId, operation.id);
        const createdRow = app.db.prepare(`SELECT deleted_at, deleted_operation_id FROM rates WHERE id = ?`).get(created.record_id);
        assert.ok(createdRow.deleted_at);
        assert.equal(createdRow.deleted_operation_id, undone.body.operationId);
        const restored = app.db.prepare(`SELECT deleted_at, deleted_operation_id, rate_20d FROM rates WHERE id = 'rep-match'`).get();
        assert.equal(restored.deleted_at, null);
        assert.equal(restored.deleted_operation_id, null);
        assert.equal(restored.rate_20d, 40);
        const again = await call(ownerSession, 'POST', `/api/admin/data/operations/${operation.id}/undo`, {
            submissionId: 'undo-replace-again',
            companyId: ownerId
        });
        assert.equal(again.status, 409, again.text);
        assert.equal(again.body.code, 'already_undone');
        assert.equal(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'rep-match'`).get().deleted_at, null);
        const undoOfUndo = await call(ownerSession, 'POST', `/api/admin/data/operations/${undone.body.operationId}/undo`, {
            submissionId: 'undo-the-undo',
            companyId: ownerId
        });
        assert.equal(undoOfUndo.status, 409, undoOfUndo.text);
        assert.equal(undoOfUndo.body.code, 'not_undoable');
    });

    it('refuses undo after a created row was edited and changes nothing', async () => {
        insertRate(app.db, {
            id: 'edit-src-1', origin: 'SHA', destination: 'LAX', carrier: 'PAIR',
            d20: 100, d40: 100, d40hc: 100, effective: source, expiration: source, owner: ownerId, notes: 'pair-1'
        });
        insertRate(app.db, {
            id: 'edit-src-2', origin: 'SHA', destination: 'NYC', carrier: 'PAIR',
            d20: 110, d40: 110, d40hc: 110, effective: source, expiration: source, owner: ownerId, notes: 'pair-2'
        });
        insertRate(app.db, {
            id: 'edit-target', origin: 'SHA', destination: 'LAX', carrier: 'PAIR',
            d20: 5, d40: 5, d40hc: 5, effective: target, expiration: target, owner: ownerId
        });
        const preview = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'rates',
            companyId: ownerId,
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            priceIncreasePercent: 0,
            conflict: 'replace',
            filter: { carrier: 'PAIR' }
        });
        assert.equal(preview.status, 200, preview.text);
        const committed = await commitForward(preview.body.previewId, 'edit-then-undo');
        assert.equal(committed.status, 200, committed.text);
        const created = app.db.prepare(`
            SELECT record_id FROM data_operation_items
            WHERE operation_id = ? AND action = 'create' ORDER BY record_id
        `).all(committed.body.operationId);
        assert.equal(created.length, 2);
        const victim = created[0].record_id;
        const other = created[1].record_id;
        const version = app.db.prepare(`SELECT row_version FROM rates WHERE id = ?`).get(victim).row_version;
        const edited = await call(ownerSession, 'PATCH', `/api/admin/data/rates/${victim}`, ratePatch(ownerId, version, { carrier: 'EDITED' }));
        assert.equal(edited.status, 200, edited.text);
        const before = app.db.prepare(`SELECT id, carrier, deleted_at, row_version, deleted_operation_id FROM rates WHERE id IN (?, ?, 'edit-target') ORDER BY id`).all(victim, other);
        const opsBefore = Number(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations`).get().count);
        const refused = await call(ownerSession, 'POST', `/api/admin/data/operations/${committed.body.operationId}/undo`, {
            submissionId: 'undo-after-edit',
            companyId: ownerId
        });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.body.code, 'undo_conflict');
        assert.ok(refused.body.conflicts.some(item => item.id === victim));
        assert.match(refused.body.error, new RegExp(victim));
        const after = app.db.prepare(`SELECT id, carrier, deleted_at, row_version, deleted_operation_id FROM rates WHERE id IN (?, ?, 'edit-target') ORDER BY id`).all(victim, other);
        assert.deepEqual(after, before);
        assert.equal(app.db.prepare(`SELECT carrier FROM rates WHERE id = ?`).get(victim).carrier, 'EDITED');
        assert.equal(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = ?`).get(other).deleted_at, null);
        assert.ok(app.db.prepare(`SELECT deleted_at FROM rates WHERE id = 'edit-target'`).get().deleted_at);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE type = 'undo' AND submission_id = 'undo-after-edit'`).get().count, 0);
        assert.equal(Number(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations`).get().count), opsBefore);
    });

    it('undoes an edit, then refuses a second undo', async () => {
        insertRate(app.db, {
            id: 'plain-edit', origin: 'SHA', destination: 'LAX', carrier: 'ORIGINAL',
            d20: 15, d40: 15, d40hc: 15, effective: '2026-04-01', expiration: '2026-10-01', owner: ownerId
        });
        const version = app.db.prepare(`SELECT row_version FROM rates WHERE id = 'plain-edit'`).get().row_version;
        const edited = await call(ownerSession, 'PATCH', '/api/admin/data/rates/plain-edit', ratePatch(ownerId, version, { carrier: 'CHANGED' }));
        assert.equal(edited.status, 200, edited.text);
        const undone = await call(ownerSession, 'POST', `/api/admin/data/operations/${edited.body.operationId}/undo`, {
            submissionId: 'undo-edit',
            companyId: ownerId
        });
        assert.equal(undone.status, 200, undone.text);
        const row = app.db.prepare(`SELECT carrier, row_version FROM rates WHERE id = 'plain-edit'`).get();
        assert.equal(row.carrier, 'ORIGINAL');
        assert.equal(row.row_version, version + 2);
        const second = await call(ownerSession, 'POST', `/api/admin/data/operations/${edited.body.operationId}/undo`, {
            submissionId: 'undo-edit-again',
            companyId: ownerId
        });
        assert.equal(second.status, 409, second.text);
        assert.equal(second.body.code, 'already_undone');
        assert.equal(app.db.prepare(`SELECT carrier, row_version FROM rates WHERE id = 'plain-edit'`).get().row_version, version + 2);
        const replay = await call(ownerSession, 'POST', `/api/admin/data/operations/${edited.body.operationId}/undo`, {
            submissionId: 'undo-edit',
            companyId: ownerId
        });
        assert.equal(replay.status, 200, replay.text);
        assert.equal(replay.body.operationId, undone.body.operationId);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'undo-edit'`).get().count, 1);
    });

    it('refuses undo outside the restore window and writes nothing', async () => {
        insertRate(app.db, {
            id: 'late-edit', origin: 'SHA', destination: 'LAX', carrier: 'LATE',
            d20: 16, d40: 16, d40hc: 16, effective: '2026-04-01', expiration: '2026-10-01', owner: ownerId
        });
        const version = app.db.prepare(`SELECT row_version FROM rates WHERE id = 'late-edit'`).get().row_version;
        const edited = await call(ownerSession, 'PATCH', '/api/admin/data/rates/late-edit', ratePatch(ownerId, version, { carrier: 'STILL' }));
        assert.equal(edited.status, 200, edited.text);
        const old = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)).toISOString();
        app.db.prepare(`UPDATE data_operations SET created_at = ? WHERE id = ?`).run(old, edited.body.operationId);
        const before = app.db.prepare(`SELECT carrier, row_version FROM rates WHERE id = 'late-edit'`).get();
        const refused = await call(ownerSession, 'POST', `/api/admin/data/operations/${edited.body.operationId}/undo`, {
            submissionId: 'undo-late',
            companyId: ownerId
        });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.body.code, 'restore_window');
        assert.deepEqual(app.db.prepare(`SELECT carrier, row_version FROM rates WHERE id = 'late-edit'`).get(), before);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'undo-late'`).get().count, 0);
    });

    it('rejects a stale preview and replays one submission id', async () => {
        insertRate(app.db, {
            id: 'stale-source', origin: 'SHA', destination: 'LAX', carrier: 'STALE',
            d20: 9, d40: 9, d40hc: 9, effective: source, expiration: source, owner: ownerId
        });
        const preview = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'rates',
            companyId: ownerId,
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            priceIncreasePercent: 0,
            conflict: 'keep',
            filter: { carrier: 'STALE' }
        });
        assert.equal(preview.status, 200, preview.text);
        app.db.prepare(`UPDATE rates SET row_version = row_version + 1 WHERE id = 'stale-source'`).run();
        const before = rateCount('WHERE carrier = ? AND rate_effective_date = ?', ['STALE', target]);
        const stale = await commitForward(preview.body.previewId, 'stale-submission');
        assert.equal(stale.status, 409, stale.text);
        assert.equal(stale.body.code, 'preview_stale');
        assert.equal(rateCount('WHERE carrier = ? AND rate_effective_date = ?', ['STALE', target]), before);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'stale-submission'`).get().count, 0);

        app.db.prepare(`UPDATE rates SET row_version = row_version - 1 WHERE id = 'stale-source'`).run();
        const fresh = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'rates',
            companyId: ownerId,
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            priceIncreasePercent: 0,
            conflict: 'keep',
            filter: { carrier: 'STALE' }
        });
        assert.equal(fresh.status, 200, fresh.text);
        const first = await commitForward(fresh.body.previewId, 'replay-submission');
        assert.equal(first.status, 200, first.text);
        const second = await commitForward(fresh.body.previewId, 'replay-submission');
        assert.equal(second.status, 200, second.text);
        assert.equal(second.body.operationId, first.body.operationId);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'replay-submission'`).get().count, 1);
        assert.equal(rateCount('WHERE carrier = ? AND rate_effective_date = ? AND deleted_at IS NULL', ['STALE', target]), 1);
        const third = await commitForward(fresh.body.previewId, 'replay-other');
        assert.equal(third.status, 409, third.text);
        assert.equal(third.body.code, 'preview_stale');
        assert.equal(rateCount('WHERE carrier = ? AND rate_effective_date = ? AND deleted_at IS NULL', ['STALE', target]), 1);
    });

    it('returns 400 for the 90-day, equal-duration, and target-after-source rules', async () => {
        const body = {
            dataset: 'rates',
            companyId: ownerId,
            priceIncreasePercent: 0,
            conflict: 'keep'
        };
        const tooFar = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            ...body,
            sourceStart: ymd(-1),
            sourceEnd: ymd(-1),
            targetStart: ymd(91),
            targetEnd: ymd(91)
        });
        assert.equal(tooFar.status, 400, tooFar.text);
        assert.match(tooFar.body.error, /90 days/);
        const uneven = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            ...body,
            sourceStart: ymd(-10),
            sourceEnd: ymd(-8),
            targetStart: ymd(10),
            targetEnd: ymd(11)
        });
        assert.equal(uneven.status, 400, uneven.text);
        assert.match(uneven.body.error, /length must equal/);
        const overlap = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            ...body,
            sourceStart: ymd(-5),
            sourceEnd: ymd(-1),
            targetStart: ymd(-1),
            targetEnd: ymd(3)
        });
        assert.equal(overlap.status, 400, overlap.text);
        assert.match(overlap.body.error, /after the source range/);
    });

    it('preserves a sailing time of day across a UTC day shift', async () => {
        const departure = `${source}T15:45:30.000Z`;
        const arrival = `${source}T23:05:00.000Z`;
        insertSailing(app.db, {
            id: 'sail-source',
            departure,
            arrival,
            carrier: 'MSC',
            origin: 'SHA',
            owner: ownerId,
            vessel: 'Clock'
        });
        const preview = await call(ownerSession, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'sailings',
            companyId: ownerId,
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            conflict: 'keep',
            filter: { carrier: 'MSC', departurePort: 'SHA' }
        });
        assert.equal(preview.status, 200, preview.text);
        assert.equal(preview.body.targetEnd, target);
        const committed = await commitForward(preview.body.previewId, 'sailing-shift');
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.copied, 1);
        const copy = app.db.prepare(`
            SELECT departure, arrival FROM sailings
            WHERE vessel = 'Clock' AND id != 'sail-source' AND deleted_at IS NULL
        `).get();
        assert.equal(copy.departure, `${target}T15:45:30.000Z`);
        assert.equal(copy.arrival, `${target}T23:05:00.000Z`);
    });

    it('soft-deletes through the legacy endpoint and still returns copied and deleted', async () => {
        insertRate(app.db, {
            id: 'legacy-source', origin: 'SHA', destination: 'LAX', carrier: 'LEG',
            d20: 12, d40: 12, d40hc: 12, effective: source, expiration: source, owner: ownerId
        });
        insertRate(app.db, {
            id: 'legacy-target', origin: 'SHA', destination: 'LAX', carrier: 'LEG',
            d20: 13, d40: 13, d40hc: 13, effective: target, expiration: target, owner: ownerId
        });
        const response = await call(ownerSession, 'POST', '/api/admin/pull-forward/rates', {
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            targetEnd: target,
            priceIncreasePercent: 0,
            deleteExisting: true,
            companyId: ownerId
        });
        assert.equal(response.status, 200, response.text);
        assert.equal(response.body.ok, true);
        assert.ok(response.body.copied >= 1);
        assert.ok(response.body.deleted >= 1);
        const targetRow = app.db.prepare(`SELECT deleted_at, deleted_operation_id FROM rates WHERE id = 'legacy-target'`).get();
        assert.ok(targetRow.deleted_at);
        assert.ok(targetRow.deleted_operation_id);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE id = 'legacy-target'`).get().count, 1);
        const operation = app.db.prepare(`SELECT type FROM data_operations WHERE id = ?`).get(targetRow.deleted_operation_id);
        assert.equal(operation.type, 'pull-forward');
    });

    it('gives a customer admin 403 and a system admin without context 409', async () => {
        const customer = await login(app.baseUrl, 'customer-c');
        const routes = [
            ['POST', '/api/admin/data/pull-forward/preview', { dataset: 'rates', companyId: 'customer-c' }],
            ['POST', '/api/admin/data/pull-forward', { previewId: 'x', submissionId: 'y', companyId: 'customer-c' }],
            ['POST', '/api/admin/data/operations/any-id/undo', { submissionId: 'z', companyId: 'customer-c' }],
            ['POST', '/api/admin/pull-forward/rates', { sourceStart: source, sourceEnd: source, targetStart: target, targetEnd: target, priceIncreasePercent: 0, companyId: 'customer-c' }]
        ];
        for (const [method, pathName, body] of routes) {
            const response = await call(customer, method, pathName, body);
            assert.equal(response.status, 403, `${method} ${pathName} ${response.text}`);
        }
        const steve = await login(app.baseUrl, 'steve-context');
        const missing = await call(steve, 'POST', '/api/admin/data/pull-forward/preview', {
            dataset: 'rates',
            sourceStart: source,
            sourceEnd: source,
            targetStart: target,
            priceIncreasePercent: 0
        });
        assert.equal(missing.status, 409, missing.text);
        assert.equal(missing.body.code, 'company_context_required');
    });
});
