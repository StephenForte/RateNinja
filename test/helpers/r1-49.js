'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { extractJsonBlock } = require('../../lib/cloudbbs-post');
const { startApp } = require('./app');
const { insertCompany, insertUser } = require('./r1-19');
const { COMPANY_TYPE_CUSTOMER } = require('../../lib/constants');
const { ADMIN_KEY } = require('./r1-26');
const { NOON } = require('./r1-45');

const POST_TOKEN = 'r149-synthetic-announcement-token';
const READ_TOKEN = 'r149-synthetic-reader-token';
const UPDATED_AT = '2026-11-20T12:00:01.000Z';
const OLD_CODE = 'OLDCODE49';

async function fakeCloudBbs() {
    const fake = { body: `Today's Booking Code: ${OLD_CODE}\n`, puts: [], boardReads: 0 };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks));
        response.setHeader('content-type', 'application/json');
        if (request.method === 'PUT') {
            assert.equal(request.url, '/api/v1/projects/rn/announcement');
            assert.equal(request.headers.authorization === `Bearer ${POST_TOKEN}`, true);
            fake.puts.push(payload);
            const override = await fake.onPut?.(payload);
            if (response.destroyed) return;
            if (override) {
                response.writeHead(override.status).end(JSON.stringify(override.body));
                return;
            }
            fake.body = payload.body;
            response.end(JSON.stringify({ version: fake.puts.length, updatedAt: UPDATED_AT }));
            return;
        }

        assert.equal(request.headers.authorization === `Bearer ${READ_TOKEN}`, true);
        const name = payload.params.name;
        if (name === 'check_board') fake.boardReads += 1;
        const structuredContent = {
            connect_agent: { sessionId: 'r149-test' },
            list_projects: { projects: [{ slug: 'rn', id: 'r149-project' }] },
            check_board: { announcements: { projects: [{ body: fake.body }] } }
        }[name];
        assert.ok(structuredContent);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { structuredContent } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    fake.baseUrl = `http://127.0.0.1:${server.address().port}`;
    fake.close = () => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    });
    fake.lastCode = () => extractJsonBlock(fake.puts.at(-1).body).bookingCode;
    return fake;
}

async function startFixture() {
    const cloud = await fakeCloudBbs();
    Object.assign(process.env, {
        NODE_ENV: 'test',
        RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
        CLOUDBBS_TOKEN: POST_TOKEN,
        CLOUDBBS_SERVER_TOKEN: READ_TOKEN,
        CLOUDBBS_AGENT_TOKEN: 'r149-synthetic-runner-token',
        ANTHROPIC_API_KEY: 'r149-synthetic-claude-key',
        CLIENT_AGENT_ANTHROPIC_URL: 'http://127.0.0.1:9',
        CLOUDBBS_URL: cloud.baseUrl,
        CLOUDBBS_PROJECT: 'rn'
    });
    let app;
    try {
        app = await startApp({ username: 'r149-admin' });
        process.env.RATE_NINJA_BASE_URL = app.baseUrl;
        const admin = app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ? RETURNING id').get(app.username);
        insertCompany(app.db, { id: 'r149-buyer', name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
        const { setPasswordByUsername } = require('../../lib/accounts');
        for (const [username, role, companyId] of [
            ['r149-member', 'member', app.company.id],
            ['r149-company-admin', 'company_admin', app.company.id],
            ['r149-customer', 'member', 'r149-buyer']
        ]) {
            insertUser(app.db, { id: username, username, role, companyId });
            assert.equal(setPasswordByUsername(username, app.password).ok, true);
        }
        const runs = require('../../lib/managed-agent-runs');
        runs.setTestClock(() => NOON);
        return { app, cloud, runs, adminId: admin.id };
    } catch (error) {
        await cloud.close();
        await app?.close();
        throw error;
    }
}

function assertNoSecrets(value, ...codes) {
    const text = JSON.stringify(value);
    for (const secret of [ADMIN_KEY, POST_TOKEN, READ_TOKEN, OLD_CODE, ...codes]) {
        assert.equal(text.includes(secret), false, 'Response, audit or log disclosed a credential or booking code');
    }
}

module.exports = { startFixture, assertNoSecrets, ADMIN_KEY, POST_TOKEN, UPDATED_AT, OLD_CODE };
