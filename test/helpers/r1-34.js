'use strict';

const { createHash } = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const { REFERENCE_SCHEMA } = require('../../lib/cloudbbs-post');

const CLOUD_TOKEN = 'distinctive-r134-synthetic-cloud-token';
const ADMIN_KEY = 'distinctive-r134-synthetic-admin-key';
const ROOT = '/api/admin/v1/managed-agents';

function hashTables(db, { skipAudit = false, migrationComparison = false } = {}) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    const result = {};
    for (const { name } of tables) {
        if (skipAudit && name === 'audit_events') continue;
        if (migrationComparison && (name === 'booking_receipts' || name === 'managed_agent_runs')) continue;
        const table = '"' + name.replaceAll('"', '""') + '"';
        const where = migrationComparison && name === 'schema_migrations' ? " WHERE id NOT IN ('014', '015', '016', '017', '018', '019')" : '';
        const rows = db.prepare(`SELECT * FROM ${table}${where}`).all();
        if (migrationComparison && name === 'rates') {
            for (const row of rows) delete row.max_slots_allowed;
        }
        if (migrationComparison && name === 'managed_agents') {
            for (const row of rows) {
                delete row.booking_slots;
                delete row.booking_request_id;
                delete row.accept_max_slots;
            }
        }
        result[name] = createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');
    }
    return result;
}

async function fakeCloudBbs() {
    const tools = [];
    const body = '\x60\x60\x60json\n' + JSON.stringify({
        schema: REFERENCE_SCHEMA,
        reads: { rateDateRanges: [
            { originPort: 'SHA', destinationPort: 'LAX' },
            { originPort: 'SHA', destinationPort: 'OAK' },
            { originPort: 'SHA', destinationPort: 'OAK' },
            { originPort: 'SIN', destinationPort: 'NYC' }
        ] }
    }) + '\n\x60\x60\x60';
    const split = 43;
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const rpc = JSON.parse(Buffer.concat(chunks));
        const { name, arguments: args } = rpc.params;
        tools.push({ name, method: request.method, path: request.url, authorized: request.headers.authorization === `Bearer ${CLOUD_TOKEN}` });
        const board = args.continuation
            ? { body: body.slice(split), bodyOffset: split }
            : { body: body.slice(0, split), truncated: true, continuation: 'page-two' };
        const result = {
            connect_agent: { sessionId: 'synthetic-session' },
            list_projects: { projects: [{ slug: 'rn', id: 'synthetic-project' }] },
            check_board: { announcements: { projects: [board] } }
        }[name];
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: result } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        tools,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

module.exports = { ADMIN_KEY, CLOUD_TOKEN, ROOT, hashTables, fakeCloudBbs };
