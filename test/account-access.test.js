const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-access-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'access.db');
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 're_test_secret_value';
delete process.env.RESEND_FROM;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { db } = require('../lib/db');
const { ensureFoundation } = require('../lib/foundation');
const { setPasswordByUsername } = require('../lib/accounts');
const { setMailDelivery } = require('../lib/resend');
const { hotp, currentStep } = require('../lib/totp');
const { MAIL_NOT_SENT } = require('../lib/password-reset');

const PASSWORD = 'sail-the-ocean';
const NEXT_PASSWORD = 'harbor-lantern-9';
let baseUrl;
let steve;
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
    warnings.push(args.join(' '));
};

function cookieHeader(response) {
    return (response.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
}

async function login(username, password = PASSWORD) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    return { response, body, cookie: cookieHeader(response) };
}

describe('password reset and optional two-factor', () => {
    before(async () => {
        ensureFoundation();
        assert.equal(setPasswordByUsername('SteveF', PASSWORD).ok, true);
        assert.equal(setPasswordByUsername('Alan', PASSWORD).ok, true);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        const signedIn = await login('SteveF');
        assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body));
        assert.equal(signedIn.body.mfaRequired, undefined);
        assert.ok(signedIn.cookie.includes('rate_ninja_session='));
        steve = { cookie: signedIn.cookie, csrf: signedIn.body.csrfToken };
    });

    after(async () => {
        console.warn = originalWarn;
        await new Promise(resolve => server.close(resolve));
        try {
            db.close();
        } catch {
            // Temporary database.
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serves the login page with password, code, and forgot-password steps', async () => {
        const page = await fetch(`${baseUrl}/login`);
        const html = await page.text();
        assert.equal(page.status, 200);
        assert.match(html, /id="username"/);
        assert.match(html, /id="password"/);
        assert.match(html, /id="mfaForm"/);
        assert.match(html, /Forgot password/);
        assert.match(html, /id="resetForm"/);
    });

    it('accepts a reset request when Resend is not configured and hides the account', async () => {
        warnings.length = 0;
        const missing = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'nobody-home' })
        });
        const known = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'SteveF' })
        });
        const missingBody = await missing.json();
        const knownBody = await known.json();
        assert.equal(missing.status, 200);
        assert.equal(known.status, 200);
        assert.deepEqual(missingBody, knownBody);
        assert.match(missingBody.message, /reset link/i);
        const log = warnings.join('\n');
        assert.match(log, new RegExp(MAIL_NOT_SENT));
        assert.equal(log.includes('re_test_secret_value'), false);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM password_reset_tokens').get().count, 0);
    });

    it('stores only a hash and accepts the reset link once', async () => {
        process.env.RESEND_FROM = 'Rate Ninja <reset@example.com>';
        const sent = [];
        setMailDelivery(async message => {
            sent.push(message);
            return { sent: true };
        });
        const emailSave = await fetch(`${baseUrl}/api/admin/users/${db.prepare(`SELECT id FROM users WHERE username = 'SteveF'`).get().id}`, {
            method: 'PATCH',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ email: 'steve@example.com' })
        });
        assert.equal(emailSave.status, 200, JSON.stringify(await emailSave.clone().json()));

        warnings.length = 0;
        const requested = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'SteveF' })
        });
        assert.equal(requested.status, 200);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].to, 'steve@example.com');
        const token = decodeURIComponent(sent[0].text.match(/reset=([^&\s]+)/)[1]);
        const log = warnings.join('\n');
        assert.equal(log.includes(token), false);
        assert.equal(log.includes('re_test_secret_value'), false);
        const stored = db.prepare('SELECT token_hash, used_at FROM password_reset_tokens').all();
        assert.equal(stored.some(row => row.token_hash === token || String(row.token_hash).includes(token)), false);

        const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password: NEXT_PASSWORD })
        });
        assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));
        const replay = await fetch(`${baseUrl}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password: NEXT_PASSWORD })
        });
        assert.equal(replay.status, 400);

        db.prepare('UPDATE password_reset_tokens SET used_at = NULL, expires_at = 1').run();
        const expired = await fetch(`${baseUrl}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password: NEXT_PASSWORD })
        });
        assert.equal(expired.status, 400);

        const signedIn = await login('SteveF', NEXT_PASSWORD);
        assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body));
        assert.equal(signedIn.body.user.username, 'SteveF');
        steve = { cookie: signedIn.cookie, csrf: signedIn.body.csrfToken };

        const adminSet = await fetch(`${baseUrl}/api/admin/users/${db.prepare(`SELECT id FROM users WHERE username = 'Alan'`).get().id}/password`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ password: PASSWORD })
        });
        assert.equal(adminSet.status, 200, JSON.stringify(await adminSet.clone().json()));
    });

    it('asks for a code only after enrollment and lets an admin clear it', async () => {
        const alan = await login('Alan');
        assert.equal(alan.response.status, 200);
        assert.equal(alan.body.mfaRequired, undefined);
        assert.ok(alan.cookie.includes('rate_ninja_session='));

        const steveId = db.prepare(`SELECT id FROM users WHERE username = 'SteveF'`).get().id;
        const started = await fetch(`${baseUrl}/api/account/2fa/start`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({})
        });
        const startedBody = await started.json();
        assert.equal(started.status, 200, JSON.stringify(startedBody));
        const secret = startedBody.secret;
        const confirmed = await fetch(`${baseUrl}/api/account/2fa/confirm`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ code: hotp(secret, currentStep()) })
        });
        const confirmedBody = await confirmed.json();
        assert.equal(confirmed.status, 200, JSON.stringify(confirmedBody));
        assert.equal(confirmedBody.recoveryCodes.length, 8);
        const stillSignedIn = await fetch(`${baseUrl}/api/session`, { headers: { cookie: steve.cookie } });
        assert.equal(stillSignedIn.status, 200);

        const challenge = await login('SteveF', NEXT_PASSWORD);
        assert.equal(challenge.response.status, 200);
        assert.equal(challenge.body.mfaRequired, true);
        assert.equal(challenge.cookie.includes('rate_ninja_session='), false);
        const authed = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: challenge.body.challenge, code: hotp(secret, currentStep() + 1) })
        });
        const authedBody = await authed.json();
        assert.equal(authed.status, 200, JSON.stringify(authedBody));
        assert.ok(cookieHeader(authed).includes('rate_ninja_session='));
        steve = { cookie: cookieHeader(authed), csrf: authedBody.csrfToken };

        const recoveryLogin = await login('SteveF', NEXT_PASSWORD);
        const withRecovery = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: recoveryLogin.body.challenge, code: confirmedBody.recoveryCodes[0] })
        });
        assert.equal(withRecovery.status, 200);
        const recoveryReplay = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: recoveryLogin.body.challenge, code: confirmedBody.recoveryCodes[0] })
        });
        assert.equal(recoveryReplay.status, 401);

        const cleared = await fetch(`${baseUrl}/api/admin/users/${steveId}/two-factor`, {
            method: 'DELETE',
            headers: { cookie: steve.cookie, 'x-csrf-token': steve.csrf }
        });
        assert.equal(cleared.status, 200, JSON.stringify(await cleared.clone().json()));
        const afterClear = await login('SteveF', NEXT_PASSWORD);
        assert.equal(afterClear.body.mfaRequired, undefined);
        assert.ok(afterClear.cookie.includes('rate_ninja_session='));
        steve = { cookie: afterClear.cookie, csrf: afterClear.body.csrfToken };
    });

    it('builds reset links from the configured origin', async () => {
        process.env.PUBLIC_ORIGIN = 'https://rate-ninja.onrender.com';
        process.env.RESEND_FROM = 'Rate Ninja <reset@example.com>';
        const sent = [];
        setMailDelivery(async message => {
            sent.push(message);
            return { sent: true };
        });
        const requested = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                host: 'evil.example',
                'x-forwarded-host': 'evil.example',
                'x-forwarded-proto': 'https'
            },
            body: JSON.stringify({ username: 'SteveF' })
        });
        assert.equal(requested.status, 200);
        assert.equal(sent.length, 1);
        const link = sent[0].text.match(/https?:\/\/\S+/)[0];
        assert.equal(link.startsWith('https://rate-ninja.onrender.com/login?reset='), true);
        assert.equal(link.includes('evil.example'), false);
    });

    it('keeps the MFA failure counter until success or challenge expiry', async () => {
        const steveId = db.prepare(`SELECT id FROM users WHERE username = 'SteveF'`).get().id;
        const started = await fetch(`${baseUrl}/api/account/2fa/start`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({})
        });
        const startedBody = await started.json();
        assert.equal(started.status, 200, JSON.stringify(startedBody));
        const confirmed = await fetch(`${baseUrl}/api/account/2fa/confirm`, {
            method: 'POST',
            headers: { cookie: steve.cookie, 'content-type': 'application/json', 'x-csrf-token': steve.csrf },
            body: JSON.stringify({ code: hotp(startedBody.secret, currentStep()) })
        });
        assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));

        const first = await login('SteveF', NEXT_PASSWORD);
        assert.equal(first.body.mfaRequired, true);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const failed = await fetch(`${baseUrl}/api/auth/login/mfa`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ challenge: first.body.challenge, code: '000000' })
            });
            assert.equal(failed.status, 401);
        }
        const blocked = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: first.body.challenge, code: '000000' })
        });
        assert.equal(blocked.status, 429);

        const retried = await login('SteveF', NEXT_PASSWORD);
        assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
        assert.equal(retried.body.mfaRequired, true);
        const stillBlocked = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: retried.body.challenge, code: '000000' })
        });
        assert.equal(stillBlocked.status, 429);

        db.prepare('UPDATE login_challenges SET expires_at = 1 WHERE user_id = ?').run(steveId);
        const fresh = await login('SteveF', NEXT_PASSWORD);
        assert.equal(fresh.body.mfaRequired, true);
        const afterExpiry = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: fresh.body.challenge, code: '000000' })
        });
        assert.equal(afterExpiry.status, 401);
    });

    it('invalidates login challenges when the password changes', async () => {
        const pending = await login('SteveF', NEXT_PASSWORD);
        assert.equal(pending.body.mfaRequired, true);
        const replacement = 'pier-lantern-99';
        assert.equal(setPasswordByUsername('SteveF', replacement).ok, true);
        const rejected = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: pending.body.challenge, code: '123456' })
        });
        assert.equal(rejected.status, 401);

        const enrolled = await login('SteveF', replacement);
        assert.equal(enrolled.body.mfaRequired, true);
        process.env.RESEND_FROM = 'Rate Ninja <reset@example.com>';
        const sent = [];
        setMailDelivery(async message => {
            sent.push(message);
            return { sent: true };
        });
        const requested = await fetch(`${baseUrl}/api/auth/forgot-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'SteveF' })
        });
        assert.equal(requested.status, 200);
        const token = decodeURIComponent(sent.at(-1).text.match(/reset=([^&\s]+)/)[1]);
        const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password: 'quay-lantern-44' })
        });
        assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));
        const afterReset = await fetch(`${baseUrl}/api/auth/login/mfa`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ challenge: enrolled.body.challenge, code: '123456' })
        });
        assert.equal(afterReset.status, 401);
    });
});
