'use strict';

const { keccak256, stringToHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { db } = require('./db');
const { forteReceiptExplorer, forteReceiptSettings } = require('./config');

const RECEIPT_TAG = '0x524e5231';
const ALREADY_KNOWN = Symbol('already known');
const MAX_ATTEMPTS = 6;
const DEFAULT_TIMING = {
    pollMs: 2_000,
    retryMs: 5_000,
    maxRetryMs: 60_000,
    confirmationPollMs: 10_000,
    confirmationTimeoutMs: 15 * 60_000,
    rpcTimeoutMs: 5_000
};

function canonicalReceipt(row) {
    // Keep these keys in lexicographic order. This is the version 1 wire format.
    return JSON.stringify({
        carrier: row.carrier,
        containerSize: row.container_size,
        customerPrice: row.customer_price,
        decidedAt: row.decided_at,
        destinationPort: row.destination_port,
        originPort: row.origin_port,
        rateId: row.rate_id,
        requestId: row.id,
        slots: row.slots,
        status: row.status,
        version: 1
    });
}

function queueReceipt(row) {
    const hash = keccak256(stringToHex(canonicalReceipt(row)));
    db.prepare(`
        INSERT INTO booking_receipts (request_id, status, receipt_hash, next_attempt_at, created_at, updated_at)
        VALUES (?, 'pending', ?, ?, ?, ?)
    `).run(row.id, hash, Date.parse(row.decided_at), row.decided_at, row.decided_at);
}

function presentReceipt(requestId) {
    const row = db.prepare(`
        SELECT status, tx_hash, receipt_hash FROM booking_receipts WHERE request_id = ?
    `).get(requestId);
    if (!row) return null;
    return {
        status: row.status,
        txHash: row.tx_hash,
        receiptHash: row.receipt_hash,
        explorerUrl: row.tx_hash ? `${forteReceiptExplorer()}tx/${row.tx_hash}` : null
    };
}

// Only fixed local error codes cross the RPC boundary. RPC bodies, headers and
// exceptions may contain credentials, even when a message looks innocuous.
class ReceiptError extends Error {}

async function rpc(url, headers, method, params, signal, timeout) {
    let body;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error();
        }
        body = await response.json();
    } catch {
        throw new ReceiptError('rpc_unavailable');
    }
    if (body?.jsonrpc !== '2.0' || body.id !== 1) throw new ReceiptError('invalid_rpc_response');
    if (body.error) {
        if (method === 'eth_sendRawTransaction') {
            const message = typeof body.error.message === 'string' ? body.error.message : '';
            if (/^(?:already known|known transaction)(?:$|[: ])/i.test(message)) {
                return ALREADY_KNOWN;
            }
            if (/^nonce too low(?:$|[: ])/i.test(message)) throw new ReceiptError('nonce_too_low');
        }
        throw new ReceiptError('rpc_rejected');
    }
    if (!Object.hasOwn(body, 'result')) throw new ReceiptError('invalid_rpc_response');
    return body.result;
}

function quantity(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
        throw new ReceiptError('invalid_rpc_response');
    }
    return BigInt(value);
}

function updateState(row, status, attempts, error, nextAt) {
    db.prepare(`
        UPDATE booking_receipts
        SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE request_id = ?
    `).run(status, attempts, error, nextAt, new Date().toISOString(), row.request_id);
}

function nextNonce(networkNonce, address, chainId) {
    // The sequencer can lag the write endpoint. Keep accepted and in-flight
    // nonces reserved locally until the sequencer sees them.
    const { nonce } = db.prepare(`
        SELECT MAX(nonce) AS nonce FROM booking_receipts
        WHERE sender_address = ? AND chain_id = ?
            AND (status IN ('pending', 'submitted', 'confirmed') OR last_error = 'transaction_reverted')
    `).get(address, chainId);
    const chosen = Math.max(Number(networkNonce), (nonce ?? -1) + 1);
    if (!Number.isSafeInteger(chosen)) throw new ReceiptError('invalid_rpc_response');
    return chosen;
}

function startReceiptSender(timing = DEFAULT_TIMING) {
    const { privateKey, clientId, clientSecret, writeUrl, readUrl, chainId } = forteReceiptSettings();
    if (!privateKey || !clientId || !clientSecret || !writeUrl || !readUrl || !chainId) return () => {};
    let account;
    try {
        if (!/^0x[\da-f]{64}$/i.test(privateKey)) throw new Error();
        account = privateKeyToAccount(privateKey);
    } catch {
        console.error('Booking receipt sender has an invalid signing key.');
        return () => {};
    }

    const controller = new AbortController();
    const { signal } = controller;
    const read = (method, params = []) => rpc(readUrl, {}, method, params, signal, timing.rpcTimeoutMs);
    const writeHeaders = {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret
    };
    // A restart replays each previously submitted transaction once. Normal
    // confirmation polls only need to query the sequencer.
    let replay;
    let timer;

    async function checkReceipt(row) {
        const receipt = await read('eth_getTransactionReceipt', [row.tx_hash]);
        signal.throwIfAborted();
        if (receipt === null) return false;
        if (typeof receipt?.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== row.tx_hash
            || !['0x0', '0x1'].includes(receipt.status)) {
            throw new ReceiptError('invalid_rpc_response');
        }
        const successful = receipt.status === '0x1';
        updateState(row, successful ? 'confirmed' : 'failed', row.attempts, successful ? null : 'transaction_reverted', 0);
        return true;
    }

    async function verifyChain() {
        if (quantity(await read('eth_chainId')) !== BigInt(chainId)) {
            throw new ReceiptError('chain_id_mismatch');
        }
    }

    async function sign(row) {
        await verifyChain();
        const networkNonce = quantity(await read('eth_getTransactionCount', [account.address, 'pending']));
        const nonce = nextNonce(networkNonce, account.address, chainId);
        const gasPrice = quantity(await read('eth_gasPrice'));
        if (gasPrice === 0n) throw new ReceiptError('invalid_rpc_response');
        const raw = await account.signTransaction({
            type: 'eip1559',
            chainId,
            nonce,
            to: account.address,
            value: 0n,
            data: RECEIPT_TAG + row.receipt_hash.slice(2),
            // Cover the OP Stack calldata gas floor for all 36 input bytes.
            gas: 24_000n,
            maxFeePerGas: 2n * gasPrice,
            maxPriorityFeePerGas: gasPrice / 10n
        });
        signal.throwIfAborted();
        row.raw_transaction = raw;
        row.tx_hash = keccak256(raw);
        row.nonce = nonce;
        row.sender_address = account.address;
        row.chain_id = chainId;
        db.prepare(`
            UPDATE booking_receipts
            SET raw_transaction = ?, tx_hash = ?, nonce = ?, sender_address = ?, chain_id = ?, updated_at = ?
            WHERE request_id = ?
        `).run(raw, row.tx_hash, nonce, account.address, chainId, new Date().toISOString(), row.request_id);
    }

    async function broadcast(row) {
        try {
            const result = await rpc(writeUrl, writeHeaders, 'eth_sendRawTransaction', [row.raw_transaction], signal, timing.rpcTimeoutMs);
            if (result !== ALREADY_KNOWN && (typeof result !== 'string' || result.toLowerCase() !== row.tx_hash)) {
                throw new ReceiptError('invalid_rpc_response');
            }
        } catch (error) {
            if (!(error instanceof ReceiptError) || error.message !== 'nonce_too_low') throw error;
            // A missing receipt alone can reflect sequencer lag. Require a
            // finalized nonce advance and check the old hash again after it.
            await verifyChain();
            const finalized = quantity(await read('eth_getTransactionCount', [row.sender_address, 'finalized']));
            if (await checkReceipt(row)) return;
            if (finalized <= BigInt(row.nonce)) throw error;
            signal.throwIfAborted();
            // Gate re-signing on the same durable update that records the retry.
            const attempts = row.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) throw error;
            db.prepare(`
                UPDATE booking_receipts
                SET status = 'pending', raw_transaction = NULL, tx_hash = NULL, nonce = NULL,
                    sender_address = NULL, chain_id = NULL, submitted_at = NULL, attempts = ?, last_error = 'nonce_too_low',
                    next_attempt_at = ?, updated_at = ?
                WHERE request_id = ?
            `).run(attempts, Date.now() + retryDelay(attempts), new Date().toISOString(), row.request_id);
            return;
        }
        signal.throwIfAborted();
        const now = Date.now();
        db.prepare(`
            UPDATE booking_receipts SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?),
                attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ?
            WHERE request_id = ?
        `).run(now, now + timing.confirmationPollMs, new Date(now).toISOString(), row.request_id);
    }

    function retryDelay(attempts) {
        return Math.min(timing.maxRetryMs, timing.retryMs * 2 ** (attempts - 1));
    }

    async function processReceipt(row) {
        try {
            if (row.raw_transaction && row.chain_id !== chainId) throw new ReceiptError('chain_id_mismatch');
            if (row.status === 'submitted' && !replay.delete(row.request_id)) {
                if (await checkReceipt(row)) return;
                const expired = Date.now() - row.submitted_at >= timing.confirmationTimeoutMs;
                updateState(row, expired ? 'failed' : 'submitted', 0, expired ? 'confirmation_timeout' : null,
                    expired ? 0 : Date.now() + timing.confirmationPollMs);
                return;
            }
            if (row.status === 'pending') {
                if (!row.raw_transaction) await sign(row);
                else {
                    try {
                        if (await checkReceipt(row)) return;
                    } catch (error) {
                        // A read outage need not prevent rebroadcasting identical bytes.
                        if (signal.aborted || !(error instanceof ReceiptError)) throw error;
                    }
                }
            }
            await broadcast(row);
        } catch (error) {
            if (signal.aborted) return;
            const code = error instanceof ReceiptError ? error.message : 'receipt_processing_error';
            if (code === 'chain_id_mismatch') {
                updateState(row, row.status, row.attempts, code, Date.now() + timing.maxRetryMs);
                return;
            }
            const attempts = row.attempts + 1;
            const exhausted = attempts >= MAX_ATTEMPTS;
            updateState(row, exhausted ? 'failed' : row.status, attempts, code,
                exhausted ? 0 : Date.now() + retryDelay(attempts));
        }
    }

    async function poll() {
        if (signal.aborted) return;
        let delay = timing.pollMs;
        try {
            replay ??= new Set(db.prepare(`
                SELECT request_id FROM booking_receipts WHERE status = 'submitted'
            `).all().map(row => row.request_id));
            const row = db.prepare(`
                SELECT * FROM booking_receipts
                WHERE status IN ('pending', 'submitted') AND next_attempt_at <= ?
                ORDER BY next_attempt_at, created_at, request_id LIMIT 1
            `).get(Date.now());
            if (row) {
                await processReceipt(row);
                delay = 0;
            }
        } catch {
            if (!signal.aborted) console.error('Booking receipt queue could not be processed.');
        } finally {
            if (!signal.aborted) timer = setTimeout(poll, delay).unref();
        }
    }

    timer = setTimeout(poll, 0).unref();
    return () => {
        clearTimeout(timer);
        controller.abort();
    };
}

module.exports = { canonicalReceipt, queueReceipt, presentReceipt, startReceiptSender };
