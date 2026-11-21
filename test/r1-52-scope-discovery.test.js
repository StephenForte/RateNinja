'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SCOPES } = require('../lib/constants');
const { startApp } = require('./helpers/app');
const { CODE, startCloudBbs } = require('./helpers/r1-37');
const { mcpCall, pkce, REDIRECT_URI } = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CUSTOMER,
    login,
    insertCompany,
    insertUser,
    insertRate,
    insertMargin,
    activate,
    utcDay
} = require('./helpers/r1-19');

const READ = ['profile:read', 'rates:read', 'sailings:read'];
const ALL = SCOPES.join(' ');
const OWNER_WRITE_NOTE = 'This app can approve or decline booking requests for your company.';
const CUSTOMER_WRITE_NOTE = 'This app can request bookings for your company.';
const METADATA = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp'
];

function listedScopes(html) {
    return [...html.matchAll(/<li>([^<]*)<\/li>/g)].map(match => match[1]);
}

function hiddenFields(html) {
    const fields = {};
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
        fields[match[1]] = match[2];
    }
    return fields;
}

describe('R1-52 scope discovery and grant narrowing', { concurrency: 1 }, () => {
    let cloud;
    let app;
    let customer;
    let narrow;
    let full;
    let ratesOnly;

    async function register(name, allowedScopes, clientType = 'confidential') {
        const response = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: name,
                clientType,
                redirectUris: [REDIRECT_URI],
                allowedScopes
            })
        });
        const body = await response.json();
        assert.equal(response.status, 201, JSON.stringify(body));
        return { id: body.client.id, secret: body.clientSecret };
    }

    async function authorizeGet(session, clientId, scope) {
        const proof = pkce();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            state: proof.state,
            code_challenge: proof.challenge,
            code_challenge_method: 'S256'
        });
        if (scope !== undefined) params.set('scope', scope);
        const response = await fetch(`${app.baseUrl}/oauth/authorize?${params}`, {
            headers: { cookie: session.cookie },
            redirect: 'manual'
        });
        const html = await response.text();
        return { response, html, proof };
    }

    async function approveRendered(session, client, html, proof) {
        const fields = hiddenFields(html);
        const approved = await fetch(`${app.baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...fields, decision: 'approve' }),
            redirect: 'manual'
        });
        const location = approved.headers.get('location');
        assert.equal(approved.status, 302, location || html);
        const code = new URL(location).searchParams.get('code');
        assert.ok(code);
        const tokenResponse = await fetch(`${app.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: client.id,
                client_secret: client.secret,
                code_verifier: proof.verifier
            })
        });
        const token = await tokenResponse.json();
        assert.equal(tokenResponse.status, 200, JSON.stringify(token));
        return { token, fields };
    }

    function storedScopes(clientId) {
        const grant = app.db.prepare(`
            SELECT scopes FROM oauth_grants WHERE client_id = ? AND revoked_at IS NULL
        `).get(clientId);
        const code = app.db.prepare(`
            SELECT scopes FROM oauth_authorization_codes WHERE client_id = ? ORDER BY created_at DESC LIMIT 1
        `).get(clientId);
        return { grant: grant && grant.scopes, code: code && code.scopes };
    }

    before(async () => {
        cloud = await startCloudBbs();
        cloud.configureServer();
        app = await startApp({ companyName: 'Synthetic R52 Owner' });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        insertCompany(app.db, { id: 'r152-buyer', name: 'Synthetic R52 Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(app.db, { id: 'r152-buyer-user', username: 'r152-buyer', companyId: 'r152-buyer' });
        activate('r152-buyer');
        customer = await login(app.baseUrl, 'r152-buyer');
        insertMargin(app.db, { id: 'r152-link', owner: app.company.id, customer: 'r152-buyer', percent: 0.1 });
        insertRate(app.db, {
            id: 'r152-rate',
            owner: app.company.id,
            rate20: 1000,
            expiration: utcDay(40)
        });
        narrow = await register('R52 Narrow', READ);
        full = await register('R52 Full', [...SCOPES]);
        ratesOnly = await register('R52 Rates', ['rates:read']);
    });

    after(async () => {
        await app?.close();
        await cloud?.close();
    });

    it('publishes SCOPES, in order, from all three metadata documents', async () => {
        for (const pathname of METADATA) {
            const response = await fetch(`${app.baseUrl}${pathname}`);
            const body = await response.json();
            assert.equal(response.status, 200, JSON.stringify(body));
            assert.deepEqual(body.scopes_supported, SCOPES, pathname);
        }
    });

    it('grants a three-scope client only its three scopes when the request asks for all five', async () => {
        const consent = await authorizeGet(customer, narrow.id, ALL);
        assert.equal(consent.response.status, 200, consent.html);
        assert.deepEqual(listedScopes(consent.html), READ);
        assert.equal(consent.html.includes(OWNER_WRITE_NOTE), false);
        assert.equal(consent.html.includes(CUSTOMER_WRITE_NOTE), false);
        assert.equal(hiddenFields(consent.html).scope, READ.join(' '));

        const { token } = await approveRendered(customer, narrow, consent.html, consent.proof);
        assert.equal(token.scope, READ.join(' '));
        const stored = storedScopes(narrow.id);
        assert.equal(stored.grant, READ.join(' '));
        assert.equal(stored.code, READ.join(' '));

        const denied = await mcpCall(app.baseUrl, token.access_token, 'tools/call', {
            name: 'rateninja_create_booking_request',
            arguments: { rateId: 'r152-rate', containerSize: '20D', slots: 1, bookingCode: CODE }
        });
        assert.equal(denied.body.result.structuredContent.error, 'insufficient_scope');
    });

    it('grants all five scopes to an allowed customer and lets create pass the scope check', async () => {
        const consent = await authorizeGet(customer, full.id, ALL);
        assert.equal(consent.response.status, 200, consent.html);
        assert.deepEqual(listedScopes(consent.html), [...SCOPES]);
        assert.match(consent.html, new RegExp(CUSTOMER_WRITE_NOTE));
        assert.equal(consent.html.includes(OWNER_WRITE_NOTE), false);

        const { token } = await approveRendered(customer, full, consent.html, consent.proof);
        assert.equal(token.scope, ALL);
        const stored = storedScopes(full.id);
        assert.equal(stored.grant, ALL);
        assert.equal(stored.code, ALL);

        const created = await mcpCall(app.baseUrl, token.access_token, 'tools/call', {
            name: 'rateninja_create_booking_request',
            arguments: { rateId: 'r152-rate', containerSize: '20D', slots: 1, bookingCode: CODE }
        });
        assert.notEqual(created.body.result?.structuredContent?.error, 'insufficient_scope', created.text);
        assert.equal(created.body.result.isError, false, created.text);
    });

    it('drops an unknown scope and duplicate names, keeping request order', async () => {
        const consent = await authorizeGet(customer, ratesOnly.id, 'sailings:read rates:read foo:bar rates:read');
        assert.equal(consent.response.status, 200, consent.html);
        assert.deepEqual(listedScopes(consent.html), ['rates:read']);
        const { token } = await approveRendered(customer, ratesOnly, consent.html, consent.proof);
        assert.equal(token.scope, 'rates:read');
        const stored = storedScopes(ratesOnly.id);
        assert.equal(stored.grant, 'rates:read');
        assert.equal(stored.code, 'rates:read');

        const ordered = await authorizeGet(customer, narrow.id, 'sailings:read rates:read foo:bar rates:read');
        assert.equal(ordered.response.status, 200, ordered.html);
        assert.deepEqual(listedScopes(ordered.html), ['sailings:read', 'rates:read']);
        assert.equal(hiddenFields(ordered.html).scope, 'sailings:read rates:read');
    });

    it('answers invalid_scope when the intersection is empty or scope is blank or missing', async () => {
        for (const scope of ['bookings:write', 'foo:bar', '', '   ', undefined]) {
            const consent = await authorizeGet(customer, narrow.id, scope);
            assert.equal(consent.response.status, 302, `${JSON.stringify(scope)} ${consent.html}`);
            assert.match(consent.response.headers.get('location'), /error=invalid_scope/, JSON.stringify(scope));
        }
    });

    it('posts the scopes the consent page showed after the client is widened', async () => {
        const consent = await authorizeGet(customer, narrow.id, ALL);
        assert.equal(consent.response.status, 200, consent.html);
        const shown = listedScopes(consent.html);
        assert.deepEqual(shown, READ);
        const fields = hiddenFields(consent.html);
        assert.equal(fields.scope, shown.join(' '));

        const widened = await app.request(`/api/admin/oauth-clients/${narrow.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ allowedScopes: [...SCOPES] })
        });
        const widenedBody = await widened.json();
        assert.equal(widened.status, 200, JSON.stringify(widenedBody));
        assert.deepEqual(widenedBody.client.allowedScopes, [...SCOPES]);

        const { token } = await approveRendered(customer, narrow, consent.html, consent.proof);
        assert.equal(token.scope, shown.join(' '));
        const stored = storedScopes(narrow.id);
        assert.equal(stored.grant, shown.join(' '));
        assert.equal(stored.code, shown.join(' '));
        assert.equal(token.scope.includes('bookings:'), false);
    });

    it('shows the bookings:write note only when that scope is granted', async () => {
        const owner = { cookie: app.cookie };
        const ownerWrite = await authorizeGet(owner, full.id, 'bookings:write');
        assert.equal(ownerWrite.response.status, 200, ownerWrite.html);
        assert.deepEqual(listedScopes(ownerWrite.html), ['bookings:write']);
        assert.match(ownerWrite.html, new RegExp(OWNER_WRITE_NOTE));
        assert.equal(ownerWrite.html.includes(CUSTOMER_WRITE_NOTE), false);

        const customerRead = await authorizeGet(customer, full.id, 'rates:read');
        assert.equal(customerRead.response.status, 200, customerRead.html);
        assert.deepEqual(listedScopes(customerRead.html), ['rates:read']);
        assert.equal(customerRead.html.includes(OWNER_WRITE_NOTE), false);
        assert.equal(customerRead.html.includes(CUSTOMER_WRITE_NOTE), false);
    });

    it('still rejects an unknown scope when an administrator registers a client', async () => {
        const response = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'R52 Unknown',
                clientType: 'public',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['rates:read', 'foo:bar']
            })
        });
        const body = await response.json();
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.equal(body.error, 'Choose at least one allowed scope.');
    });
});
