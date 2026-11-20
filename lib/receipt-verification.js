'use strict';

const {
    RECEIPT_TAG,
    ReceiptError,
    canonicalReceipt,
    hashReceiptText,
    rpc
} = require('./booking-receipts');
const { forteReceiptExplorer, forteReceiptSettings } = require('./config');

// Same budget the receipt sender uses for a read. Results are not cached:
// each details request reads ForteL2 again.
const RPC_TIMEOUT_MS = 5_000;

function check(state, part) {
    return part ? { state, part } : { state };
}

function present(row, receipt, result) {
    const canonicalText = canonicalReceipt(row);
    const txHash = receipt.tx_hash || null;
    return {
        fields: JSON.parse(canonicalText),
        canonicalText,
        receiptHash: receipt.receipt_hash,
        txHash,
        explorerUrl: txHash ? `${forteReceiptExplorer()}tx/${txHash}` : null,
        status: receipt.status,
        check: result
    };
}

function hexQuantity(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
    return BigInt(value);
}

async function readChain(receipt) {
    const { readUrl, chainId } = forteReceiptSettings();
    if (!readUrl || !chainId) return check('unavailable');
    let tx;
    let chainReceipt;
    try {
        // Each read gets its own 5s budget. One shared timer would let a slow
        // transaction lookup abort the receipt lookup.
        const read = (method) => rpc(
            readUrl.href, {}, method, [receipt.tx_hash], AbortSignal.timeout(RPC_TIMEOUT_MS), RPC_TIMEOUT_MS
        );
        tx = await read('eth_getTransactionByHash');
        chainReceipt = await read('eth_getTransactionReceipt');
    } catch (error) {
        if (error instanceof ReceiptError) return check('unavailable');
        throw error;
    }
    if (tx === null || chainReceipt === null) return check('not_on_chain');
    if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return check('unavailable');
    if (!chainReceipt || typeof chainReceipt !== 'object' || Array.isArray(chainReceipt)) return check('unavailable');
    const echoed = typeof chainReceipt.transactionHash === 'string' ? chainReceipt.transactionHash.toLowerCase() : '';
    if (echoed !== String(receipt.tx_hash).toLowerCase()) return check('unavailable');

    const from = typeof tx.from === 'string' ? tx.from.toLowerCase() : '';
    const sender = typeof receipt.sender_address === 'string' ? receipt.sender_address.toLowerCase() : '';
    if (!from || from !== sender) return check('mismatch', 'sender');

    const seenChain = hexQuantity(tx.chainId);
    if (seenChain === null || seenChain !== BigInt(chainId)) return check('mismatch', 'chain');

    const status = typeof chainReceipt.status === 'string' ? chainReceipt.status.toLowerCase() : '';
    if (status !== '0x1') return check('mismatch', 'status');

    const expected = (RECEIPT_TAG + receipt.receipt_hash.slice(2)).toLowerCase();
    const input = typeof tx.input === 'string' ? tx.input.toLowerCase() : '';
    if (input !== expected) return check('mismatch', 'input');
    return check('verified');
}

async function verifyReceipt(row, receipt) {
    const rebuilt = hashReceiptText(canonicalReceipt(row));
    const stored = typeof receipt.receipt_hash === 'string' ? receipt.receipt_hash.toLowerCase() : '';
    if (rebuilt.toLowerCase() !== stored) return present(row, receipt, check('mismatch', 'hash'));
    if (!['submitted', 'confirmed'].includes(receipt.status) || !receipt.tx_hash) {
        return present(row, receipt, check('not_on_chain'));
    }
    return present(row, receipt, await readChain(receipt));
}

module.exports = { verifyReceipt, RPC_TIMEOUT_MS };
