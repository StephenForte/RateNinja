'use strict';

const assert = require('node:assert/strict');
const { before, after, beforeEach, it } = require('node:test');
const { keccak256, stringToHex } = require('viem');
const { startApp } = require('./helpers/app');
const { fakeReadRpc } = require('./helpers/r1-51');
const {
    COMPANY_TYPE_CUSTOMER, PASSWORD, login, call, insertCompany, insertUser, activate
} = require('./helpers/r1-19');

const REQUEST_ID = 'r151-fixed-request';
const CANONICAL = '{"carrier":"Evergreen","containerSize":"40HC","customerPrice":2468,"decidedAt":"2026-11-19T15:04:05.000Z","destinationPort":"USLAX","originPort":"CNSHA","rateId":"rate-r151-fixed","requestId":"r151-fixed-request","slots":3,"status":"approved","version":1}';
const HASH = '0x0a3bfcaf99fdd0eac1d1cacc9e0b064508f365f640a8fa5c1e50cb870fdc653c';
const TX = '0x8f3af98a3d2be38078f64d4ae85c6270ca5f3051f47ef5b2db07042107412f3b';
const SENDER = '0xf8b8b3b58ebac9fc530d9244c22f391e90cc8ae2';
const EXPLORER = `https://explorer.example/fortel2/tx/${TX}`;

let app;
let rpc;
let INPUT;
let customer;
let outsider;
let owner;

before(async () => {
    process.env.FORTEL2_RECEIPT_PRIVATE_KEY = '';
    process.env.FORTEL2_CF_ACCESS_CLIENT_ID = '';
    process.env.FORTEL2_CF_ACCESS_CLIENT_SECRET = '';
    rpc = await fakeReadRpc();
    process.env.FORTEL2_READ_RPC_URL = rpc.url;
    process.env.FORTEL2_CHAIN_ID = '852';
    process.env.FORTEL2_EXPLORER_URL = 'https://explorer.example/fortel2/';
    app = await startApp({ companyName: 'Synthetic Owner', username: 'r151-owner' });
    const { RECEIPT_TAG } = require('../lib/booking-receipts');
    assert.equal(RECEIPT_TAG, '0x524e5231');
    INPUT = RECEIPT_TAG + HASH.slice(2);
    const db = app.db;
    const buyerId = 'r151-buyer';
    const otherId = 'r151-other';
    insertCompany(db, { id: buyerId, name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
    insertCompany(db, { id: otherId, name: 'Synthetic Outsider', type: COMPANY_TYPE_CUSTOMER });
    insertUser(db, { id: 'r151-buyer-user', username: 'r151-buyer-user', companyId: buyerId, displayName: 'Buyer' });
    insertUser(db, { id: 'r151-other-user', username: 'r151-other-user', companyId: otherId, displayName: 'Outsider' });
    activate('r151-buyer-user', PASSWORD);
    activate('r151-other-user', PASSWORD);
    customer = await login(app.baseUrl, 'r151-buyer-user', PASSWORD);
    outsider = await login(app.baseUrl, 'r151-other-user', PASSWORD);
    owner = { cookie: app.cookie, csrf: app.csrf };
    insertRequest({
        id: REQUEST_ID,
        status: 'approved',
        slots: 3,
        carrier: 'Evergreen',
        decidedAt: '2026-11-19T15:04:05.000Z'
    });
    insertReceipt(REQUEST_ID, { status: 'confirmed', hash: HASH, tx: TX });
    insertRequest({ id: 'r151-pending', status: 'pending', slots: 1, carrier: 'Pending Line', decidedAt: null });
    insertRequest({ id: 'r151-declined', status: 'declined', slots: 1, carrier: 'Hidden Carrier', decidedAt: '2026-11-19T15:04:05.000Z' });
    insertReceipt('r151-declined', { status: 'confirmed', hash: HASH, tx: TX });
    insertRequest({ id: 'r151-approved-bare', status: 'approved', slots: 1, carrier: 'No Receipt', decidedAt: '2026-11-19T15:04:05.000Z' });
});

after(async () => {
    await app?.close();
    await rpc?.disconnect();
});

beforeEach(() => {
    restoreFixed();
    armRpc();
});

function ownerId() {
    return app.db.prepare('SELECT id FROM users WHERE username = ?').get(app.username).id;
}

function insertRequest({ id, status, slots, carrier, decidedAt }) {
    app.db.prepare(`
        INSERT INTO booking_requests (
            id, rate_id, status, container_size, slots, customer_price,
            carrier, origin_port, destination_port,
            requesting_user_id, requesting_user_name, requesting_company_id, owner_company_id,
            created_at, decided_at, decided_by_user_id, decided_by_user_name
        ) VALUES (?, 'rate-r151-fixed', ?, '40HC', ?, 2468, ?, 'CNSHA', 'USLAX', ?, 'Buyer', 'r151-buyer', ?, '2026-11-19T15:00:00.000Z', ?, ?, ?)
    `).run(
        id, status, slots, carrier, 'r151-buyer-user', app.company.id, decidedAt,
        decidedAt ? ownerId() : null, decidedAt ? 'Owner' : null
    );
}

function insertReceipt(requestId, { status, hash, tx }) {
    app.db.prepare(`
        INSERT INTO booking_receipts (
            request_id, status, receipt_hash, tx_hash, sender_address, chain_id,
            next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 852, 0, '2026-11-19T15:04:05.000Z', '2026-11-19T15:04:05.000Z')
    `).run(requestId, status, hash, tx, SENDER);
}

function restoreFixed() {
    app.db.prepare(`
        UPDATE booking_requests
        SET slots = 3, carrier = 'Evergreen', status = 'approved', decided_at = '2026-11-19T15:04:05.000Z'
        WHERE id = ?
    `).run(REQUEST_ID);
    app.db.prepare(`
        UPDATE booking_receipts
        SET status = 'confirmed', receipt_hash = ?, tx_hash = ?, sender_address = ?, chain_id = 852
        WHERE request_id = ?
    `).run(HASH, TX, SENDER, REQUEST_ID);
    process.env.FORTEL2_READ_RPC_URL = rpc.url;
    process.env.FORTEL2_CHAIN_ID = '852';
}

function armRpc() {
    rpc.calls.length = 0;
    rpc.state.mode = 'ok';
    rpc.state.tx = { from: SENDER, chainId: '0x354', input: INPUT };
    rpc.state.receipt = { status: '0x1', transactionHash: TX };
}

function receiptPath(id = REQUEST_ID) {
    return `/api/booking-requests/${id}/receipt`;
}

function readReceipt(session, id = REQUEST_ID) {
    return call(app.baseUrl, session, 'GET', receiptPath(id));
}

it('shows the receipt to the customer and the owner, and hides it from everyone else', async () => {
    for (const session of [customer, owner]) {
        const result = await readReceipt(session);
        assert.equal(result.status, 200, result.text);
        assert.equal(result.json.check.state, 'verified');
        assert.equal(result.json.canonicalText, CANONICAL);
    }
    const hidden = await readReceipt(outsider);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.text.includes('Evergreen'), false);
    assert.equal(hidden.text.includes(HASH), false);
    assert.equal(hidden.text.includes(rpc.token), false);
    for (const id of ['r151-pending', 'r151-declined', 'r151-approved-bare', 'missing-request']) {
        const result = await readReceipt(customer, id);
        assert.equal(result.status, 404, id);
        assert.equal(result.text.includes('Hidden Carrier'), false);
        assert.equal(result.text.includes(HASH), false);
    }
    const anonymous = await call(app.baseUrl, null, 'GET', receiptPath());
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.text.includes(HASH), false);
    assert.equal(anonymous.text.includes(rpc.token), false);
});

it('returns the pinned canonical text and the hash of that text', async () => {
    const result = await readReceipt(customer);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.canonicalText, CANONICAL);
    assert.equal(keccak256(stringToHex(result.json.canonicalText)), result.json.receiptHash);
    assert.equal(result.json.receiptHash, HASH);
    assert.equal(result.json.txHash, TX);
    assert.equal(result.json.explorerUrl, EXPLORER);
    assert.equal(result.json.status, 'confirmed');
    assert.deepEqual(result.json.fields, {
        carrier: 'Evergreen',
        containerSize: '40HC',
        customerPrice: 2468,
        decidedAt: '2026-11-19T15:04:05.000Z',
        destinationPort: 'USLAX',
        originPort: 'CNSHA',
        rateId: 'rate-r151-fixed',
        requestId: REQUEST_ID,
        slots: 3,
        status: 'approved',
        version: 1
    });
    const detail = await call(app.baseUrl, customer, 'GET', `/api/booking-requests/${REQUEST_ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.request.canonicalText, undefined);
    assert.equal(detail.json.request.check, undefined);
    assert.deepEqual(Object.keys(detail.json.request.receipt).sort(), ['explorerUrl', 'receiptHash', 'status', 'txHash']);
    const listed = await call(app.baseUrl, customer, 'GET', '/api/booking-requests');
    const row = listed.json.requests.find(item => item.id === REQUEST_ID);
    assert.equal(row.canonicalText, undefined);
    assert.deepEqual(Object.keys(row.receipt).sort(), ['explorerUrl', 'receiptHash', 'status', 'txHash']);
});

it('verifies a transaction that carries the rebuilt hash from the stored sender', async () => {
    rpc.state.tx.from = SENDER.toUpperCase();
    rpc.state.tx.chainId = '0x0354';
    rpc.state.tx.input = INPUT.toUpperCase();
    rpc.state.receipt.status = '0X1';
    const result = await readReceipt(owner);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json.check, { state: 'verified' });
    assert.deepEqual(rpc.calls, ['eth_getTransactionByHash', 'eth_getTransactionReceipt']);
});

it('verifies a submitted receipt the same way', async () => {
    app.db.prepare(`UPDATE booking_receipts SET status = 'submitted' WHERE request_id = ?`).run(REQUEST_ID);
    const result = await readReceipt(customer);
    assert.equal(result.json.check.state, 'verified');
    assert.equal(result.json.status, 'submitted');
});

it('reports a hash mismatch from the stored request without calling ForteL2', async () => {
    app.db.prepare(`UPDATE booking_requests SET slots = 4 WHERE id = ?`).run(REQUEST_ID);
    const result = await readReceipt(customer);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json.check, { state: 'mismatch', part: 'hash' });
    assert.match(result.json.canonicalText, /"slots":4/);
    assert.notEqual(keccak256(stringToHex(result.json.canonicalText)), result.json.receiptHash);
    assert.equal(rpc.calls.length, 0);
});

it('reports an input mismatch from the transaction', async () => {
    rpc.state.tx.input = `0x524e5231${'ab'.repeat(32)}`;
    const result = await readReceipt(customer);
    assert.deepEqual(result.json.check, { state: 'mismatch', part: 'input' });
});

it('reports a sender mismatch from the transaction', async () => {
    rpc.state.tx.from = '0x0000000000000000000000000000000000000001';
    const result = await readReceipt(customer);
    assert.deepEqual(result.json.check, { state: 'mismatch', part: 'sender' });
});

it('reports a chain mismatch from the transaction', async () => {
    rpc.state.tx.chainId = '0x1';
    const result = await readReceipt(customer);
    assert.deepEqual(result.json.check, { state: 'mismatch', part: 'chain' });
});

it('reports a reverted transaction as a status mismatch', async () => {
    rpc.state.receipt.status = '0x0';
    const result = await readReceipt(customer);
    assert.deepEqual(result.json.check, { state: 'mismatch', part: 'status' });
});

it('says a receipt is not on chain when it has not been submitted or the node has no transaction', async () => {
    app.db.prepare(`UPDATE booking_receipts SET status = 'pending', tx_hash = NULL WHERE request_id = ?`).run(REQUEST_ID);
    const pending = await readReceipt(customer);
    assert.deepEqual(pending.json.check, { state: 'not_on_chain' });
    assert.equal(pending.json.txHash, null);
    assert.equal(pending.json.explorerUrl, null);
    assert.equal(rpc.calls.length, 0);

    restoreFixed();
    armRpc();
    app.db.prepare(`UPDATE booking_receipts SET status = 'failed' WHERE request_id = ?`).run(REQUEST_ID);
    const failed = await readReceipt(customer);
    assert.deepEqual(failed.json.check, { state: 'not_on_chain' });
    assert.equal(rpc.calls.length, 0);

    restoreFixed();
    armRpc();
    rpc.state.tx = null;
    const missingTx = await readReceipt(customer);
    assert.deepEqual(missingTx.json.check, { state: 'not_on_chain' });

    rpc.state.tx = { from: SENDER, chainId: '0x354', input: INPUT };
    rpc.state.receipt = null;
    const missingReceipt = await readReceipt(customer);
    assert.deepEqual(missingReceipt.json.check, { state: 'not_on_chain' });
});

it('says the check is unavailable when the read RPC is down or unset', async () => {
    rpc.state.mode = 'http';
    const down = await readReceipt(customer);
    assert.equal(down.status, 200, down.text);
    assert.deepEqual(down.json.check, { state: 'unavailable' });
    assert.equal(down.text.includes(rpc.token), false);

    rpc.state.mode = 'reject';
    rpc.calls.length = 0;
    const rejected = await readReceipt(customer);
    assert.deepEqual(rejected.json.check, { state: 'unavailable' });
    assert.equal(rejected.text.includes(rpc.token), false);

    process.env.FORTEL2_READ_RPC_URL = 'http://r151-user:r151-pass@127.0.0.1/secret-rpc';
    rpc.calls.length = 0;
    const unset = await readReceipt(customer);
    assert.deepEqual(unset.json.check, { state: 'unavailable' });
    assert.equal(unset.text.includes('r151-pass'), false);
    assert.equal(unset.text.includes(rpc.token), false);
    assert.equal(rpc.calls.length, 0);
});
