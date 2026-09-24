const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-http-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'http.db');
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { db } = require('../lib/db');
const { ensureFoundation } = require('../lib/foundation');
const { setPasswordByUsername } = require('../lib/accounts');

const PASSWORD = 'sail-the-ocean';
let baseUrl;
let steve;
let client;

function cookieHeader(response) {
    return (response.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
}

async function login(username) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { cookie: cookieHeader(response), csrf: body.csrfToken, user: body.user };
}

function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, state: crypto.randomBytes(12).toString('base64url') };
}

async function authorizeAndToken(session, secret, redirectUri) {
    const proof = pkce();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: client.id,
        redirect_uri: redirectUri,
        scope: 'profile:read rates:read sailings:read',
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256'
    });
    const consent = await fetch(`${baseUrl}/oauth/authorize?${params}`, {
        headers: { cookie: session.cookie },
        redirect: 'manual'
    });
    assert.equal(consent.status, 200);
    const approved = await fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            ...Object.fromEntries(params),
            decision: 'approve',
            csrf_token: session.csrf
        }),
        redirect: 'manual'
    });
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get('location'));
    assert.equal(location.searchParams.get('state'), proof.state);
    const code = location.searchParams.get('code');
    assert.ok(code);
    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: client.id,
            client_secret: secret,
            code_verifier: proof.verifier
        })
    });
    const token = await tokenResponse.json();
    assert.equal(tokenResponse.status, 200, JSON.stringify(token));
    return { token, code, proof };
}

describe('partner http', () => {
    before(async () => {
        ensureFoundation();
        assert.equal(setPasswordByUsername('SteveF', PASSWORD).ok, true);
        assert.equal(setPasswordByUsername('Alan', PASSWORD).ok, true);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        steve = await login('SteveF');
        const created = await fetch(`${baseUrl}/api/admin/oauth-clients`, {
            method: 'POST',
            headers: {
                cookie: steve.cookie,
                'content-type': 'application/json',
                'x-csrf-token': steve.csrf
            },
            body: JSON.stringify({
                displayName: 'Test Partner',
                clientType: 'confidential',
                redirectUris: ['http://127.0.0.1:9/callback'],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        client = { id: createdBody.client.id, secret: createdBody.clientSecret };
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
        try {
            db.close();
        } catch {
            // Temporary database.
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('issues a PKCE token, hides other owners, and matches MCP', async () => {
        const redirectUri = 'http://127.0.0.1:9/callback';
        const empty = await fetch(`${baseUrl}/api/partner/v1/me/rates`, { headers: { 'x-api-key': 'demo-key' } });
        assert.equal(empty.status, 401);
        assert.equal((await empty.json()).error, 'invalid_token');

        const { token, code } = await authorizeAndToken(steve, client.secret, redirectUri);
        const replay = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: client.id,
                client_secret: client.secret,
                code_verifier: 'a'.repeat(50)
            })
        });
        assert.equal(replay.status, 400);

        const profile = await fetch(`${baseUrl}/oauth/userinfo`, { headers: { authorization: `Bearer ${token.access_token}` } });
        const profileBody = await profile.json();
        assert.equal(profile.status, 200);
        assert.equal(profileBody.companyType, 'Contract Owner');
        assert.equal(profileBody.name, 'SteveF');

        const none = await fetch(`${baseUrl}/api/partner/v1/me/rates`, { headers: { authorization: `Bearer ${token.access_token}` } });
        const noneBody = await none.json();
        assert.equal(none.status, 200);
        assert.deepEqual(noneBody.data, []);
        assert.equal(none.headers.get('cache-control'), 'no-store');

        const kings = db.prepare(`SELECT id FROM companies WHERE company_name = 'Kings'`).get();
        const blue = db.prepare(`SELECT id, company_name FROM companies WHERE id = 'eceiPwdeF95uwQfD'`).get();
        const bob = db.prepare(`SELECT company_record_id, pwd, password_hash FROM users WHERE username = 'Bob'`).get();
        assert.equal(blue.company_name, 'Blue Sky Shipping');
        assert.equal(bob.company_record_id, blue.id);
        assert.equal(bob.pwd, null);
        assert.equal(bob.password_hash, null);

        db.prepare(`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id) VALUES ('joes', 'joes', 'Joe Shipping', 'Contract Owner', 'contract_owner')`).run();
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, contract_owner, rate_20d, rate_40d, rate_40hc, rate_effective_date, owner_company_id)
            VALUES ('kings-rate', 'MSC', 'SHA', 'LAX', 'Kings', 1000, 2000, 2100, '2026-04-01', ?)
        `).run(kings.id);
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, contract_owner, rate_20d, rate_40d, rate_40hc, rate_effective_date, owner_company_id)
            VALUES ('joes-rate', 'MSC', 'SHA', 'LAX', 'Joe', 2000, 2000, 2000, '2026-04-01', 'joes')
        `).run();
        db.prepare(`
            INSERT INTO sailings (id, departure, arrival, carrier, departure_port, owner_company_id)
            VALUES ('kings-sailing', '2026-05-01T00:00:00.000Z', '2026-05-20T00:00:00.000Z', 'MSC', 'SHA', ?)
        `).run(kings.id);

        const rates = await fetch(`${baseUrl}/api/partner/v1/me/rates`, { headers: { authorization: `Bearer ${token.access_token}` } });
        const ratesBody = await rates.json();
        assert.deepEqual(ratesBody.data.map(rate => [rate.id, rate.rate20D, rate.source]), [['kings-rate', 1000, 'base_contract']]);
        const hidden = await fetch(`${baseUrl}/api/partner/v1/me/rates/joes-rate`, { headers: { authorization: `Bearer ${token.access_token}` } });
        assert.equal(hidden.status, 404);

        const sailings = await fetch(`${baseUrl}/api/partner/v1/me/sailings`, { headers: { authorization: `Bearer ${token.access_token}` } });
        const sailingsBody = await sailings.json();
        assert.deepEqual(sailingsBody.data.map(sailing => sailing.id), ['kings-sailing']);

        const mcp = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rateninja_list_my_rates', arguments: {} } })
        });
        const mcpBody = await mcp.json();
        assert.equal(mcp.status, 200);
        assert.deepEqual(mcpBody.result.structuredContent.data.map(rate => rate.id), ['kings-rate']);

        const blackwater = db.prepare(`SELECT id FROM companies WHERE company_name = 'Blackwater Shippers'`).get();
        const margin = await fetch(`${baseUrl}/api/admin/companies/${blackwater.id}`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ marginPercent: 0.1, marginNumber: 0 })
        });
        assert.equal(margin.status, 403);
        const saved = await fetch(`${baseUrl}/api/admin/companies/${blackwater.id}`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ marginPercent: 0.1, marginNumber: 0 })
        });
        assert.equal(saved.status, 200);

        const alan = await login('Alan');
        assert.equal(alan.user.isContractOwner, false);
        const alanRates = await fetch(`${baseUrl}/api/rates`, { headers: { cookie: alan.cookie } });
        const alanBody = await alanRates.json();
        assert.deepEqual(alanBody.rates.map(rate => [rate.id, rate.rate20D]).sort(), [['kings-rate', 1100]]);

        const denied = await fetch(`${baseUrl}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: client.id,
            redirect_uri: redirectUri,
            scope: 'profile:read',
            state: 'customer-state',
            code_challenge: pkce().challenge,
            code_challenge_method: 'S256'
        })}`, { headers: { cookie: alan.cookie }, redirect: 'manual' });
        assert.equal(denied.status, 302);
        assert.match(denied.headers.get('location'), /error=access_denied/);
        assert.match(denied.headers.get('location'), /only_contract_owner/);

        const rotated = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.id, client_secret: client.secret })
        });
        const rotatedBody = await rotated.json();
        assert.equal(rotated.status, 200);
        const reuse = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.id, client_secret: client.secret })
        });
        assert.equal(reuse.status, 400);
        assert.equal((await reuse.json()).error, 'invalid_grant');
        const family = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rotatedBody.refresh_token, client_id: client.id, client_secret: client.secret })
        });
        assert.equal(family.status, 400);

        const clients = await fetch(`${baseUrl}/api/admin/oauth-clients`, { headers: { cookie: steve.cookie } });
        const clientNames = (await clients.json()).clients.map(item => item.displayName);
        assert.ok(clientNames.includes('Capacity Exchange'));
        assert.ok(clientNames.includes('Test Partner'));

        process.env.PARTNER_OAUTH_ENABLED = 'false';
        const blocked = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant_type: 'authorization_code' })
        });
        assert.equal((await blocked.json()).error, 'partner_oauth_disabled');
        process.env.PARTNER_OAUTH_ENABLED = 'true';

        const password = 'not-the-real-password';
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const failed = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'missing-user', password })
            });
            assert.equal(failed.status, 401);
        }
        const throttled = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'missing-user', password })
        });
        assert.equal(throttled.status, 429);
        const leaked = db.prepare(`SELECT detail FROM audit_events WHERE event_type = 'login_failure'`).all().map(row => row.detail).join('\n');
        assert.equal(leaked.includes(password), false);
    });
});
