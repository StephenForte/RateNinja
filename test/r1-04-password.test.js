'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RESEND_API_KEY = 're_r104_test_key';
process.env.RESEND_FROM = 'Rate Ninja <reset@example.com>';
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:9';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { insertMember, login, call, pkce, auditContainsSecret } = require('./helpers/r1-04');

const INITIAL = 'harbor-lantern-1';
const NEXT = 'harbor-lantern-2';
const TEMP = 'harbor-lantern-3';
const CHOSEN = 'harbor-lantern-4';
const RESET_CHOSEN = 'harbor-lantern-5';
const SHORT = 'too-short';
const WRONG = 'not-the-current';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';
const secrets = [INITIAL, NEXT, TEMP, CHOSEN, RESET_CHOSEN, SHORT, WRONG];

function row(db, username) {
    return db.prepare(`
        SELECT id, password_hash, session_epoch, must_change_password, password_changed_at
        FROM users WHERE username = ?
    `).get(username);
}

function authorizeQuery(proof) {
    return new URLSearchParams({
        response_type: 'code',
        client_id: 'rn-r104',
        redirect_uri: REDIRECT_URI,
        scope: 'profile:read',
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256'
    });
}

describe('r1-04 password lifecycle', { concurrency: 1 }, () => {
    let app;
    let setPasswordByUsername;
    let setMailDelivery;
    let hotp;
    let currentStep;
    let sent;
    const admin = () => ({ cookie: app.cookie, csrf: app.csrf });

    before(async () => {
        app = await startApp({
            username: 'owner-admin',
            companyName: 'Owner Co',
            companyType: 'Contract Owner',
            role: 'admin'
        });
        ({ setPasswordByUsername } = require('../lib/accounts'));
        ({ setMailDelivery } = require('../lib/resend'));
        ({ hotp, currentStep } = require('../lib/totp'));
        sent = [];
        setMailDelivery(async message => {
            sent.push(message);
            return { sent: true };
        });
        const now = new Date().toISOString();
        app.db.prepare(`
            INSERT INTO oauth_clients (
                id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
            ) VALUES ('rn-r104', 'R104 Client', NULL, 'public', ?, ?, 'active', ?, ?)
        `).run(JSON.stringify([REDIRECT_URI]), JSON.stringify(['profile:read']), now, now);
        secrets.push(app.password);
    });

    after(async () => {
        if (setMailDelivery) setMailDelivery(null);
        if (app) await app.close();
    });

    function addUser({ id, username, password, email = null, adminScreen = 0, companyId = app.company.id }) {
        insertMember(app.db, { id, username, companyId, email, adminScreen });
        if (password) {
            const set = setPasswordByUsername(username, password);
            assert.equal(set.ok, true, set.error);
        }
    }

    it('rejects a wrong, mismatched, short, or unchanged password without changing the account', async () => {
        addUser({ id: 'user-fields', username: 'field-user', password: INITIAL, email: 'field-user@example.com' });
        const auth = await login(app.baseUrl, 'field-user', INITIAL);
        assert.equal(auth.response.status, 200);
        const before = row(app.db, 'field-user');

        const wrong = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: WRONG,
            newPassword: NEXT,
            confirmPassword: NEXT
        });
        assert.equal(wrong.status, 400);
        assert.equal(wrong.json.field, 'currentPassword');
        assert.equal(wrong.json.error, 'Current password is incorrect.');

        const mismatch = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: NEXT,
            confirmPassword: `${NEXT}-no`
        });
        assert.equal(mismatch.status, 400);
        assert.equal(mismatch.json.field, 'confirmPassword');

        const short = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: SHORT,
            confirmPassword: SHORT
        });
        assert.equal(short.status, 400);
        assert.equal(short.json.field, 'newPassword');
        assert.match(short.json.error, /12/);
        assert.deepEqual(row(app.db, 'field-user'), before);

        const still = await call(app.baseUrl, auth, 'GET', '/api/session');
        assert.equal(still.status, 200);
        assert.equal(still.json.user.mustChangePassword, false);

        app.db.prepare('UPDATE users SET must_change_password = 1 WHERE username = ?').run('field-user');
        const same = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: INITIAL,
            confirmPassword: INITIAL
        });
        assert.equal(same.status, 400);
        assert.equal(same.json.field, 'newPassword');
        assert.match(same.json.error, /different/);
        const kept = row(app.db, 'field-user');
        assert.equal(kept.must_change_password, 1);
        assert.equal(kept.password_hash, before.password_hash);
        const gated = await call(app.baseUrl, auth, 'GET', '/api/rates');
        assert.equal(gated.status, 403);
        assert.equal(gated.json.code, 'password_change_required');
    });

    it('throttles repeated wrong current passwords with the login limiter', async () => {
        addUser({ id: 'user-throttle', username: 'throttle-user', password: INITIAL });
        const auth = await login(app.baseUrl, 'throttle-user', INITIAL);
        const before = row(app.db, 'throttle-user');
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            const denied = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
                currentPassword: WRONG,
                newPassword: NEXT,
                confirmPassword: NEXT
            });
            assert.equal(denied.status, 400, `attempt ${attempt}`);
            assert.equal(denied.json.field, 'currentPassword');
        }
        const limited = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: NEXT,
            confirmPassword: NEXT
        });
        assert.equal(limited.status, 429);
        assert.equal(limited.json.error, 'Too many attempts. Try again later.');
        assert.deepEqual(row(app.db, 'throttle-user'), before);
    });

    it('drops every session, challenge, and reset link when the password changes', async () => {
        addUser({ id: 'user-change', username: 'change-user', password: INITIAL, email: 'change-user@example.com' });
        const first = await login(app.baseUrl, 'change-user', INITIAL);
        const second = await login(app.baseUrl, 'change-user', INITIAL);
        assert.equal(first.response.status, 200);
        assert.equal(second.response.status, 200);
        assert.notEqual(first.cookie, second.cookie);

        const started = await call(app.baseUrl, first, 'POST', '/api/account/2fa/start', {});
        assert.equal(started.status, 200);
        const secret = started.json.secret;
        secrets.push(secret);
        const confirmed = await call(app.baseUrl, first, 'POST', '/api/account/2fa/confirm', {
            code: hotp(secret, currentStep())
        });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
        const recovery = confirmed.json.recoveryCodes[0];
        secrets.push(...confirmed.json.recoveryCodes);

        sent.length = 0;
        const requested = await call(app.baseUrl, null, 'POST', '/api/auth/forgot-password', { username: 'change-user' });
        assert.equal(requested.status, 200);
        assert.equal(sent.length, 1);
        const token = decodeURIComponent(sent[0].text.match(/reset=([^&\s]+)/)[1]);
        secrets.push(token);

        const challenged = await login(app.baseUrl, 'change-user', INITIAL);
        assert.equal(challenged.body.mfaRequired, true);
        secrets.push(challenged.body.challenge);
        const openChallenges = app.db.prepare(`
            SELECT COUNT(*) AS count FROM login_challenges WHERE user_id = 'user-change' AND used_at IS NULL
        `).get().count;
        assert.equal(openChallenges, 1);

        const changed = await call(app.baseUrl, first, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: NEXT,
            confirmPassword: NEXT
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.json.signInAgain, true);
        const after = row(app.db, 'change-user');
        assert.equal(after.must_change_password, 0);
        assert.ok(after.password_changed_at);
        assert.equal(app.db.prepare(`
            SELECT COUNT(*) AS count FROM login_challenges WHERE user_id = 'user-change' AND used_at IS NULL
        `).get().count, 0);
        assert.equal(app.db.prepare(`
            SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = 'user-change' AND used_at IS NULL
        `).get().count, 0);

        const firstGone = await call(app.baseUrl, first, 'GET', '/api/session');
        const secondGone = await call(app.baseUrl, second, 'GET', '/api/session');
        assert.equal(firstGone.status, 401);
        assert.equal(secondGone.status, 401);

        const staleChallenge = await call(app.baseUrl, null, 'POST', '/api/auth/login/mfa', {
            challenge: challenged.body.challenge,
            code: recovery
        });
        assert.equal(staleChallenge.status, 401);
        const staleReset = await call(app.baseUrl, null, 'POST', '/api/auth/reset-password', {
            token,
            password: CHOSEN
        });
        assert.equal(staleReset.status, 400);

        const relogin = await login(app.baseUrl, 'change-user', NEXT);
        assert.equal(relogin.body.mfaRequired, true);
        const authed = await call(app.baseUrl, null, 'POST', '/api/auth/login/mfa', {
            challenge: relogin.body.challenge,
            code: recovery
        });
        assert.equal(authed.status, 200, JSON.stringify(authed.json));
        const cookie = (authed.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
        assert.match(cookie, /rate_ninja_session=/);
        const signedIn = { cookie, csrf: authed.json.csrfToken };
        const rates = await call(app.baseUrl, signedIn, 'GET', '/api/rates');
        assert.equal(rates.status, 200);
        const profile = await call(app.baseUrl, signedIn, 'GET', '/api/session');
        assert.equal(profile.json.user.mustChangePassword, false);
    });

    it('reads must_change_password from the live row and blocks both dispatch paths', async () => {
        addUser({ id: 'user-gate', username: 'gate-user', password: INITIAL, adminScreen: 1 });
        const auth = await login(app.baseUrl, 'gate-user', INITIAL);
        const other = await login(app.baseUrl, 'gate-user', INITIAL);
        assert.equal(auth.body.user.mustChangePassword, false);
        const ratesBefore = await call(app.baseUrl, auth, 'GET', '/api/rates');
        assert.equal(ratesBefore.status, 200);
        const epoch = row(app.db, 'gate-user').session_epoch;
        app.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run('user-gate');
        assert.equal(row(app.db, 'gate-user').session_epoch, epoch);

        const session = await call(app.baseUrl, auth, 'GET', '/api/session');
        assert.equal(session.status, 200);
        assert.equal(session.json.user.mustChangePassword, true);
        assert.equal(session.json.user.isAdmin, true);
        assert.equal(session.json.user.isContractOwner, true);

        for (const [method, path, body] of [
            ['GET', '/api/rates'],
            ['GET', '/api/sailings'],
            ['GET', '/api/admin/users'],
            ['POST', '/api/account/2fa/start', {}],
            ['GET', '/oauth/consents'],
            ['GET', '/api/admin/context']
        ]) {
            const blocked = await call(app.baseUrl, auth, method, path, body);
            assert.equal(blocked.status, 403, `${method} ${path}`);
            assert.equal(blocked.json.code, 'password_change_required', `${method} ${path} ${blocked.text}`);
        }

        const loggedOut = await call(app.baseUrl, other, 'POST', '/api/auth/logout');
        assert.equal(loggedOut.status, 204);
        const afterLogout = await call(app.baseUrl, other, 'GET', '/api/session');
        assert.equal(afterLogout.status, 401);

        const changed = await call(app.baseUrl, auth, 'POST', '/api/account/password', {
            currentPassword: INITIAL,
            newPassword: NEXT,
            confirmPassword: NEXT
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.json.signInAgain, true);
        const signedOut = await call(app.baseUrl, auth, 'GET', '/api/session');
        assert.equal(signedOut.status, 401);

        const again = await login(app.baseUrl, 'gate-user', NEXT);
        assert.equal(again.body.user.mustChangePassword, false);
        const open = await call(app.baseUrl, again, 'GET', '/api/rates');
        assert.equal(open.status, 200);
    });

    it('makes an admin-set password temporary and keeps company scope', async () => {
        addUser({ id: 'user-temp', username: 'temp-user', password: INITIAL });
        app.db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
            VALUES ('other-co', 'other-co', 'Other Co', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
        `).run();
        addUser({ id: 'user-other', username: 'other-user', password: INITIAL, companyId: 'other-co' });
        const existing = await login(app.baseUrl, 'temp-user', INITIAL);
        assert.equal(existing.body.user.mustChangePassword, false);

        const beforeOther = row(app.db, 'other-user');
        const hidden = await call(app.baseUrl, admin(), 'POST', '/api/admin/users/user-other/password', { password: TEMP });
        assert.equal(hidden.status, 404);
        assert.deepEqual(row(app.db, 'other-user'), beforeOther);

        const beforeHash = beforeOther.password_hash;
        const set = await call(app.baseUrl, admin(), 'POST', '/api/admin/users/user-temp/password', { password: TEMP });
        assert.equal(set.status, 200, JSON.stringify(set.json));
        assert.equal(set.json.signedOut, false);
        assert.equal(row(app.db, 'temp-user').must_change_password, 1);
        assert.notEqual(row(app.db, 'other-user').password_hash, null);
        assert.equal(row(app.db, 'other-user').password_hash, beforeHash);
        const oldSession = await call(app.baseUrl, existing, 'GET', '/api/rates');
        assert.equal(oldSession.status, 401);

        const restricted = await login(app.baseUrl, 'temp-user', TEMP);
        assert.equal(restricted.response.status, 200);
        assert.equal(restricted.body.user.mustChangePassword, true);
        const blocked = await call(app.baseUrl, restricted, 'GET', '/api/rates');
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.code, 'password_change_required');

        const changed = await call(app.baseUrl, restricted, 'POST', '/api/account/password', {
            currentPassword: TEMP,
            newPassword: CHOSEN,
            confirmPassword: CHOSEN
        });
        assert.equal(changed.status, 200);
        const unlocked = await login(app.baseUrl, 'temp-user', CHOSEN);
        assert.equal(unlocked.body.user.mustChangePassword, false);
        const rates = await call(app.baseUrl, unlocked, 'GET', '/api/rates');
        assert.equal(rates.status, 200);
        assert.equal(row(app.db, 'temp-user').must_change_password, 0);

        const event = app.db.prepare(`
            SELECT actor_user_id, detail FROM audit_events WHERE event_type = 'temporary_password_set' ORDER BY created_at DESC
        `).get();
        const adminId = app.db.prepare('SELECT id FROM users WHERE username = ?').get(app.username).id;
        assert.equal(event.actor_user_id, adminId);
        assert.equal(JSON.parse(event.detail).targetUserId, 'user-temp');
    });

    it('clears the temporary-password flag when an emailed reset completes', async () => {
        addUser({ id: 'user-reset', username: 'reset-user', password: INITIAL, email: 'reset-user@example.com' });
        const set = await call(app.baseUrl, admin(), 'POST', '/api/admin/users/user-reset/password', { password: TEMP });
        assert.equal(set.status, 200);
        assert.equal(row(app.db, 'reset-user').must_change_password, 1);
        sent.length = 0;
        const requested = await call(app.baseUrl, null, 'POST', '/api/auth/forgot-password', { username: 'reset-user' });
        assert.equal(requested.status, 200);
        const missing = await call(app.baseUrl, null, 'POST', '/api/auth/forgot-password', { username: 'nobody-r104' });
        assert.equal(missing.status, 200);
        assert.equal(missing.json.message, requested.json.message);
        const token = decodeURIComponent(sent[0].text.match(/reset=([^&\s]+)/)[1]);
        secrets.push(token);
        const reset = await call(app.baseUrl, null, 'POST', '/api/auth/reset-password', {
            token,
            password: RESET_CHOSEN
        });
        assert.equal(reset.status, 200, JSON.stringify(reset.json));
        const replay = await call(app.baseUrl, null, 'POST', '/api/auth/reset-password', {
            token,
            password: RESET_CHOSEN
        });
        assert.equal(replay.status, 400);
        assert.equal(row(app.db, 'reset-user').must_change_password, 0);
        assert.ok(row(app.db, 'reset-user').password_changed_at);
        const signedIn = await login(app.baseUrl, 'reset-user', RESET_CHOSEN);
        assert.equal(signedIn.body.user.mustChangePassword, false);
        const rates = await call(app.baseUrl, signedIn, 'GET', '/api/rates');
        assert.equal(rates.status, 200);
    });

    it('refuses partner authorization for a restricted contract owner and creates no grant', async () => {
        addUser({ id: 'user-oauth', username: 'oauth-user', password: INITIAL, adminScreen: 1 });
        const auth = await login(app.baseUrl, 'oauth-user', INITIAL);
        assert.equal(auth.body.user.isContractOwner, true);
        assert.equal(auth.body.user.mustChangePassword, false);
        app.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run('user-oauth');
        const proof = pkce();
        const query = authorizeQuery(proof);
        const page = await fetch(`${app.baseUrl}/oauth/authorize?${query}`, {
            headers: { cookie: auth.cookie },
            redirect: 'manual'
        });
        const html = await page.text();
        assert.equal(page.status, 403);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(html, /must set a new password/);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = 'user-oauth'`).get().count, 0);

        const body = new URLSearchParams(query);
        body.set('decision', 'approve');
        body.set('csrf_token', auth.csrf);
        const posted = await fetch(`${app.baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: {
                cookie: auth.cookie,
                'content-type': 'application/x-www-form-urlencoded',
                'x-csrf-token': auth.csrf
            },
            body,
            redirect: 'manual'
        });
        const postedHtml = await posted.text();
        assert.equal(posted.status, 403);
        assert.match(postedHtml, /must set a new password/);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = 'user-oauth'`).get().count, 0);

        const open = await fetch(`${app.baseUrl}/oauth/authorize?${authorizeQuery(pkce())}`, {
            headers: { cookie: app.cookie },
            redirect: 'manual'
        });
        const openHtml = await open.text();
        assert.equal(open.status, 200);
        assert.match(openHtml, /wants to read data/);
        assert.equal(openHtml.includes('must set a new password'), false);
    });

    it('keeps passwords and tokens out of audit details', () => {
        const changed = app.db.prepare(`
            SELECT actor_user_id, detail FROM audit_events WHERE event_type = 'password_changed'
        `).all();
        assert.ok(changed.length >= 1);
        for (const event of changed) {
            const detail = JSON.parse(event.detail);
            assert.equal(typeof event.actor_user_id, 'string');
            assert.equal(detail.targetUserId, event.actor_user_id);
        }
        assert.equal(auditContainsSecret(app.db, secrets), false);
    });

    it('returns account details for an unrestricted session', async () => {
        const profile = await call(app.baseUrl, admin(), 'GET', '/api/account');
        assert.equal(profile.status, 200);
        assert.equal(profile.json.loginName, 'owner-admin');
        assert.equal(profile.json.displayName, 'owner-admin');
        assert.equal(profile.json.companyName, 'Owner Co');
        assert.match(profile.json.role, /Company administrator/);
        assert.equal(Object.hasOwn(profile.json, 'password'), false);
    });
});
