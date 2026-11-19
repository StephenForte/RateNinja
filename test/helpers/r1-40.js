'use strict';

const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { keccak256, parseTransaction } = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

const FAST = {
    pollMs: 10, retryMs: 25, maxRetryMs: 100, confirmationPollMs: 40,
    confirmationTimeoutMs: 5_000, rpcTimeoutMs: 200
};

async function fakeRpc() {
    const privateKey = generatePrivateKey();
    const clientId = randomUUID();
    const clientSecret = randomUUID();
    const calls = [];
    const sends = [];
    const mined = new Map();
    const accepted = new Set();
    const state = { chainId: '0x354', nonce: 5, finalizedNonce: 5, writeFailure: null };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { id, method, params } = JSON.parse(Buffer.concat(chunks));
        const write = request.url === '/write';
        const headers = request.headers;
        calls.push({ method, params, write, access: headers['cf-access-client-id'] === clientId
            && headers['cf-access-client-secret'] === clientSecret,
        accessPresent: Boolean(headers['cf-access-client-id'] || headers['cf-access-client-secret']) });
        function respond(result) {
            response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        }
        function reject(message) {
            response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
        }
        if (write && method === 'eth_sendRawTransaction') {
            const [raw] = params;
            const hash = keccak256(raw);
            const tx = parseTransaction(raw);
            sends.push({ raw, hash, ...tx });
            const bytes = Buffer.from(tx.data.slice(2), 'hex');
            const floor = bytes.reduce((gas, byte) => gas + (byte === 0 ? 10n : 40n), 21_000n);
            if (tx.gas < floor) return reject('calldata gas floor not met');
            if (state.writeFailure === 'timeout') return;
            if (state.writeFailure === '500') {
                response.statusCode = 500;
                return response.end();
            }
            if (state.writeFailure === 'echo') {
                return reject(JSON.stringify({ headers, echoedSyntheticKey: privateKey }));
            }
            if (state.writeFailure === 'nonce') return reject('nonce too low: nonce has already been used');
            if (accepted.has(hash)) return reject('already known');
            accepted.add(hash);
            return respond(hash);
        }
        if (!write) {
            if (method === 'eth_chainId') return respond(state.chainId);
            if (method === 'eth_gasPrice') return respond('0xf4240');
            if (method === 'eth_getTransactionCount') {
                const nonce = params[1] === 'finalized' ? state.finalizedNonce : state.nonce;
                return respond(`0x${nonce.toString(16)}`);
            }
            if (method === 'eth_getTransactionReceipt') {
                const [hash] = params;
                const status = mined.get(hash);
                return respond(status ? { status, transactionHash: hash } : null);
            }
        }
        reject('Unexpected RPC call');
    });

    await listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function listen(port) {
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
    }

    function disconnect() {
        if (!server.listening) return Promise.resolve();
        const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        return done;
    }

    return {
        base, calls, sends, mined, state, disconnect, reconnect: () => listen(port),
        wallet: privateKeyToAccount(privateKey).address,
        secrets: [privateKey, clientId, clientSecret],
        configure(active = true) {
            Object.assign(process.env, {
                FORTEL2_RECEIPT_PRIVATE_KEY: active ? privateKey : '',
                FORTEL2_CF_ACCESS_CLIENT_ID: clientId,
                FORTEL2_CF_ACCESS_CLIENT_SECRET: clientSecret,
                FORTEL2_CHAIN_ID: '852',
                FORTEL2_READ_RPC_URL: `${base}/read`,
                FORTEL2_WRITE_RPC_URL: `${base}/write`,
                FORTEL2_EXPLORER_URL: `${base}/explorer`
            });
        }
    };
}

async function until(read, message, timeout = 8_000) {
    const end = Date.now() + timeout;
    do {
        const result = await read();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 15));
    } while (Date.now() < end);
    throw new Error(message);
}

module.exports = { FAST, fakeRpc, until };
