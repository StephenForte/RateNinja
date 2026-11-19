'use strict';

const assert = require('node:assert/strict');
const { before, after, afterEach, it } = require('node:test');
const { keccak256, recoverTransactionAddress, stringToHex } = require('viem');
const { startApp } = require('./helpers/app');
const { FAST, fakeRpc, until } = require('./helpers/r1-40');
const { PASSWORD, REDIRECT_URI, authorizeAndToken, mcpCall } = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CUSTOMER, login, call, insertCompany, insertUser, insertRate, insertMargin, activate
} = require('./helpers/r1-19');
const { partnerSend, assertNoBase } = require('./helpers/r1-21');

const BASE = 8123;
const RATE = 'receipt-fixture-rate';
const PARTNER = '/api/partner/v1/me/booking-requests';
const WEBSITE = '/api/booking-requests';

let app;
let rpc;
let owner;
let buyer;
let ownerToken;
let buyerToken;
let startReceiptSender;
let canonicalReceipt;
let stop;

before(async () => {
    rpc = await fakeRpc();
    rpc.configure();
    process.env.PARTNER_OAUTH_ENABLED = 'true';
    app = await startApp({ companyName: 'Synthetic Owner', username: 'receipt-owner' });
    ({ startReceiptSender, canonicalReceipt } = require('../lib/booking-receipts'));
    const { db } = app;
    const buyerId = 'receipt-fixture-buyer';
    insertCompany(db, { id: buyerId, name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
    insertUser(db, { id: 'receipt-buyer-user', username: 'receipt-buyer', companyId: buyerId });
    activate('receipt-buyer', PASSWORD);
    db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
    insertMargin(db, { id: 'receipt-fixture-margin', owner: app.company.id, customer: buyerId, percent: 0.1 });
    insertRate(db, { id: RATE, owner: app.company.id, rate20: BASE });
    owner = { cookie: app.cookie, csrf: app.csrf };
    buyer = await login(app.baseUrl, 'receipt-buyer', PASSWORD);
    const registered = await call(app.baseUrl, owner, 'POST', '/api/admin/oauth-clients', {
        displayName: 'Receipt test client',
        clientType: 'confidential',
        redirectUris: [REDIRECT_URI],
        allowedScopes: ['bookings:read', 'bookings:write']
    });
    assert.equal(registered.status, 201, registered.text);
    const issue = session => authorizeAndToken({
        baseUrl: app.baseUrl, ...session, clientId: registered.json.client.id,
        clientSecret: registered.json.clientSecret, scope: 'bookings:read bookings:write'
    });
    ownerToken = (await issue(owner)).access_token;
    buyerToken = (await issue(buyer)).access_token;
});

afterEach(() => {
    stop?.();
    stop = null;
    rpc.configure();
    rpc.state.chainId = '0x354';
    rpc.state.writeFailure = null;
});

after(async () => {
    await app?.close();
    await rpc?.disconnect();
});

function start(timing = FAST) {
    stop = startReceiptSender(timing);
}

function receiptRow(id) {
    return app.db.prepare('SELECT * FROM booking_receipts WHERE request_id = ?').get(id);
}

function waitState(id, expected) {
    return until(() => {
        const row = receiptRow(id);
        return row?.status === expected && row;
    }, `Receipt ${id} did not reach ${expected}`);
}

async function book() {
    const result = await call(app.baseUrl, buyer, 'POST', WEBSITE, { rateId: RATE, containerSize: '20D', slots: 2 });
    assert.equal(result.status, 201, result.text);
    assert.equal(result.json.request.receipt, undefined);
    return result.json.request.id;
}

async function decide(id, surface = 'website', decision = 'approved') {
    if (surface === 'website') {
        const result = await call(app.baseUrl, owner, 'POST', `${WEBSITE}/${id}/decision`, { decision });
        return { status: result.status, record: result.json.request };
    }
    if (surface === 'api') {
        const result = await partnerSend(app.baseUrl, ownerToken, 'POST', `${PARTNER}/${id}/decision`, { body: { decision } });
        return { status: result.status, record: result.body.data };
    }
    const result = await mcpCall(app.baseUrl, ownerToken, 'tools/call', {
        name: 'rateninja_decide_booking_request',
        arguments: { requestId: id, decision }
    });
    assert.equal(result.body.result.isError, false, result.text);
    return { status: result.status, record: result.body.result.structuredContent.data };
}

function assertPending(result) {
    assert.equal(result.status, 200);
    assert.equal(result.record.status, 'approved');
    assert.equal(result.record.receipt.status, 'pending');
    assert.equal(result.record.receipt.txHash, null);
    assert.equal(result.record.receipt.explorerUrl, null);
    assertNoBase(assert, result, BASE);
}

function buyerHash(record) {
    const { id, rateId, status, containerSize, slots, customerPrice, originPort, destinationPort, carrier, decidedAt } = record;
    const fields = { version: 1, requestId: id, rateId, status, containerSize, slots, customerPrice, originPort, destinationPort, carrier, decidedAt };
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map(key => [key, fields[key]])));
    return keccak256(stringToHex(canonical));
}

it('queues website, partner and MCP approvals and publishes independently verifiable receipts to the buyer', async () => {
    const ids = await Promise.all([book(), book(), book()]);
    const beforeSends = rpc.sends.length;
    for (const [i, surface] of ['website', 'api', 'mcp'].entries()) {
        assertPending(await decide(ids[i], surface));
        assert.equal(receiptRow(ids[i]).status, 'pending');
        assert.throws(() => app.db.prepare(`
            INSERT INTO booking_receipts (request_id, status, receipt_hash, created_at, updated_at)
            SELECT request_id, status, receipt_hash, created_at, updated_at
            FROM booking_receipts WHERE request_id = ?
        `).run(ids[i]), /UNIQUE constraint failed/);
    }

    start();
    const submitted = await Promise.all(ids.map(id => waitState(id, 'submitted')));
    const sent = rpc.sends.slice(beforeSends);
    assert.equal(sent.length, ids.length);
    assert.deepEqual(sent.map(tx => tx.nonce), [5, 6, 7]);
    for (const row of submitted) {
        const tx = sent.find(tx => tx.hash === row.tx_hash);
        assert.equal(tx.raw, row.raw_transaction);
        assert.equal(tx.type, 'eip1559');
        assert.equal(tx.chainId, 852);
        assert.equal(tx.value ?? 0n, 0n);
        assert.equal(tx.to.toLowerCase(), rpc.wallet.toLowerCase());
        assert.equal(await recoverTransactionAddress({ serializedTransaction: tx.raw }), rpc.wallet);

        const record = await partnerSend(app.baseUrl, buyerToken, 'GET', `${PARTNER}/${row.request_id}`);
        assert.equal(record.status, 200, record.text);
        const hash = buyerHash(record.body.data);
        assert.equal(record.body.data.receipt.receiptHash, hash);
        assert.equal(tx.data, `0x524e5231${hash.slice(2)}`);
        assert.deepEqual(record.body.data.receipt, {
            status: 'submitted', txHash: tx.hash, receiptHash: hash, explorerUrl: `${rpc.base}/explorer/tx/${tx.hash}`
        });
        assertNoBase(assert, record.body, BASE);
        rpc.mined.set(tx.hash, '0x1');
    }
    await Promise.all(ids.map(id => waitState(id, 'confirmed')));
    const website = await call(app.baseUrl, buyer, 'GET', WEBSITE);
    assert.equal(website.status, 200);
    for (const row of submitted) {
        const booking = website.json.requests.find(record => record.id === row.request_id);
        assert.equal(booking.receipt.status, 'confirmed');
        assert.equal(booking.receipt.txHash, row.tx_hash);
        assert.equal(booking.receipt.explorerUrl, `${rpc.base}/explorer/tx/${row.tx_hash}`);
    }
    assertNoBase(assert, website.json, BASE);
    assert.ok(rpc.calls.some(call => call.write));
    assert.ok(rpc.calls.every(call => call.write ? call.access : !call.accessPresent));
});

it('decline queues nothing; concurrent approvals have one winner, one row and one send', async () => {
    start();
    const startCalls = rpc.calls.length;
    const declined = await book();
    const decision = await decide(declined, 'website', 'declined');
    assert.equal(decision.status, 200);
    assert.equal(decision.record.receipt, undefined);
    assert.equal(receiptRow(declined), undefined);
    await new Promise(resolve => setTimeout(resolve, FAST.pollMs * 4));
    assert.equal(rpc.calls.length, startCalls);

    const id = await book();
    const startSends = rpc.sends.length;
    const results = await Promise.all([decide(id), decide(id, 'api')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assertPending(results.find(result => result.status === 200));
    const row = await waitState(id, 'submitted');
    rpc.mined.set(row.tx_hash, '0x1');
    await waitState(id, 'confirmed');
    assert.equal(rpc.sends.length, startSends + 1);
});

it('rolls back the approval when its receipt cannot be written', async () => {
    const id = await book();
    app.db.exec(`
        CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON booking_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END;
    `);
    try {
        const result = await decide(id);
        assert.equal(result.status, 500);
        assert.equal(receiptRow(id), undefined);
        const booking = app.db.prepare('SELECT status, decided_at FROM booking_requests WHERE id = ?').get(id);
        assert.equal(booking.status, 'pending');
        assert.equal(booking.decided_at, null);
        assert.equal(app.db.prepare(`
            SELECT COUNT(*) AS count FROM audit_events
            WHERE event_type = 'booking_request_decided' AND detail LIKE ?
        `).get(`%${id}%`).count, 0);
    } finally {
        app.db.exec('DROP TRIGGER reject_receipt');
    }
});

it('replays the exact persisted transaction after sender restart and accepts already known', async () => {
    const id = await book();
    assertPending(await decide(id));
    start();
    const row = await waitState(id, 'submitted');
    stop();
    const sends = rpc.sends.length;

    start();
    await until(() => rpc.sends.length === sends + 1, 'Persisted transaction was not replayed');
    assert.equal(rpc.sends.at(-1).raw, row.raw_transaction);
    assert.equal(rpc.sends.at(-1).hash, row.tx_hash);
    rpc.mined.set(row.tx_hash, '0x1');
    await waitState(id, 'confirmed');
});

it('recovers from a disconnected RPC while each approval surface still succeeds', async () => {
    const ids = await Promise.all([book(), book(), book()]);
    await rpc.disconnect();
    start({ ...FAST, retryMs: 100, maxRetryMs: 300 });
    try {
        for (const [i, surface] of ['website', 'api', 'mcp'].entries()) {
            assertPending(await decide(ids[i], surface));
        }
        await until(() => ids.every(id => receiptRow(id).last_error === 'rpc_unavailable'), 'Outage was not recorded');
    } finally {
        await rpc.reconnect();
    }
    for (const id of ids) {
        const row = await waitState(id, 'submitted');
        rpc.mined.set(row.tx_hash, '0x1');
    }
    await Promise.all(ids.map(id => waitState(id, 'confirmed')));
});

for (const failure of ['500', 'timeout', 'echo']) {
    it(`bounds retries when the write RPC returns ${failure}, preserving one signature and omitting secrets`, async t => {
        rpc.state.writeFailure = failure;
        const logs = [];
        t.mock.method(console, 'error', (...args) => logs.push(args));
        t.mock.method(console, 'warn', (...args) => logs.push(args));
        t.mock.method(console, 'log', (...args) => logs.push(args));

        const sends = rpc.sends.length;
        const id = await book();
        start();
        const approved = await decide(id, 'api');
        assertPending(approved);
        const row = await waitState(id, 'failed');
        assert.equal(row.attempts, 6);
        assert.equal(row.last_error, failure === 'echo' ? 'rpc_rejected' : 'rpc_unavailable');
        assert.equal(rpc.sends.length - sends, 6);
        assert.ok(rpc.sends.slice(sends).every(tx => tx.raw === row.raw_transaction && tx.hash === row.tx_hash));
        const response = await partnerSend(app.baseUrl, buyerToken, 'GET', `${PARTNER}/${id}`);
        assert.equal(response.body.data.receipt.status, 'failed');

        const tables = app.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        const snapshots = tables.map(({ name }) => app.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
        const output = JSON.stringify([approved, response, logs, snapshots]);
        for (const secret of rpc.secrets) assert.equal(output.includes(secret), false);
        // The fake sequencer deliberately lags local accepted nonces. Simulate
        // its wallet state overtaking the failed, unaccepted nonce for the next test.
        rpc.state.nonce = row.nonce + 1;
    });
}

it('records a reverted receipt as failed without replacing the signed transaction', async () => {
    const id = await book();
    assertPending(await decide(id));
    start();
    const row = await waitState(id, 'submitted');
    rpc.mined.set(row.tx_hash, '0x0');
    const failed = await waitState(id, 'failed');
    assert.equal(failed.last_error, 'transaction_reverted');
    assert.equal(failed.tx_hash, row.tx_hash);
});

it('waits without RPC when unconfigured and leaves a mismatched chain unsigned and pending', async () => {
    rpc.configure(false);
    const id = await book();
    assertPending(await decide(id));
    const startCalls = rpc.calls.length;
    start();
    await new Promise(resolve => setTimeout(resolve, FAST.pollMs * 4));
    assert.equal(rpc.calls.length, startCalls);
    assert.equal(receiptRow(id).status, 'pending');
    stop();

    rpc.configure();
    rpc.state.chainId = '0x1';
    start();
    await until(() => receiptRow(id).last_error === 'chain_id_mismatch', 'Wrong chain was not recorded');
    assert.equal(receiptRow(id).status, 'pending');
    assert.equal(receiptRow(id).raw_transaction, null);
    assert.equal(receiptRow(id).attempts, 0);
    assert.ok(rpc.calls.slice(startCalls).every(call => call.method === 'eth_chainId'));
    rpc.state.chainId = '0x354';
    const row = await waitState(id, 'submitted');
    rpc.mined.set(row.tx_hash, '0x1');
    await waitState(id, 'confirmed');
});

it('keeps the original signature through nonce conflicts until finalized nonce advance proves it unusable', async () => {
    const id = await book();
    assertPending(await decide(id));
    const startSends = rpc.sends.length;
    rpc.state.writeFailure = 'nonce';
    rpc.state.finalizedNonce = 5;
    start();
    const original = await until(() => rpc.sends[startSends + 1], 'Nonce conflict did not retry');
    assert.equal(original.raw, rpc.sends[startSends].raw);
    assert.equal(receiptRow(id).raw_transaction, original.raw);
    rpc.state.nonce = original.nonce + 1;
    rpc.state.finalizedNonce = original.nonce + 1;
    await until(() => receiptRow(id).raw_transaction === null, 'Unusable nonce was not released');
    rpc.state.writeFailure = null;
    const row = await waitState(id, 'submitted');
    assert.equal(row.nonce, original.nonce + 1);
    assert.notEqual(row.tx_hash, original.hash);
    rpc.mined.set(row.tx_hash, '0x1');
    await waitState(id, 'confirmed');
});

it('preserves the original hash when nonce-too-low replay finds its mined transaction', async () => {
    const id = await book();
    assertPending(await decide(id));
    start();
    const submitted = await waitState(id, 'submitted');
    stop();
    const sends = rpc.sends.length;
    rpc.state.writeFailure = 'nonce';
    rpc.state.finalizedNonce = submitted.nonce + 1;
    rpc.mined.set(submitted.tx_hash, '0x1');
    start();
    const confirmed = await waitState(id, 'confirmed');
    assert.equal(confirmed.tx_hash, submitted.tx_hash);
    assert.equal(rpc.sends.length, sends + 1);
    assert.equal(rpc.sends.at(-1).raw, submitted.raw_transaction);
});

it('binds each version 1 field to the canonical digest while ignoring the base price', () => {
    const row = {
        id: '1', rate_id: 'r', status: 'approved', container_size: '20D', slots: 2,
        customer_price: 9000, origin_port: null, destination_port: 'LAX', carrier: '合成',
        decided_at: '2026-11-19T13:14:15.000Z', base_price: BASE
    };
    const hash = row => keccak256(stringToHex(canonicalReceipt(row)));
    assert.equal(canonicalReceipt(row), '{"carrier":"合成","containerSize":"20D","customerPrice":9000,"decidedAt":"2026-11-19T13:14:15.000Z","destinationPort":"LAX","originPort":null,"rateId":"r","requestId":"1","slots":2,"status":"approved","version":1}');
    assert.equal(hash({ ...row }), hash(row));
    assert.equal(hash({ ...row, base_price: 1 }), hash(row));
    for (const [key, value] of Object.entries(row)) {
        if (key === 'base_price') continue;
        assert.notEqual(hash({ ...row, [key]: typeof value === 'number' ? value + 1 : 'different' }), hash(row), key);
    }
    assert.notEqual(keccak256(stringToHex(canonicalReceipt(row).replace('"version":1', '"version":2'))), hash(row));
});
