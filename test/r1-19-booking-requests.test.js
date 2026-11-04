'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { customerPrice } = require('../lib/pricing');
const { MAX_BOOKING_SLOTS } = require('../lib/limits');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    insertRate,
    insertMargin,
    activate
} = require('./helpers/r1-19');

const BASE = 8123;
const BASE_40 = 8240;
const BASE_HC = 8357;
const MARGIN = 0.1;

function keysOf(value, into = []) {
    if (!value || typeof value !== 'object') return into;
    if (Array.isArray(value)) {
        value.forEach(item => keysOf(item, into));
        return into;
    }
    for (const [key, child] of Object.entries(value)) {
        into.push(key);
        keysOf(child, into);
    }
    return into;
}

function containsNumber(value, target) {
    if (typeof value === 'number') return value === target;
    if (typeof value === 'string') return value.includes(String(target));
    if (Array.isArray(value)) return value.some(item => containsNumber(item, target));
    if (value && typeof value === 'object') return Object.values(value).some(item => containsNumber(item, target));
    return false;
}

function assertNoBase(payload) {
    for (const base of [BASE, BASE_40, BASE_HC]) {
        assert.equal(containsNumber(payload, base), false, `base price ${base} leaked`);
    }
}

function assertNoDecider(payload, deciderId, deciderName) {
    const keys = keysOf(payload);
    for (const key of ['decidedBy', 'decidedByUserId', 'decided_by', 'decidingUser', 'decidedByUserName']) {
        assert.equal(keys.includes(key), false, key);
    }
    assert.equal(containsNumber(payload, deciderId) || JSON.stringify(payload).includes(deciderId), false);
    assert.equal(JSON.stringify(payload).includes(deciderName), false);
}

describe('r1-19 booking requests', { concurrency: 1 }, () => {
    let app;

    before(async () => {
        app = await startApp({ companyType: 'Contract Owner', role: 'member', username: 'r119-idle' });
        assert.equal(MAX_BOOKING_SLOTS, 1000);
    });

    after(async () => {
        if (app) await app.close();
    });

    function addCompany(id, name, type) {
        insertCompany(app.db, { id, name, type });
    }

    function addUser({ id, username, companyId, role = 'member', systemAdmin = false, displayName }) {
        insertUser(app.db, { id, username, companyId, role, systemAdmin, displayName });
        activate(username);
    }

    async function session(username) {
        return login(app.baseUrl, username);
    }

    async function party(prefix, rate = {}) {
        const ownerId = `${prefix}-owner`;
        const customerId = `${prefix}-customer`;
        const rateId = `${prefix}-rate`;
        addCompany(ownerId, `${prefix} Owner`, COMPANY_TYPE_CONTRACT_OWNER);
        addCompany(customerId, `${prefix} Customer`, COMPANY_TYPE_CUSTOMER);
        addUser({
            id: `${prefix}-owner-user`,
            username: `${prefix}-owner`,
            companyId: ownerId,
            displayName: `${prefix} Owner User`
        });
        addUser({
            id: `${prefix}-customer-user`,
            username: `${prefix}-customer`,
            companyId: customerId,
            displayName: `${prefix} Customer User`
        });
        insertMargin(app.db, {
            id: `${prefix}-margin`,
            owner: ownerId,
            customer: customerId,
            percent: rate.percent ?? MARGIN,
            number: rate.marginNumber ?? 0
        });
        insertRate(app.db, {
            id: rateId,
            owner: ownerId,
            carrier: rate.carrier || 'MSC',
            origin: rate.origin || 'SHA',
            destination: rate.destination || 'LAX',
            rate20: Object.prototype.hasOwnProperty.call(rate, 'rate20') ? rate.rate20 : BASE,
            rate40: Object.prototype.hasOwnProperty.call(rate, 'rate40') ? rate.rate40 : BASE_40,
            rate40hc: Object.prototype.hasOwnProperty.call(rate, 'rate40hc') ? rate.rate40hc : BASE_HC,
            effective: rate.effective || '2026-04-01',
            expiration: Object.prototype.hasOwnProperty.call(rate, 'expiration') ? rate.expiration : utcDay(30),
            notes: rate.notes || 'keep'
        });
        return {
            ownerId,
            customerId,
            rateId,
            customer: await session(`${prefix}-customer`),
            owner: await session(`${prefix}-owner`)
        };
    }

    async function requestBooking(who, rateId, extra = {}) {
        return call(app.baseUrl, who, 'POST', '/api/booking-requests', {
            rateId,
            containerSize: '20D',
            slots: 2,
            ...extra
        });
    }

    it('snapshots the customer price under a non-zero margin and omits the base price', async () => {
        const world = await party('leak');
        const expected = customerPrice(BASE, { marginPercent: MARGIN, marginNumber: 0 });
        assert.notEqual(expected, BASE);
        const created = await requestBooking(world.customer, world.rateId, { ownerCompanyId: 'not-the-owner', slots: 2 });
        assert.equal(created.status, 201);
        assert.equal(created.json.request.customerPrice, expected);
        assert.equal(created.json.request.containerSize, '20D');
        assert.equal(created.json.request.slots, 2);
        assert.equal(created.json.request.status, 'pending');
        assertNoBase(created.json);
        const stored = app.db.prepare('SELECT owner_company_id, customer_price, carrier FROM booking_requests WHERE id = ?').get(created.json.request.id);
        assert.equal(stored.owner_company_id, world.ownerId);
        assert.equal(stored.customer_price, expected);
        assert.equal(stored.carrier, 'MSC');
        const ownerView = await call(app.baseUrl, world.owner, 'GET', `/api/booking-requests/${created.json.request.id}`);
        assert.equal(ownerView.status, 200);
        assert.equal(ownerView.json.request.customerPrice, expected);
        assert.equal(ownerView.json.request.requestedBy.name, 'leak Customer User');
        assertNoBase(ownerView.json);
        const audit = app.db.prepare(`
            SELECT detail FROM audit_events
            WHERE event_type = 'booking_request_created' AND actor_user_id = ?
            ORDER BY created_at DESC LIMIT 1
        `).get('leak-customer-user');
        assert.ok(audit);
        assert.equal(audit.detail.includes(String(BASE)), false);
        assert.equal(audit.detail.includes(String(expected)), true);
    });

    it('returns one 404 body for unlinked, revoked, soft-deleted, and missing rates', async () => {
        const world = await party('miss');
        addCompany('miss-other', 'Miss Other', COMPANY_TYPE_CONTRACT_OWNER);
        addCompany('miss-revoker', 'Miss Revoker', COMPANY_TYPE_CONTRACT_OWNER);
        insertRate(app.db, { id: 'miss-unlinked', owner: 'miss-other', rate20: BASE, expiration: utcDay(10) });
        insertRate(app.db, { id: 'miss-revoked', owner: 'miss-revoker', rate20: BASE, expiration: utcDay(10) });
        insertMargin(app.db, {
            id: 'miss-revoked-margin',
            owner: 'miss-revoker',
            customer: world.customerId,
            percent: MARGIN,
            status: 'revoked'
        });
        insertRate(app.db, { id: 'miss-deleted', owner: world.ownerId, rate20: BASE, expiration: utcDay(10) });
        app.db.prepare(`UPDATE rates SET deleted_at = ? WHERE id = 'miss-deleted'`).run('2026-11-01T00:00:00.000Z');
        const cases = ['miss-unlinked', 'miss-revoked', 'miss-deleted', 'miss-no-such-rate'];
        const bodies = [];
        for (const rateId of cases) {
            const response = await requestBooking(world.customer, rateId);
            assert.equal(response.status, 404, rateId);
            bodies.push(response.json);
        }
        for (const body of bodies) assert.deepEqual(body, bodies[0]);
        assert.deepEqual(bodies[0], { error: 'Not found.' });
    });

    it('rejects bad slots, an unknown size, a null price, and an expired rate', async () => {
        const world = await party('bad', { rate40: null });
        const slots = [0, -1, 1.5, '3', MAX_BOOKING_SLOTS + 1];
        for (const value of slots) {
            const response = await requestBooking(world.customer, world.rateId, { slots: value });
            assert.equal(response.status, 400, `slots ${value}`);
        }
        const unknown = await requestBooking(world.customer, world.rateId, { containerSize: '45HC' });
        assert.equal(unknown.status, 400);
        const missingPrice = await requestBooking(world.customer, world.rateId, { containerSize: '40D' });
        assert.equal(missingPrice.status, 400);
        assert.match(missingPrice.json.error, /no price/);
        insertRate(app.db, {
            id: 'bad-expired',
            owner: world.ownerId,
            rate20: BASE,
            expiration: utcDay(-1)
        });
        const expired = await requestBooking(world.customer, 'bad-expired');
        assert.equal(expired.status, 400);
        assert.equal(expired.json.error, 'This rate has expired.');
    });

    it('accepts a blank expiration, a rate expiring today, a future effective date, and a zero price', async () => {
        const world = await party('open', { expiration: null, effective: utcDay(20), rate20: 0, rate40: null, rate40hc: null });
        const blank = await requestBooking(world.customer, world.rateId, { slots: 1 });
        assert.equal(blank.status, 201);
        assert.equal(blank.json.request.customerPrice, 0);
        insertRate(app.db, { id: 'open-today', owner: world.ownerId, rate20: BASE, expiration: utcDay(0) });
        const today = await requestBooking(world.customer, 'open-today', { slots: 1 });
        assert.equal(today.status, 201, JSON.stringify(today.json));
    });

    it('refuses a contract-owner request and a customer decision', async () => {
        const world = await party('role');
        const created = await requestBooking(world.customer, world.rateId, { slots: 1 });
        assert.equal(created.status, 201);
        const ownerCreate = await requestBooking(world.owner, world.rateId, { slots: 1 });
        assert.equal(ownerCreate.status, 403);
        const customerDecide = await call(app.baseUrl, world.customer, 'POST', `/api/booking-requests/${created.json.request.id}/decision`, { decision: 'approved' });
        assert.equal(customerDecide.status, 403);
        const decided = await call(app.baseUrl, world.owner, 'POST', `/api/booking-requests/${created.json.request.id}/decision`, { decision: 'approved' });
        assert.equal(decided.status, 200);
        assert.equal(decided.json.request.status, 'approved');
        assert.equal(decided.json.request.decidedBy.name, 'role Owner User');
        const customerRead = await call(app.baseUrl, world.customer, 'GET', `/api/booking-requests/${created.json.request.id}`);
        assert.equal(customerRead.status, 200);
        assert.equal(customerRead.json.request.status, 'approved');
        assertNoDecider(customerRead.json, 'role-owner-user', 'role Owner User');
        const listed = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests');
        const row = listed.json.requests.find(item => item.id === created.json.request.id);
        assertNoDecider(row, 'role-owner-user', 'role Owner User');
        const audit = app.db.prepare(`
            SELECT event_type FROM audit_events
            WHERE event_type = 'booking_request_decided' AND actor_user_id = ?
        `).get('role-owner-user');
        assert.ok(audit);
    });

    it('hides the request from a second owner, a third company, and a system admin in another context', async () => {
        const world = await party('wall');
        const created = await requestBooking(world.customer, world.rateId, { slots: 1 });
        assert.equal(created.status, 201);
        const requestId = created.json.request.id;
        addCompany('wall-owner-2', 'Wall Owner 2', COMPANY_TYPE_CONTRACT_OWNER);
        addCompany('wall-third', 'Wall Third', COMPANY_TYPE_CUSTOMER);
        addUser({ id: 'wall-owner-2-user', username: 'wall-owner-2', companyId: 'wall-owner-2', displayName: 'Other Owner' });
        addUser({ id: 'wall-third-user', username: 'wall-third', companyId: 'wall-third', displayName: 'Third Company' });
        addUser({
            id: 'wall-sys-user',
            username: 'wall-sys',
            companyId: 'wall-owner-2',
            systemAdmin: true,
            displayName: 'Wall Sys'
        });
        const otherOwner = await session('wall-owner-2');
        const third = await session('wall-third');
        const sys = await session('wall-sys');
        const context = await call(app.baseUrl, sys, 'POST', '/api/admin/context', { companyId: world.ownerId });
        assert.equal(context.status, 200);
        const paths = [
            ['GET', `/api/booking-requests/${requestId}`, undefined],
            ['POST', `/api/booking-requests/${requestId}/decision`, { decision: 'declined' }],
            ['POST', `/api/booking-requests/${requestId}/read`, {}]
        ];
        let firstBody = null;
        for (const [method, path, body] of paths) {
            const response = await call(app.baseUrl, otherOwner, method, path, body);
            assert.equal(response.status, 404, `${method} ${path}`);
            if (!firstBody) firstBody = response.json;
            assert.deepEqual(response.json, firstBody);
            const asAdmin = await call(app.baseUrl, sys, method, path, body);
            assert.equal(asAdmin.status, 404, `admin ${method}`);
            assert.deepEqual(asAdmin.json, firstBody);
        }
        const thirdList = await call(app.baseUrl, third, 'GET', '/api/booking-requests');
        assert.equal(thirdList.status, 200);
        assert.deepEqual(thirdList.json.requests, []);
        const thirdOne = await call(app.baseUrl, third, 'GET', `/api/booking-requests/${requestId}`);
        assert.equal(thirdOne.status, 404);
        assert.deepEqual(thirdOne.json, firstBody);
        const thirdUnread = await call(app.baseUrl, third, 'GET', '/api/booking-requests/unread');
        assert.equal(thirdUnread.json.unread, 0);
    });

    it('lets exactly one of two simultaneous owner decisions win', async () => {
        const world = await party('race');
        addUser({
            id: 'race-owner-b',
            username: 'race-owner-b',
            companyId: world.ownerId,
            displayName: 'Race Owner B'
        });
        const ownerB = await session('race-owner-b');
        const created = await requestBooking(world.customer, world.rateId, { slots: 4 });
        assert.equal(created.status, 201);
        const requestId = created.json.request.id;
        const [left, right] = await Promise.all([
            call(app.baseUrl, world.owner, 'POST', `/api/booking-requests/${requestId}/decision`, { decision: 'approved' }),
            call(app.baseUrl, ownerB, 'POST', `/api/booking-requests/${requestId}/decision`, { decision: 'declined' })
        ]);
        const statuses = [left.status, right.status].sort();
        assert.deepEqual(statuses, [200, 409]);
        const winner = left.status === 200 ? 'approved' : 'declined';
        const stored = app.db.prepare('SELECT status FROM booking_requests WHERE id = ?').get(requestId);
        assert.equal(stored.status, winner);
    });

    it('tracks unread per company side and a read clears only that side', async () => {
        const world = await party('bell');
        const created = await requestBooking(world.customer, world.rateId, { slots: 1 });
        const requestId = created.json.request.id;
        const ownerUnread = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        const customerUnread = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerUnread.json.unread, 1);
        assert.equal(customerUnread.json.unread, 0);
        const ownerList = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests');
        assert.equal(ownerList.json.requests[0].unread, true);
        const stillUnread = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        assert.equal(stillUnread.json.unread, 1);
        const decided = await call(app.baseUrl, world.owner, 'POST', `/api/booking-requests/${requestId}/decision`, { decision: 'declined' });
        assert.equal(decided.status, 200);
        const afterDecision = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        const customerAfter = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests/unread');
        assert.equal(afterDecision.json.unread, 1);
        assert.equal(customerAfter.json.unread, 1);
        const ownerRead = await call(app.baseUrl, world.owner, 'POST', `/api/booking-requests/${requestId}/read`, {});
        assert.equal(ownerRead.status, 200);
        assert.equal(ownerRead.json.request.unread, false);
        const ownerCleared = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        const customerStill = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerCleared.json.unread, 0);
        assert.equal(customerStill.json.unread, 1);
        const customerRead = await call(app.baseUrl, world.customer, 'POST', `/api/booking-requests/${requestId}/read`, {});
        assert.equal(customerRead.status, 200);
        const ownerStays = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        const customerCleared = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerStays.json.unread, 0);
        assert.equal(customerCleared.json.unread, 0);
        insertRate(app.db, { id: 'bell-rate-2', owner: world.ownerId, rate20: BASE, expiration: utcDay(12) });
        const second = await requestBooking(world.customer, 'bell-rate-2', { slots: 1 });
        assert.equal(second.status, 201);
        const ownerAgain = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerAgain.json.unread, 1);
        await call(app.baseUrl, world.customer, 'POST', `/api/booking-requests/${second.json.request.id}/read`, {});
        const ownerUntouched = await call(app.baseUrl, world.owner, 'GET', '/api/booking-requests/unread');
        const customerStillZero = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests/unread');
        assert.equal(ownerUntouched.json.unread, 1);
        assert.equal(customerStillZero.json.unread, 0);
    });

    it('keeps the snapshot after the rate is edited and soft-deleted', async () => {
        const world = await party('snap', { notes: 'original note', origin: 'NGB', destination: 'NYC' });
        const created = await requestBooking(world.customer, world.rateId, { slots: 3 });
        assert.equal(created.status, 201);
        const before = created.json.request;
        app.db.prepare(`
            UPDATE rates
            SET carrier = 'CHANGED', origin_port = 'NOWHERE', rate_20d = 1, rate_40d = 2, rate_40hc = 3, notes_1 = 'edited'
            WHERE id = ?
        `).run(world.rateId);
        const edited = await call(app.baseUrl, world.customer, 'GET', `/api/booking-requests/${before.id}`);
        assert.equal(edited.json.request.carrier, before.carrier);
        assert.equal(edited.json.request.originPort, before.originPort);
        assert.equal(edited.json.request.customerPrice, before.customerPrice);
        assert.equal(edited.json.request.notes, before.notes);
        app.db.prepare(`UPDATE rates SET deleted_at = ? WHERE id = ?`).run('2026-11-01T00:00:00.000Z', world.rateId);
        const gone = await call(app.baseUrl, world.owner, 'GET', `/api/booking-requests/${before.id}`);
        assert.equal(gone.status, 200);
        assert.equal(gone.json.request.carrier, before.carrier);
        assert.equal(gone.json.request.customerPrice, before.customerPrice);
        assert.equal(gone.json.request.slots, 3);
        const again = await requestBooking(world.customer, world.rateId, { slots: 1 });
        assert.equal(again.status, 404);
    });

    it('rejects a missing CSRF token and a user who must change their password', async () => {
        const world = await party('gate');
        const missing = await call(app.baseUrl, world.customer, 'POST', '/api/booking-requests', {
            rateId: world.rateId,
            containerSize: '20D',
            slots: 1
        }, { csrf: false });
        assert.equal(missing.status, 403);
        assert.match(missing.json.error, /session could not be verified/i);
        app.db.prepare(`UPDATE users SET must_change_password = 1 WHERE username = 'gate-customer'`).run();
        const blocked = await call(app.baseUrl, world.customer, 'GET', '/api/booking-requests');
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.code, 'password_change_required');
    });
});
