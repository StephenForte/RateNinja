'use strict';

const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { FAST, fakeRpc, until } = require('./helpers/r1-40');
const { PASSWORD } = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CUSTOMER, login, call, insertCompany, insertUser, insertRate, insertMargin, activate
} = require('./helpers/r1-19');

const RATE = 'finality-fixture-rate';
const BOOKINGS = '/api/booking-requests';
const TIMING = { ...FAST, nonceConflictTimeoutMs: 60_000 };

let app;
let buyer;
let rpc;
let startReceiptSender;
let stop;

before(async () => {
    app = await startApp({ username: 'finality-owner' });
    ({ startReceiptSender } = require('../lib/booking-receipts'));
    const { db } = app;
    const buyerId = 'finality-fixture-buyer';
    insertCompany(db, { id: buyerId, name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
    insertUser(db, { id: 'finality-buyer-user', username: 'finality-buyer', companyId: buyerId });
    activate('finality-buyer', PASSWORD);
    insertMargin(db, { id: 'finality-fixture-margin', owner: app.company.id, customer: buyerId, percent: 0.1 });
    insertRate(db, { id: RATE, owner: app.company.id, rate20: 8123 });
    buyer = await login(app.baseUrl, 'finality-buyer', PASSWORD);
});

beforeEach(async () => {
    rpc = await fakeRpc();
    rpc.configure();
    rpc.state.conflictingNonce = rpc.state.nonce;
});

afterEach(async () => {
    stop?.();
    stop = null;
    await rpc?.disconnect();
});

after(async () => {
    await app?.close();
});

function receiptRow(id) {
    return app.db.prepare('SELECT * FROM booking_receipts WHERE request_id = ?').get(id);
}

function waitState(id, expected) {
    return until(() => {
        const row = receiptRow(id);
        return row.status === expected && row;
    }, `Receipt did not reach ${expected}`);
}

async function startConflict(timing = TIMING) {
    const booked = await call(app.baseUrl, buyer, 'POST', BOOKINGS, { rateId: RATE, containerSize: '20D', slots: 2 });
    assert.equal(booked.status, 201, booked.text);
    const id = booked.json.request.id;
    const approved = await call(app.baseUrl, app, 'POST', `${BOOKINGS}/${id}/decision`, { decision: 'approved' });
    assert.equal(approved.status, 200, approved.text);
    stop = startReceiptSender(timing);
    const original = await until(() => rpc.sends[0], 'Original transaction was not sent');
    rpc.state.nonce = original.nonce + 1;
    return { id, original };
}

function waitForFinality(id) {
    return until(() => {
        const row = receiptRow(id);
        return (row.last_error === 'awaiting_finality' || row.status === 'failed') && row;
    }, 'Nonce conflict was not recorded');
}

it('outlasts the retry budget on the original signature before replacing it once after finality', async () => {
    const { id, original } = await startConflict();
    const row = await until(() => {
        const current = receiptRow(id);
        // Main fails by the sixth send. On the fixed path, observe the
        // seventh wait being persisted before moving the finalized nonce.
        return (current.status === 'failed'
            || (rpc.sends.length >= 7 && current.next_attempt_at > Date.now())) && current;
    }, 'Neither exhaustion nor a seventh finality wait was recorded');

    assert.equal(row.status, 'pending', `Unexpected receipt state: ${row.last_error}, attempts=${row.attempts}`);
    assert.equal(row.last_error, 'awaiting_finality');
    assert.equal(row.attempts, 0);
    assert.equal(row.tx_hash, original.hash);
    assert.equal(row.raw_transaction, original.raw);
    assert.ok(rpc.sends.every(tx => tx.raw === original.raw));
    assert.equal(rpc.state.finalizedNonce, original.nonce);

    rpc.state.finalizedNonce = original.nonce + 1;
    const submitted = await waitState(id, 'submitted');
    assert.equal(submitted.nonce, original.nonce + 1);
    assert.notEqual(submitted.tx_hash, original.hash);
    assert.deepEqual(rpc.sends.filter(tx => tx.raw !== original.raw).map(tx => tx.hash), [submitted.tx_hash]);
    rpc.mined.set(submitted.tx_hash, '0x1');
    const confirmed = await waitState(id, 'confirmed');
    assert.equal(confirmed.tx_hash, submitted.tx_hash);
});

it('confirms the original hash if it is mined during the wait', async () => {
    const { id, original } = await startConflict();
    const waiting = await waitForFinality(id);
    assert.equal(waiting.last_error, 'awaiting_finality');
    assert.equal(waiting.next_attempt_at - Date.parse(waiting.updated_at), TIMING.maxRetryMs);
    rpc.mined.set(original.hash, '0x1');

    const confirmed = await waitState(id, 'confirmed');
    assert.equal(confirmed.tx_hash, original.hash);
    assert.equal(confirmed.raw_transaction, original.raw);
    assert.equal(confirmed.attempts, 0);
    assert.ok(rpc.sends.every(tx => tx.raw === original.raw));
});

it('times out from the first wait across a restart while finality remains behind', async () => {
    const timing = { ...TIMING, nonceConflictTimeoutMs: 450 };
    const { id, original } = await startConflict(timing);
    const waiting = await waitForFinality(id);
    assert.equal(waiting.last_error, 'awaiting_finality');
    stop();
    stop = startReceiptSender(timing);

    const failed = await waitState(id, 'failed');
    assert.equal(failed.last_error, 'nonce_conflict_timeout');
    assert.ok(Date.parse(failed.updated_at) - Date.parse(waiting.updated_at) >= timing.nonceConflictTimeoutMs);
    assert.equal(failed.attempts, 0);
    assert.equal(failed.tx_hash, original.hash);
    assert.equal(failed.raw_transaction, original.raw);
    assert.equal(rpc.state.finalizedNonce, original.nonce);
    assert.ok(rpc.sends.length > 1);
    assert.ok(rpc.sends.every(tx => tx.raw === original.raw));
});
