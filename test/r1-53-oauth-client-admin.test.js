'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, mcpCall, pkce, REDIRECT_URI } = require('./helpers/r1-12');
const { activate, call, COMPANY_TYPE_CUSTOMER, insertCompany, insertUser, login } = require('./helpers/r1-19');
const { CAPACITY_EXCHANGE_CLIENT_ID, CAPACITY_EXCHANGE_DISPLAY_NAME } = require('../lib/constants');

const ROOT = '/api/admin/oauth-clients';
const READ = 'rates:read';
const WRITE = 'bookings:write';

describe('R1-53 OAuth client administration', () => {
    let app;
    let buyer;
    let adminId;

    before(async () => {
        app = await startApp({ username: 'r153-admin' });
        require('../lib/foundation').ensureFoundation();
        adminId = app.db.prepare('SELECT id FROM users WHERE username = ?').get(app.username).id;
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE id = ?').run(adminId);
        insertCompany(app.db, { id: 'r153-buyer', name: 'Synthetic buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, { id: 'r153-user', username: 'r153-buyer', companyId: 'r153-buyer' });
        activate('r153-buyer');
        buyer = await login(app.baseUrl, 'r153-buyer');
    });

    after(async () => app?.close());

    async function register(displayName, allowedScopes) {
        const result = await call(app.baseUrl, app, 'POST', ROOT, {
            displayName, allowedScopes, redirectUris: [REDIRECT_URI], clientType: 'public'
        });
        assert.equal(result.status, 201, result.text);
        return result.json.client;
    }

    async function patch(client, input) {
        const result = await call(app.baseUrl, app, 'PATCH', `${ROOT}/${client.id}`, input);
        assert.equal(result.status, 200, result.text);
        return result.json.client;
    }

    async function list(baseUrl = app.baseUrl, session = app) {
        const result = await call(baseUrl, session, 'GET', ROOT);
        assert.equal(result.status, 200, result.text);
        return result.json.clients;
    }

    function issue(client, scopes, session = buyer) {
        return authorizeAndToken({
            baseUrl: app.baseUrl, cookie: session.cookie, csrf: session.csrf,
            clientId: client.id, scope: scopes.join(' ')
        });
    }

    async function authorizeCode(client, scopes, session = buyer) {
        const proof = pkce();
        const response = await fetch(`${app.baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                response_type: 'code', client_id: client.id, redirect_uri: REDIRECT_URI,
                scope: scopes.join(' '), state: proof.state, code_challenge: proof.challenge,
                code_challenge_method: 'S256', decision: 'approve', csrf_token: session.csrf
            }),
            redirect: 'manual'
        });
        assert.equal(response.status, 302);
        const code = new URL(response.headers.get('location')).searchParams.get('code');
        assert.ok(code);
        return {
            grant_type: 'authorization_code', client_id: client.id, redirect_uri: REDIRECT_URI,
            code, code_verifier: proof.verifier
        };
    }

    function refresh(client, token) {
        return call(app.baseUrl, null, 'POST', '/oauth/token', {
            grant_type: 'refresh_token', client_id: client.id, refresh_token: token.refresh_token
        });
    }

    function grants(client) {
        return app.db.prepare('SELECT * FROM oauth_grants WHERE client_id = ? ORDER BY id').all(client.id);
    }

    function audits(client, type) {
        return app.db.prepare('SELECT * FROM audit_events WHERE client_id = ? AND event_type = ?').all(client.id, type);
    }

    function mcpTool(token, name) {
        return mcpCall(app.baseUrl, token.access_token, 'tools/call', { name, arguments: {} });
    }

    async function assertWriteDenied(token) {
        const result = await mcpTool(token, 'rateninja_create_booking_request');
        assert.equal(result.status, 200, result.text);
        assert.equal(result.body.result.isError, true);
        assert.equal(result.body.result.structuredContent.error, 'insufficient_scope');
    }

    it('edits name, redirects, scopes and status while keeping the client type fixed', async () => {
        const client = await register('Before edit', [READ, WRITE]);
        const input = {
            displayName: 'After edit', redirectUris: ['https://partner.example/callback'],
            allowedScopes: [READ], status: 'disabled'
        };
        await patch(client, { ...input, clientType: 'confidential' });
        const saved = (await list()).find(row => row.id === client.id);
        assert.deepEqual(saved, {
            ...input, id: client.id, clientType: 'public', hasSecret: false,
            activeGrantCount: 0, canDelete: true
        });
        assert.deepEqual(JSON.parse(audits(client, 'oauth_client_updated')[0].detail), {
            status: 'disabled', removedScopes: WRITE
        });
    });

    it('applies live narrowing to access, refresh and outstanding codes and preserves grants', async () => {
        const client = await register('Scope narrowing', [READ, WRITE]);
        const oldToken = await issue(client, [READ, WRITE]);
        const code = await authorizeCode(client, [READ, WRITE], app);
        const before = grants(client);
        assert.equal(before.length, 2);
        assert.equal((await list()).find(row => row.id === client.id).activeGrantCount, before.length);

        await patch(client, { allowedScopes: [READ] });
        await assertWriteDenied(oldToken);
        const rates = await mcpTool(oldToken, 'rateninja_list_available_rates');
        assert.equal(rates.status, 200, rates.text);
        assert.equal(rates.body.result.isError, false, rates.text);

        const refreshed = await refresh(client, oldToken);
        assert.equal(refreshed.status, 200, refreshed.text);
        assert.equal(refreshed.json.scope, READ);
        const hash = createHash('sha256').update(refreshed.json.refresh_token).digest('hex');
        assert.equal(app.db.prepare('SELECT scopes FROM oauth_refresh_tokens WHERE token_hash = ?').get(hash).scopes, READ);

        const exchanged = await call(app.baseUrl, null, 'POST', '/oauth/token', code);
        assert.equal(exchanged.status, 200, exchanged.text);
        assert.equal(exchanged.json.scope, READ);
        assert.deepEqual(grants(client), before);

        await patch(client, { allowedScopes: [READ, WRITE] });
        await assertWriteDenied(refreshed.json);
        const refreshedAgain = await refresh(client, refreshed.json);
        assert.equal(refreshedAgain.status, 200, refreshedAgain.text);
        assert.equal(refreshedAgain.json.scope, READ);
    });

    it('rejects code exchange and refresh when the allowed scope intersection is empty', async () => {
        const client = await register('Empty intersection', [READ, WRITE]);
        const token = await issue(client, [WRITE]);
        const code = await authorizeCode(client, [WRITE], app);
        await patch(client, { allowedScopes: [READ] });
        for (const result of [
            await call(app.baseUrl, null, 'POST', '/oauth/token', code),
            await refresh(client, token)
        ]) {
            assert.equal(result.status, 400, result.text);
            assert.equal(result.json.error, 'invalid_grant');
        }
    });

    it('requires system admin and CSRF, and protects the seeded ID and legacy display name', async () => {
        const named = await register(CAPACITY_EXCHANGE_DISPLAY_NAME, [READ]);
        const seeded = (await list()).find(row => row.id === CAPACITY_EXCHANGE_CLIENT_ID);
        assert.equal(seeded.canDelete, false);
        const memberPatch = await call(app.baseUrl, buyer, 'PATCH', `${ROOT}/${named.id}`, {});
        const memberDelete = await call(app.baseUrl, buyer, 'DELETE', `${ROOT}/${named.id}`);
        assert.equal(memberDelete.status, 403);
        assert.equal(memberDelete.status, memberPatch.status);
        assert.deepEqual(memberDelete.json, memberPatch.json);
        const noCsrfPatch = await call(app.baseUrl, app, 'PATCH', `${ROOT}/${named.id}`, {}, { csrf: false });
        const noCsrf = await call(app.baseUrl, app, 'DELETE', `${ROOT}/${named.id}`, undefined, { csrf: false });
        assert.equal(noCsrf.status, 403);
        assert.equal(noCsrf.status, noCsrfPatch.status);
        assert.deepEqual(noCsrf.json, noCsrfPatch.json);
        assert.equal((await call(app.baseUrl, app, 'DELETE', `${ROOT}/missing`)).status, 404);

        for (const id of [seeded.id, named.id]) {
            const before = (await list()).find(row => row.id === id);
            assert.equal(before.canDelete, false);
            const result = await call(app.baseUrl, app, 'DELETE', `${ROOT}/${id}`);
            assert.equal(result.status, 409, result.text);
            assert.match(result.json.error, /disable it instead/i);
            assert.deepEqual((await list()).find(row => row.id === id), before);
        }
    });

    it('deletes all client credentials atomically, preserves audits, and stays deleted after boot', async t => {
        const client = await register('Disposable client', [READ]);
        await issue(client, [READ]);
        const active = await issue(client, [READ]);
        const oldAudit = audits(client, 'oauth_client_created')[0];
        const before = grants(client);
        assert.equal(before.length, 2);
        assert.equal(before.filter(grant => grant.revoked_at === null).length, 1);
        assert.equal((await list()).find(row => row.id === client.id).activeGrantCount, 1);

        const consents = () => call(app.baseUrl, buyer, 'GET', '/oauth/consents');
        assert.ok((await consents()).json.grants.some(grant => grant.clientId === client.id));
        const tables = ['oauth_authorization_codes', 'oauth_grants', 'oauth_refresh_tokens'];
        const count = table => app.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE client_id = ?`).get(client.id).count;
        for (const table of tables) assert.ok(count(table) > 0, table);

        // An audit write failure must roll back all four deletes.
        app.db.exec(`CREATE TEMP TRIGGER reject_delete_audit BEFORE INSERT ON audit_events
            WHEN NEW.event_type = 'oauth_client_deleted'
            BEGIN SELECT RAISE(ABORT, 'Synthetic audit failure'); END`);
        try {
            assert.equal((await call(app.baseUrl, app, 'DELETE', `${ROOT}/${client.id}`)).status, 500);
            assert.ok((await list()).some(row => row.id === client.id));
            for (const table of tables) assert.ok(count(table) > 0, table);
        } finally {
            app.db.exec('DROP TRIGGER reject_delete_audit');
        }

        const deleted = await call(app.baseUrl, app, 'DELETE', `${ROOT}/${client.id}`);
        assert.equal(deleted.status, 200, deleted.text);
        assert.ok(!(await list()).some(row => row.id === client.id));
        assert.ok(!(await consents()).json.grants.some(grant => grant.clientId === client.id));
        for (const table of tables) assert.equal(count(table), 0, table);
        const denied = await mcpTool(active, 'rateninja_list_available_rates');
        assert.equal(denied.status, 401, denied.text);
        assert.equal(denied.body.error.message, 'invalid_token');
        assert.deepEqual(audits(client, 'oauth_client_created'), [oldAudit]);
        const event = audits(client, 'oauth_client_deleted')[0];
        assert.equal(event.actor_user_id, adminId);
        assert.deepEqual(JSON.parse(event.detail), { displayName: client.displayName, grantsRemoved: 2 });

        // Stop the original listener, then boot in a fresh process against the same database.
        const { server } = require('../server');
        await new Promise(resolve => server.close(resolve));
        const child = spawn(process.execPath, ['-e', `
            const { ensureFoundation } = require('./lib/foundation');
            const { server } = require('./server');
            ensureFoundation();
            server.listen(0, '127.0.0.1', () => console.log(server.address().port));
        `], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'] });
        const exited = once(child, 'exit');
        t.after(async () => {
            child.kill();
            await exited;
        });
        const lines = createInterface({ input: child.stdout });
        const port = await Promise.race([
            once(lines, 'line').then(([line]) => Number(line)),
            exited.then(([code]) => { throw new Error(`Restart exited early (${code})`); })
        ]);
        const restartedUrl = `http://127.0.0.1:${port}`;
        const restartedAdmin = await login(restartedUrl, app.username, app.password);
        const clients = await list(restartedUrl, restartedAdmin);
        assert.ok(!clients.some(row => row.id === client.id));
        assert.ok(clients.some(row => row.id === CAPACITY_EXCHANGE_CLIENT_ID));
    });
});
