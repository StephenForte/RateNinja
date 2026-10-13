const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r100-'));
const dataDir = path.join(repoRoot, 'data');
const dataDirExisted = fs.existsSync(dataDir);
const siblingDir = path.join(repoRoot, 'public-x');
const siblingFile = path.join(siblingDir, 'secret');
const dbProbe = path.join(dataDir, 'r1-00-probe.db');
const escapeLink = path.join(publicDir, 'r1-00-escape');
const outsideDirLink = path.join(publicDir, 'r1-00-outdir');
const selfLink = path.join(publicDir, 'r1-00-self');
const SECRET = 'R1-00-SECRET-MARKER-do-not-serve';
const DB_MARKER = 'R1-00-DB-MARKER-do-not-serve';

process.env.SQLITE_DB_PATH = path.join(tmpDir, 'r100.db');
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.PARTNER_OAUTH_ENABLED = 'false';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { db } = require('../lib/db');

let port;

function removeProbe(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function cleanupProbes() {
    removeProbe(escapeLink);
    removeProbe(outsideDirLink);
    removeProbe(selfLink);
    removeProbe(siblingDir);
    removeProbe(dbProbe);
    if (!dataDirExisted) {
        try {
            fs.rmdirSync(dataDir);
        } catch {
            // Leave the directory if the test did not create it or it is not empty.
        }
    }
}

function rawRequest(method, urlPath, body, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers
        }, (response) => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function rawGet(urlPath) {
    return rawRequest('GET', urlPath);
}

function assertBlocked(result, marker) {
    assert.ok(
        result.status === 403 || result.status === 404,
        `${result.status} ${result.body.toString('utf8').slice(0, 180)}`
    );
    if (marker) {
        assert.equal(result.body.includes(Buffer.from(marker)), false);
    }
}

function fileMarker(relativePath, needle) {
    const text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    assert.equal(text.includes(needle), true, `${relativePath} is missing the expected marker`);
    return needle;
}

function legacyMarker(relativePath, needle) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) return needle;
    return fileMarker(relativePath, needle);
}

describe('static files are served only from public/', () => {
    before(async () => {
        cleanupProbes();
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(siblingFile, SECRET);
        fs.writeFileSync(dbProbe, DB_MARKER);
        fs.symlinkSync(path.join(repoRoot, 'lib', 'db.js'), escapeLink);
        fs.symlinkSync(path.join(repoRoot, 'lib'), outsideDirLink);
        fs.symlinkSync(publicDir, selfLink);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        cleanupProbes();
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serves the pages and every local asset they load', async () => {
        const assets = [
            ['/', 'text/html; charset=utf-8', 'public/index.html'],
            ['/login', 'text/html; charset=utf-8', 'public/login.html'],
            ['/login.html', 'text/html; charset=utf-8', 'public/login.html'],
            ['/api-docs.html', 'text/html; charset=utf-8', 'public/api-docs.html'],
            ['/api-testbed.html', 'text/html; charset=utf-8', 'public/api-testbed.html'],
            ['/styles.css', 'text/css; charset=utf-8', 'public/styles.css'],
            ['/styles.css?v=1', 'text/css; charset=utf-8', 'public/styles.css'],
            ['/script.js', 'application/javascript; charset=utf-8', 'public/script.js'],
            ['/login.js', 'application/javascript; charset=utf-8', 'public/login.js'],
            ['/favicon.svg', 'image/svg+xml', 'public/favicon.svg'],
            ['/api-testbed.css', 'text/css; charset=utf-8', 'public/api-testbed.css'],
            ['/api-testbed.js', 'application/javascript; charset=utf-8', 'public/api-testbed.js']
        ];
        for (const [urlPath, contentType, relativePath] of assets) {
            const result = await rawGet(urlPath);
            const expected = fs.readFileSync(path.join(repoRoot, relativePath));
            assert.equal(result.status, 200, urlPath);
            assert.equal(result.headers['content-type'], contentType, urlPath);
            assert.equal(result.headers['x-content-type-options'], 'nosniff', urlPath);
            assert.equal(result.headers['referrer-policy'], 'same-origin', urlPath);
            assert.match(result.headers['content-security-policy'], /default-src 'self'/, urlPath);
            assert.equal(Buffer.compare(result.body, expected), 0, urlPath);
        }
    });

    it('does not serve source, tasks, legacy pages, or a database under data/', async () => {
        const blocked = [
            ['/lib/db.js', fileMarker('lib/db.js', 'CREATE TABLE IF NOT EXISTS rates')],
            ['/server.js', fileMarker('server.js', 'function serveStatic')],
            ['/package.json', fileMarker('package.json', 'Ocean freight rate lookup application')],
            ['/render.yaml', fileMarker('render.yaml', 'healthCheckPath')],
            ['/tasks/prd-round-1-enhancements.md', fileMarker('tasks/prd-round-1-enhancements.md', 'Draft for product review')],
            ['/scripts/ralph/prd.json', fileMarker('scripts/ralph/prd.json', 'ralph/sqlite-migration-pull-forward-predictive')],
            // RateNinja is a gitlink and has no .gitmodules entry, so CI does not check out its files.
            ['/RateNinja/index.html', legacyMarker('RateNinja/index.html', 'Vortecx Rate Engine')],
            ['/RateNinja/script.js', legacyMarker('RateNinja/script.js', 'AIRTABLE_BASE_ID')],
            ['/README.md', fileMarker('README.md', 'Browser files live in `public/`')],
            ['/data/r1-00-probe.db', DB_MARKER],
            ['/public-x/secret', SECRET]
        ];
        for (const [urlPath, marker] of blocked) {
            const result = await rawGet(urlPath);
            assertBlocked(result, marker);
        }
    });

    it('rejects encoded traversal, collapsed slashes, and a sibling public-x path', async () => {
        const paths = [
            '/%2e%2e/lib/db.js',
            '/..%2fserver.js',
            '//server.js',
            '///server.js',
            '/foo/../../../server.js',
            '/.%2e/server.js',
            '/%2e%2e%2flib%2fdb.js',
            '/%252e%252e/server.js',
            '/%2e%2e/public-x/secret',
            '/../public-x/secret',
            '/%2e%2e/%2e%2e/server.js',
            '/..%5cserver.js',
            '/%00/server.js',
            '/index.html%00.js'
        ];
        for (const urlPath of paths) {
            const result = await rawGet(urlPath);
            assertBlocked(result, SECRET);
            assert.equal(result.body.includes(Buffer.from('function serveStatic')), false, urlPath);
            assert.equal(result.body.includes(Buffer.from('Ocean Freight Intelligence')), false, urlPath);
        }
    });

    it('does not follow a symlink out of public/ or serve the public directory itself', async () => {
        const dbMarker = fileMarker('lib/db.js', 'CREATE TABLE IF NOT EXISTS rates');
        const indexMarker = fileMarker('public/index.html', 'Ocean Freight Intelligence');
        const paths = [
            '/r1-00-escape',
            '/r1-00-outdir/db.js',
            '/r1-00-self',
            '/r1-00-self/'
        ];
        for (const urlPath of paths) {
            const result = await rawGet(urlPath);
            assertBlocked(result, dbMarker);
            assert.equal(result.body.includes(Buffer.from(indexMarker)), false, urlPath);
        }
    });

    it('still dispatches API, OAuth, well-known, and MCP routes', async () => {
        const health = await rawGet('/api/health');
        assert.equal(health.status, 200);
        assert.equal(health.headers['content-type'], 'application/json; charset=utf-8');
        const healthBody = JSON.parse(health.body.toString('utf8'));
        assert.equal(healthBody.service, 'rate-ninja');
        assert.equal(healthBody.ok, true);

        for (const urlPath of [
            '/.well-known/oauth-authorization-server',
            '/.well-known/oauth-protected-resource',
            '/.well-known/oauth-protected-resource/mcp'
        ]) {
            const result = await rawGet(urlPath);
            assert.equal(result.status, 200, urlPath);
            assert.equal(result.headers['content-type'], 'application/json; charset=utf-8', urlPath);
            assert.equal(result.body.includes(Buffer.from('<!DOCTYPE')), false, urlPath);
            JSON.parse(result.body.toString('utf8'));
        }

        const mcp = await rawRequest('POST', '/mcp', '{}', { 'content-type': 'application/json' });
        assert.equal(mcp.status, 403);
        assert.equal(mcp.headers['content-type'], 'application/json; charset=utf-8');
        assert.match(mcp.body.toString('utf8'), /partner_oauth_disabled/);

        const token = await rawRequest('POST', '/oauth/token', '{}', { 'content-type': 'application/json' });
        assert.equal(token.headers['content-type'], 'application/json; charset=utf-8');
        assert.notEqual(token.status, 200);
        JSON.parse(token.body.toString('utf8'));
    });
});
