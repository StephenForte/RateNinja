'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r163-'));

process.env.SQLITE_DB_PATH = path.join(tmpDir, 'r163.db');
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.PARTNER_OAUTH_ENABLED = 'false';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { db } = require('../lib/db');

let port;

function rawGet(urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('swarm tab route', () => {
    before(async () => {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serves the app shell for /swarm only and keeps the client route exact', async () => {
        const index = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'));
        assert.match(index.toString('utf8'), /<a href="\/swarm">Managed Agent Swarm \(Premium\)<\/a>/);
        for (const urlPath of ['/swarm', '/swarm/', '/rates', '/agents']) {
            const result = await rawGet(urlPath);
            assert.equal(result.status, 200, urlPath);
            assert.equal(Buffer.compare(result.body, index), 0, urlPath);
        }
        for (const urlPath of ['/swarm/x', '/swarmx', '/agents/x', '/rates/x']) {
            const result = await rawGet(urlPath);
            assert.notEqual(result.status, 200, urlPath);
            assert.equal(Buffer.compare(result.body, index) === 0, false, urlPath);
        }
        const { isClientRoute, resolveRoute } = await import('../public/js/router.js');
        const signedIn = { signedIn: true };
        for (const route of ['/swarm', '/swarm/']) {
            assert.equal(isClientRoute(route), true);
            const decision = resolveRoute(route, signedIn);
            assert.equal(decision.kind, 'section');
            assert.equal(decision.section.id, 'agent-swarm');
            assert.equal(decision.section.path, '/swarm');
        }
        assert.equal(resolveRoute('/swarm', { signedIn: false }).kind, 'access-denied');
        for (const route of ['/swarm/x', '/swarmx', '/swarm/..']) {
            assert.equal(isClientRoute(route), false, route);
            assert.equal(resolveRoute(route, signedIn).kind, 'not-found', route);
        }
        assert.equal(isClientRoute('/agents'), true);
        assert.equal(resolveRoute('/agents/x', signedIn).kind, 'not-found');
    });
});
