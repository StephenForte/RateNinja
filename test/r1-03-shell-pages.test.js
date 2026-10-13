const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r103-'));

process.env.SQLITE_DB_PATH = path.join(tmpDir, 'r103.db');
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
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method: 'GET'
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                resolve({
                    status: response.statusCode,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

describe('shell pages are the literal index file', () => {
    before(async () => {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns index.html for rates, profile, and admin sections', async () => {
        const index = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'));
        for (const urlPath of ['/rates', '/profile/security', '/admin/users']) {
            const result = await rawGet(urlPath);
            assert.equal(result.status, 200, urlPath);
            assert.equal(Buffer.compare(result.body, index), 0, urlPath);
        }
    });

    it('does not serve source or a dotted admin path through the shell fallback', async () => {
        const blocked = ['/lib/db.js', '/admin/../server.js', '/admin/%2e%2e/server.js', '/admin/x.css', '/script.js'];
        for (const urlPath of blocked) {
            const result = await rawGet(urlPath);
            assert.notEqual(result.status, 200, urlPath);
            assert.equal(result.body.includes(Buffer.from('Ocean Freight Intelligence')), false, urlPath);
            assert.equal(result.body.includes(Buffer.from('function serveStatic')), false, urlPath);
        }
    });
});
