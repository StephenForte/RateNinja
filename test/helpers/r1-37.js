'use strict';

const { once } = require('node:events');
const http = require('node:http');
const { REFERENCE_SCHEMA } = require('../../lib/cloudbbs-post');

const CODE = 'SYNTH37A9';
const SERVER_TOKEN = 'synthetic-r137-dedicated-server-token';

function referenceBody(bookingCode, reads = { rateDateRanges: [] }) {
    const header = bookingCode == null ? [] : [`Today's Booking Code: ${bookingCode}`];
    return ['Generated 2026-11-18T00:00:00.000Z from https://example.invalid.',
        ...header, '\x60\x60\x60json',
        JSON.stringify({ schema: REFERENCE_SCHEMA, bookingCode, reads }), '\x60\x60\x60'].join('\n');
}

async function startCloudBbs({ code = CODE } = {}) {
    const fake = { code, mode: 'ok', calls: [] };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { id, params } = JSON.parse(Buffer.concat(chunks));
        const { name, arguments: args } = params;
        const authorized = request.headers.authorization === `Bearer ${SERVER_TOKEN}`;
        fake.calls.push({ name, authorized, args, method: request.method, path: request.url });
        if (!authorized || fake.mode === 'error') {
            response.writeHead(authorized ? 500 : 401).end(JSON.stringify({ error: { message: SERVER_TOKEN + CODE } }));
            return;
        }
        if (fake.mode === 'timeout') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{');
            return;
        }
        const body = referenceBody(fake.mode === 'no code' ? undefined : fake.code, {
            rateDateRanges: [], padding: 'x'.repeat(118_000)
        });
        const split = 59_000;
        const page = args.continuation
            ? { body: body.slice(split), bodyOffset: split }
            : { body: body.slice(0, split), bodyOffset: 0, truncated: true, continuation: 'next' };
        const data = {
            connect_agent: { sessionId: 'synthetic-r137-session' },
            list_projects: { projects: [{ slug: 'decoy', id: 'decoy' }, { slug: 'rn', id: 'synthetic-rn' }] },
            check_board: { announcements: { projects: fake.mode === 'no announcement' ? [] : [page] } }
        }[name];
        response.writeHead(data ? 200 : 400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: data } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    fake.url = `http://127.0.0.1:${server.address().port}`;
    fake.configureServer = () => {
        process.env.CLOUDBBS_URL = fake.url;
        process.env.CLOUDBBS_PROJECT = 'rn';
        process.env.CLOUDBBS_SERVER_TOKEN = SERVER_TOKEN;
    };
    let closing;
    fake.close = () => closing ??= new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    });
    return fake;
}

module.exports = { CODE, SERVER_TOKEN, referenceBody, startCloudBbs };
