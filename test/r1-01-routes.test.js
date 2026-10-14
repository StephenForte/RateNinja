const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { sendJson, readJson } = require('../lib/http');

const repoRoot = path.join(__dirname, '..');
const routeNames = [
    'admin-context',
    'account',
    'preferences',
    'onboarding',
    'users',
    'customer-access',
    'data-ops',
    'imports',
    'partner'
];

function rawGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method: 'GET'
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
        req.end();
    });
}

describe('r1-01 routes and exact documents', { concurrency: 1 }, () => {
    let app;
    let account;
    let hits;

    before(async () => {
        app = await startApp({
            companyType: 'Contract Owner',
            role: 'admin',
            username: 'r101-admin'
        });
        hits = [];
        account = require('../lib/routes/account');
        account.routes.push(
            {
                method: 'GET',
                path: '/api/r1-01/public',
                access: 'public',
                handler(request, response, session) {
                    hits.push('public');
                    sendJson(response, 200, { ok: true, session: session ? true : false });
                }
            },
            {
                method: 'POST',
                path: '/api/r1-01/public',
                access: 'public',
                handler(request, response) {
                    hits.push('public-post');
                    sendJson(response, 200, { ok: true });
                }
            },
            {
                method: 'GET',
                path: '/api/r1-01/session',
                access: 'session',
                handler(request, response, session) {
                    hits.push('session');
                    sendJson(response, 200, {
                        loginName: session.user.loginName,
                        csrfToken: session.user.csrfToken
                    });
                }
            },
            {
                method: 'POST',
                path: '/api/r1-01/session',
                access: 'session',
                async handler(request, response, session) {
                    const body = await readJson(request);
                    hits.push('session-post');
                    sendJson(response, 200, { loginName: session.user.loginName, ping: body.ping });
                }
            },
            {
                method: 'GET',
                path: '/api/r1-01/unrestricted',
                access: 'session-unrestricted',
                handler(request, response, session) {
                    hits.push('unrestricted');
                    sendJson(response, 200, { loginName: session.user.loginName });
                }
            },
            {
                method: 'GET',
                pattern: /^\/api\/r1-01\/items\/([\w-]+)$/,
                access: 'session',
                handler(request, response, session, params) {
                    hits.push('pattern');
                    sendJson(response, 200, { loginName: session.user.loginName, params });
                }
            },
            {
                method: 'GET',
                path: '/api/r1-01/ignored',
                access: 'nope',
                handler(request, response) {
                    hits.push('ignored');
                    sendJson(response, 200, { ok: true });
                }
            }
        );
    });

    after(async () => {
        if (account) account.routes.length = 0;
        if (app) await app.close();
    });

    it('registers every later route module without editing the registry again', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'lib', 'routes', 'index.js'), 'utf8');
        const modules = require('../lib/routes');
        assert.equal(modules.length, routeNames.length);
        for (const name of routeNames) {
            assert.match(source, new RegExp(`require\\('\\./${name}'\\)`));
            const mod = require(`../lib/routes/${name}`);
            assert.ok(Array.isArray(mod.routes));
            if (name === 'partner') {
                assert.equal(mod.routes.length, 1);
                assert.equal(mod.routes[0].method, 'GET');
                assert.equal(mod.routes[0].path, '/api/partner/v1/me/predictive-pricing');
                assert.equal(mod.routes[0].access, 'public');
            } else if (name === 'admin-context') {
                assert.equal(mod.routes.length, 3);
            } else if (name === 'account') {
                const owned = mod.routes.filter(route => route.path === '/api/account' || route.path === '/api/account/password');
                assert.equal(owned.length, 2);
                assert.equal(owned.find(route => route.path === '/api/account').access, 'session');
                assert.equal(owned.find(route => route.path === '/api/account/password').access, 'session-unrestricted');
            } else if (name === 'customer-access') {
                assert.equal(mod.routes.length, 8);
            } else if (name === 'data-ops') {
                assert.equal(mod.routes.length, 11);
            } else if (name === 'preferences') {
                assert.equal(mod.routes.length, 12);
            } else if (name === 'onboarding') {
                assert.equal(mod.routes.length, 2);
            } else if (name === 'users') {
                assert.equal(mod.routes.length, 6);
            } else if (name === 'imports') {
                assert.equal(mod.routes.length, 7);
            } else {
                assert.equal(mod.routes.length, 0);
            }
        }
    });

    it('serves public routes without a session and session routes only with one', async () => {
        hits.length = 0;
        const publicResult = await app.request('/api/r1-01/public', { cookie: false });
        assert.equal(publicResult.status, 200);
        assert.equal((await publicResult.json()).session, false);

        const missing = await app.request('/api/r1-01/session', { cookie: false });
        assert.equal(missing.status, 401);
        assert.equal((await missing.json()).error, 'Please sign in to continue.');

        const present = await app.request('/api/r1-01/session');
        const presentBody = await present.json();
        assert.equal(present.status, 200);
        assert.equal(presentBody.loginName, 'r101-admin');
        assert.equal(presentBody.csrfToken, app.csrf);

        const unrestrictedMissing = await app.request('/api/r1-01/unrestricted', { cookie: false });
        assert.equal(unrestrictedMissing.status, 401);
        const unrestricted = await app.request('/api/r1-01/unrestricted');
        assert.equal(unrestricted.status, 200);
        assert.equal((await unrestricted.json()).loginName, 'r101-admin');

        const pattern = await app.request('/api/r1-01/items/abc-1');
        assert.equal(pattern.status, 200);
        assert.deepEqual((await pattern.json()).params, ['abc-1']);

        const ignored = await app.request('/api/r1-01/ignored');
        assert.equal(ignored.status, 404);
        assert.equal(hits.includes('ignored'), false);
        assert.deepEqual(hits, ['public', 'session', 'unrestricted', 'pattern']);
    });

    it('enforces CSRF on session posts and not on public posts', async () => {
        const before = hits.length;
        const denied = await app.request('/api/r1-01/session', {
            method: 'POST',
            csrf: false,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ping: true })
        });
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).error, 'Your session could not be verified. Refresh the page and try again.');
        assert.equal(hits.length, before);

        const allowed = await app.request('/api/r1-01/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ping: true })
        });
        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), { loginName: 'r101-admin', ping: true });

        const publicPost = await app.request('/api/r1-01/public', {
            method: 'POST',
            cookie: false,
            csrf: false
        });
        assert.equal(publicPost.status, 200);

        const existing = await app.request('/api/account/2fa/start', {
            method: 'POST',
            csrf: false,
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(existing.status, 403);
        assert.equal((await existing.json()).error, 'Your session could not be verified. Refresh the page and try again.');

        const rates = await app.request('/api/rates');
        assert.equal(rates.status, 200);
        const anonymous = await app.request('/api/rates', { cookie: false });
        assert.equal(anonymous.status, 401);
    });

    it('serves the two documentation files and no other /docs path', async () => {
        const port = Number(new URL(app.baseUrl).port);
        const partnerPath = path.join(repoRoot, 'docs', 'partner-integration.md');
        const readmePath = path.join(repoRoot, 'API-README.md');
        const partner = await rawGet(port, '/docs/partner-integration.md');
        const readme = await rawGet(port, '/API-README.md');
        assert.equal(partner.status, 200);
        assert.equal(readme.status, 200);
        assert.equal(partner.headers['content-type'], 'text/markdown; charset=utf-8');
        assert.equal(readme.headers['content-type'], 'text/markdown; charset=utf-8');
        assert.equal(partner.headers['x-content-type-options'], 'nosniff');
        assert.equal(partner.headers['referrer-policy'], 'same-origin');
        assert.match(partner.headers['content-security-policy'], /default-src 'self'/);
        assert.equal(Buffer.compare(partner.body, fs.readFileSync(partnerPath)), 0);
        assert.equal(Buffer.compare(readme.body, fs.readFileSync(readmePath)), 0);

        const partnerMarker = fs.readFileSync(partnerPath).subarray(0, 40);
        const sourceMarker = Buffer.from('function serveStatic');
        const blocked = [
            '/docs/',
            '/docs/../server.js',
            '/docs/%2e%2e/server.js',
            '/docs/other.md',
            '/docs/partner-integration.md/',
            '/docs/./partner-integration.md',
            '/docs/partner-integration.md.txt',
            '/API-README.md/',
            '/api-readme.md',
            '/lib/db.js'
        ];
        for (const urlPath of blocked) {
            const result = await rawGet(port, urlPath);
            assert.notEqual(result.status, 200, urlPath);
            assert.equal(result.body.includes(partnerMarker), false, urlPath);
            assert.equal(result.body.includes(sourceMarker), false, urlPath);
        }

        const home = await rawGet(port, '/');
        const login = await rawGet(port, '/login');
        assert.equal(home.status, 200);
        assert.equal(login.status, 200);
    });
});
