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

async function authorizeAndToken(session, secret, redirectUri, clientId = client.id) {
    const proof = pkce();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
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
            client_id: clientId,
            client_secret: secret,
            code_verifier: proof.verifier
        })
    });
    const token = await tokenResponse.json();
    assert.equal(tokenResponse.status, 200, JSON.stringify(token));
    return { token, code, proof };
}

function authorizeParams({ clientId, redirectUri, scope, proof }) {
    return new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256'
    });
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
        const clientsBody = await clients.json();
        const clientNames = clientsBody.clients.map(item => item.displayName);
        assert.ok(clientNames.includes('Capacity Exchange'));
        assert.ok(clientNames.includes('Test Partner'));
        const seeded = clientsBody.clients.find(item => item.id === 'capacity-exchange');
        assert.deepEqual(seeded.redirectUris, []);
        assert.equal(seeded.hasSecret, false);

        const redirectUriSeed = 'http://127.0.0.1:9/capacity';
        const savedRedirects = await fetch(`${baseUrl}/api/admin/oauth-clients/capacity-exchange`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ redirectUris: [redirectUriSeed] })
        });
        const savedRedirectsBody = await savedRedirects.json();
        assert.equal(savedRedirects.status, 200, JSON.stringify(savedRedirectsBody));
        assert.deepEqual(savedRedirectsBody.client.redirectUris, [redirectUriSeed]);
        const seededSecret = await fetch(`${baseUrl}/api/admin/oauth-clients/capacity-exchange/rotate-secret`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({})
        });
        const seededSecretBody = await seededSecret.json();
        assert.equal(seededSecret.status, 200, JSON.stringify(seededSecretBody));
        assert.equal(typeof seededSecretBody.clientSecret, 'string');
        assert.ok(seededSecretBody.clientSecret.length > 10);
        const seededToken = await authorizeAndToken(steve, seededSecretBody.clientSecret, redirectUriSeed, 'capacity-exchange');
        assert.equal(seededToken.token.token_type, 'Bearer');

        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id)
            VALUES ('rec-owner', 'CO-9', 'Migrated Owner Co', 'Contract Owner', 'contract_owner')
        `).run();
        db.prepare(`
            INSERT INTO users (id, username, display_name, company_id, company_reference, company_record_id, admin_screen, disabled, session_epoch)
            VALUES ('user-migrated', 'MigratedOwner', 'Migrated Owner', 'CO-9', 'rec-missing, rec-owner', NULL, 0, 0, 0)
        `).run();
        assert.equal(setPasswordByUsername('MigratedOwner', PASSWORD).ok, true);
        const migrated = await login('MigratedOwner');
        assert.equal(migrated.user.isContractOwner, true);
        assert.equal(migrated.user.companyType, 'Contract Owner');
        const linked = db.prepare(`SELECT company_record_id FROM users WHERE id = 'user-migrated'`).get();
        assert.equal(linked.company_record_id, 'rec-owner');
        const migratedGrant = await authorizeAndToken(migrated, client.secret, redirectUri);
        const migratedProfile = await fetch(`${baseUrl}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${migratedGrant.token.access_token}` }
        });
        const migratedProfileBody = await migratedProfile.json();
        assert.equal(migratedProfile.status, 200, JSON.stringify(migratedProfileBody));
        assert.equal(migratedProfileBody.companyType, 'Contract Owner');

        const fresh = await authorizeAndToken(steve, client.secret, redirectUri);
        const badDate = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${fresh.token.access_token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'rateninja_list_my_rates', arguments: { carrier: 'CMA', effectiveDate: 'not-a-date' } }
            })
        });
        const badDateBody = await badDate.json();
        assert.equal(badDate.status, 200);
        assert.equal(badDateBody.result.isError, true);
        assert.equal(badDateBody.result.structuredContent.error, 'invalid_request');
        assert.equal(badDateBody.result.structuredContent.data, undefined);

        const proof = pkce();
        const authorizeParams = new URLSearchParams({
            response_type: 'code',
            client_id: client.id,
            redirect_uri: redirectUri,
            scope: 'profile:read rates:read',
            state: proof.state,
            code_challenge: proof.challenge,
            code_challenge_method: 'S256'
        });
        const expiredConsent = await fetch(`${baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), decision: 'approve' }),
            redirect: 'manual'
        });
        assert.equal(expiredConsent.status, 302);
        assert.equal((expiredConsent.headers.get('content-type') || '').includes('application/json'), false);
        const loginNext = new URL(expiredConsent.headers.get('location'), baseUrl);
        assert.equal(loginNext.pathname, '/login');
        const next = loginNext.searchParams.get('next');
        assert.ok(next.startsWith('/oauth/authorize?'));
        const restored = new URL(next, baseUrl);
        assert.equal(restored.searchParams.get('client_id'), client.id);
        assert.equal(restored.searchParams.get('redirect_uri'), redirectUri);
        assert.equal(restored.searchParams.get('state'), proof.state);
        assert.equal(restored.searchParams.get('code_challenge'), proof.challenge);

        for (const path of ['/oauth/token', '/oauth/revoke']) {
            const malformed = await fetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{not json'
            });
            const malformedBody = await malformed.json();
            assert.equal(malformed.status, 400, `${path} ${JSON.stringify(malformedBody)}`);
            assert.equal(malformedBody.error, 'invalid_request');
        }

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

    it('denies consent without issuing a code or a new grant', async () => {
        const redirectUri = 'http://127.0.0.1:9/callback';
        const steveId = db.prepare(`SELECT id FROM users WHERE username = 'SteveF'`).get().id;
        const before = db.prepare('SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND client_id = ?').get(steveId, client.id).count;
        const proof = pkce();
        const params = authorizeParams({
            clientId: client.id,
            redirectUri,
            scope: 'profile:read rates:read',
            proof
        });
        const denied = await fetch(`${baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'deny', csrf_token: steve.csrf }),
            redirect: 'manual'
        });
        assert.equal(denied.status, 302);
        const location = new URL(denied.headers.get('location'));
        assert.equal(location.searchParams.get('error'), 'access_denied');
        assert.equal(location.searchParams.get('code'), null);
        assert.equal(location.searchParams.get('state'), proof.state);
        const after = db.prepare('SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND client_id = ?').get(steveId, client.id).count;
        assert.equal(after, before);
    });

    it('rejects an unregistered redirect without sending the browser there', async () => {
        const proof = pkce();
        const params = authorizeParams({
            clientId: client.id,
            redirectUri: 'https://evil.example/callback',
            scope: 'profile:read',
            proof
        });
        const rejected = await fetch(`${baseUrl}/oauth/authorize?${params}`, {
            headers: { cookie: steve.cookie },
            redirect: 'manual'
        });
        const html = await rejected.text();
        assert.equal(rejected.status, 400);
        assert.equal(rejected.headers.get('location'), null);
        assert.match(html, /not registered/);
        assert.equal(html.includes('evil.example'), false);
    });

    it('exchanges a public-client code without a secret and rejects a secret', async () => {
        const redirectUri = 'http://127.0.0.1:9/public-callback';
        const created = await fetch(`${baseUrl}/api/admin/oauth-clients`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({
                displayName: 'Public Partner',
                clientType: 'public',
                redirectUris: [redirectUri],
                allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
            })
        });
        const createdBody = await created.json();
        assert.equal(created.status, 201, JSON.stringify(createdBody));
        assert.equal(createdBody.clientSecret, null);
        const proof = pkce();
        const params = authorizeParams({
            clientId: createdBody.client.id,
            redirectUri,
            scope: 'profile:read rates:read',
            proof
        });
        const approved = await fetch(`${baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: steve.csrf }),
            redirect: 'manual'
        });
        assert.equal(approved.status, 302);
        const code = new URL(approved.headers.get('location')).searchParams.get('code');
        const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: createdBody.client.id,
                code_verifier: proof.verifier
            })
        });
        const token = await tokenResponse.json();
        assert.equal(tokenResponse.status, 200, JSON.stringify(token));
        assert.equal(token.token_type, 'Bearer');

        const second = pkce();
        const secondParams = authorizeParams({
            clientId: createdBody.client.id,
            redirectUri,
            scope: 'profile:read',
            proof: second
        });
        const secondApproval = await fetch(`${baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(secondParams), decision: 'approve', csrf_token: steve.csrf }),
            redirect: 'manual'
        });
        const secondCode = new URL(secondApproval.headers.get('location')).searchParams.get('code');
        const withSecret = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code: secondCode,
                redirect_uri: redirectUri,
                client_id: createdBody.client.id,
                client_secret: 'not-a-public-client-secret',
                code_verifier: second.verifier
            })
        });
        const withSecretBody = await withSecret.json();
        assert.equal(withSecret.status, 401, JSON.stringify(withSecretBody));
        assert.equal(withSecretBody.error, 'invalid_client');
    });

    it('stops partner reads after the user revokes the grant', async () => {
        const redirectUri = 'http://127.0.0.1:9/callback';
        const { token } = await authorizeAndToken(steve, client.secret, redirectUri);
        const before = await fetch(`${baseUrl}/api/partner/v1/me/rates`, {
            headers: { authorization: `Bearer ${token.access_token}` }
        });
        assert.equal(before.status, 200);
        const revoked = await fetch(`${baseUrl}/oauth/consents/${client.id}`, {
            method: 'DELETE',
            headers: { cookie: steve.cookie, 'x-csrf-token': steve.csrf }
        });
        assert.equal(revoked.status, 200, JSON.stringify(await revoked.clone().json()));
        const after = await fetch(`${baseUrl}/api/partner/v1/me/rates`, {
            headers: { authorization: `Bearer ${token.access_token}` }
        });
        const afterBody = await after.json();
        assert.equal(after.status, 401, JSON.stringify(afterBody));
        assert.equal(afterBody.error, 'invalid_token');
    });

    it('refuses rate reads when the token only has profile:read', async () => {
        const redirectUri = 'http://127.0.0.1:9/callback';
        const proof = pkce();
        const params = authorizeParams({
            clientId: client.id,
            redirectUri,
            scope: 'profile:read',
            proof
        });
        const approved = await fetch(`${baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: steve.csrf }),
            redirect: 'manual'
        });
        const code = new URL(approved.headers.get('location')).searchParams.get('code');
        const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: client.id,
                client_secret: client.secret,
                code_verifier: proof.verifier
            })
        });
        const token = await tokenResponse.json();
        assert.equal(tokenResponse.status, 200, JSON.stringify(token));
        assert.equal(token.scope, 'profile:read');
        const profile = await fetch(`${baseUrl}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${token.access_token}` }
        });
        assert.equal(profile.status, 200);
        const rates = await fetch(`${baseUrl}/api/partner/v1/me/rates`, {
            headers: { authorization: `Bearer ${token.access_token}` }
        });
        const ratesBody = await rates.json();
        assert.equal(rates.status, 403, JSON.stringify(ratesBody));
        assert.equal(ratesBody.error, 'insufficient_scope');
    });

    it('refuses authorization for a disabled client', async () => {
        const disabled = await fetch(`${baseUrl}/api/admin/oauth-clients/${client.id}`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ status: 'disabled' })
        });
        assert.equal(disabled.status, 200, JSON.stringify(await disabled.clone().json()));
        const proof = pkce();
        const params = authorizeParams({
            clientId: client.id,
            redirectUri: 'http://127.0.0.1:9/callback',
            scope: 'profile:read',
            proof
        });
        const rejected = await fetch(`${baseUrl}/oauth/authorize?${params}`, {
            headers: { cookie: steve.cookie },
            redirect: 'manual'
        });
        const html = await rejected.text();
        assert.equal(rejected.status, 400);
        assert.equal(rejected.headers.get('location'), null);
        assert.match(html, /not registered/);
        const restored = await fetch(`${baseUrl}/api/admin/oauth-clients/${client.id}`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ status: 'active' })
        });
        assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
    });
});
