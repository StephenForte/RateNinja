'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, call, counts, login, nestedKeys } = require('./helpers/r1-06');

const TEMP = 'temporary-pass-1';
const REPLACEMENT = 'replaced-pass-99';
const REDIRECT = 'http://127.0.0.1:9/callback';

describe('r1-06 company user management', { concurrency: 1 }, () => {
    let app;
    let admin;
    let ownerId;

    before(async () => {
        app = await startApp({
            companyType: 'Contract Owner',
            role: 'admin',
            username: 'r106-owner-admin',
            companyName: 'Owner Co'
        });
        admin = { cookie: app.cookie, csrf: app.csrf };
        ownerId = app.company.id;
        const now = new Date().toISOString();
        app.db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
            VALUES ('customer-linked', 'customer-linked', 'Linked Customer', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 'customer-linked', 0)
        `).run();
        app.db.prepare(`
            INSERT INTO company_margins (
                id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at, status, authorized_at
            ) VALUES ('link-r106', ?, 'customer-linked', 0.1, 5, ?, ?, 'active', ?)
        `).run(ownerId, now, now, now);
        app.db.prepare(`
            INSERT INTO users (
                id, username, display_name, email, admin_screen, disabled, session_epoch,
                company_record_id, company_id, company_reference, company_role, is_system_admin,
                password_hash, pwd, totp_secret
            ) VALUES (
                'other-user', 'other-user', 'Other User', 'other@example.com', 0, 0, 0,
                'customer-linked', 'customer-linked', 'customer-linked', 'member', 0,
                'hash-keep', 'plain-pwd-value', 'super-secret-totp'
            )
        `).run();
    });

    after(async () => {
        if (app) await app.close();
    });

    function row(id) {
        return app.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    it('keeps secrets out of the user list', async () => {
        app.db.prepare(`UPDATE users SET pwd = 'plain-pwd-value', totp_secret = 'super-secret-totp' WHERE username = ?`).run(app.username);
        const listed = await call(app.baseUrl, admin, 'GET', '/api/admin/users');
        assert.equal(listed.status, 200, listed.text);
        const keys = nestedKeys(listed.json);
        for (const secret of ['password_hash', 'totp_secret', 'pwd']) {
            assert.equal(keys.includes(secret), false, secret);
        }
        assert.equal(listed.text.includes('plain-pwd-value'), false);
        assert.equal(listed.text.includes('super-secret-totp'), false);
        assert.equal(listed.text.includes('hash-keep'), false);
        const self = listed.json.users.find(user => user.loginName === app.username);
        assert.equal(self.role, 'company_admin');
        assert.equal(self.active, true);
        assert.equal(typeof self.twoFactorEnrolled, 'boolean');
        assert.ok(self.displayName);
        assert.ok(self.email === '' || typeof self.email === 'string');
    });

    it('refuses cross-company create, edit, role, deactivate, and reset even for a linked customer', async () => {
        const before = row('other-user');
        const beforeCounts = counts(app.db);
        const created = await call(app.baseUrl, admin, 'POST', '/api/admin/users', {
            displayName: 'Smuggled',
            email: 'smuggled@example.com',
            loginName: 'smuggled-user',
            role: 'member',
            temporaryPassword: TEMP,
            companyId: 'customer-linked'
        });
        assert.equal(created.status, 409, created.text);
        assert.equal(created.json.code, 'company_context_mismatch');
        for (const [method, path, body] of [
            ['PATCH', '/api/admin/users/other-user', { displayName: 'Changed', email: 'changed@example.com' }],
            ['POST', '/api/admin/users/other-user/role', { role: 'company_admin' }],
            ['PATCH', '/api/admin/users/other-user', { disabled: true }],
            ['POST', '/api/admin/users/other-user/password', { password: TEMP }],
            ['DELETE', '/api/admin/users/other-user/two-factor', {}]
        ]) {
            const hidden = await call(app.baseUrl, admin, method, path, body);
            assert.equal(hidden.status, 404, `${method} ${path} ${hidden.text}`);
        }
        assert.equal(row('other-user').email, before.email);
        assert.equal(row('other-user').display_name, before.display_name);
        assert.equal(row('other-user').company_role, before.company_role);
        assert.equal(row('other-user').disabled, before.disabled);
        assert.equal(row('other-user').password_hash, before.password_hash);
        assert.equal(row('other-user').totp_secret, before.totp_secret);
        assert.deepEqual(counts(app.db), beforeCounts);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM users WHERE username = 'smuggled-user'`).get().count, 0);
    });

    it('refuses isSystemAdmin and a system_admin role without writing', async () => {
        const before = counts(app.db);
        const flagged = await call(app.baseUrl, admin, 'POST', '/api/admin/users', {
            displayName: 'Elevated',
            email: 'elevated.user@example.com',
            loginName: 'elevated-user',
            role: 'member',
            temporaryPassword: TEMP,
            isSystemAdmin: true
        });
        assert.equal(flagged.status, 400, flagged.text);
        const named = await call(app.baseUrl, admin, 'POST', '/api/admin/users', {
            displayName: 'Elevated',
            email: 'elevated.user@example.com',
            loginName: 'elevated-user',
            role: 'system_admin',
            temporaryPassword: TEMP
        });
        assert.equal(named.status, 400, named.text);
        const roleFlag = await call(app.baseUrl, admin, 'POST', '/api/admin/users/other-user/role', {
            role: 'member',
            isSystemAdmin: false
        });
        assert.equal(roleFlag.status, 400, roleFlag.text);
        assert.deepEqual(counts(app.db), before);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM users WHERE is_system_admin = 1`).get().count, 0);
        assert.equal(row('other-user').company_role, 'member');
    });

    it('refuses demoting the last active company admin', async () => {
        const adminId = app.db.prepare('SELECT id FROM users WHERE username = ?').get(app.username).id;
        const before = row(adminId);
        const demoted = await call(app.baseUrl, admin, 'POST', `/api/admin/users/${adminId}/role`, { role: 'member' });
        assert.equal(demoted.status, 409, demoted.text);
        assert.match(demoted.json.error, /company administrator/i);
        const after = row(adminId);
        assert.equal(after.company_role, 'company_admin');
        assert.equal(after.session_epoch, before.session_epoch);
    });

    it('creates a member, edits them, changes their role, and keeps the temporary-password gate', async () => {
        const before = counts(app.db);
        const created = await call(app.baseUrl, admin, 'POST', '/api/admin/users', {
            displayName: 'New Member',
            email: 'new.member@example.com',
            role: 'member',
            temporaryPassword: TEMP,
            companyId: ownerId
        });
        assert.equal(created.status, 200, created.text);
        assert.equal(created.text.includes(TEMP), false);
        assert.equal(created.json.user.loginName, 'new.member@example.com');
        assert.equal(created.json.user.role, 'member');
        const member = app.db.prepare(`SELECT * FROM users WHERE id = ?`).get(created.json.user.id);
        assert.equal(member.company_record_id, ownerId);
        assert.equal(member.must_change_password, 1);
        assert.equal(member.is_system_admin, 0);
        assert.equal(counts(app.db).users, before.users + 1);

        const edited = await call(app.baseUrl, admin, 'PATCH', `/api/admin/users/${member.id}`, {
            displayName: 'Renamed Member',
            email: 'renamed.member@example.com',
            companyId: ownerId
        });
        assert.equal(edited.status, 200, edited.text);
        assert.equal(row(member.id).display_name, 'Renamed Member');
        assert.equal(row(member.id).email, 'renamed.member@example.com');

        const promoted = await call(app.baseUrl, admin, 'POST', `/api/admin/users/${member.id}/role`, {
            role: 'company_admin',
            companyId: ownerId
        });
        assert.equal(promoted.status, 200, promoted.text);
        assert.equal(row(member.id).company_role, 'company_admin');
        assert.ok(row(member.id).session_epoch > member.session_epoch);

        const session = await login(app.baseUrl, 'new.member@example.com', TEMP);
        assert.equal(session.status, 200, JSON.stringify(session.json));
        const blocked = await call(app.baseUrl, session, 'GET', '/api/rates');
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.code, 'password_change_required');

        const reset = await call(app.baseUrl, admin, 'POST', `/api/admin/users/${member.id}/password`, {
            password: REPLACEMENT,
            companyId: ownerId
        });
        assert.equal(reset.status, 200, reset.text);
        assert.equal(row(member.id).must_change_password, 1);
    });

    it('revokes OAuth credentials on deactivation and leaves them revoked after reactivation', async () => {
        const platformPassword = 'platform-admin-1';
        app.db.prepare(`
            INSERT INTO users (
                id, username, display_name, admin_screen, disabled, session_epoch,
                company_record_id, company_id, company_reference, company_role, is_system_admin
            ) VALUES (
                'platform-admin', 'platform-admin', 'Platform', 0, 0, 0,
                ?, ?, ?, 'member', 1
            )
        `).run(ownerId, ownerId, ownerId);
        const { setPasswordByUsername } = require('../lib/accounts');
        const password = setPasswordByUsername('platform-admin', platformPassword);
        assert.equal(password.ok, true, password.error);
        const platform = await login(app.baseUrl, 'platform-admin', platformPassword);
        assert.equal(platform.status, 200, JSON.stringify(platform.json));
        const client = await call(app.baseUrl, platform, 'POST', '/api/admin/oauth-clients', {
            displayName: 'R106 Partner',
            clientType: 'confidential',
            redirectUris: [REDIRECT],
            allowedScopes: ['profile:read', 'rates:read', 'sailings:read']
        });
        assert.equal(client.status, 201, client.text);

        const created = await call(app.baseUrl, admin, 'POST', '/api/admin/users', {
            displayName: 'Partner Member',
            email: 'partner.member@example.com',
            loginName: 'partner-member',
            role: 'member',
            temporaryPassword: TEMP,
            companyId: ownerId
        });
        assert.equal(created.status, 200, created.text);
        const memberId = created.json.user.id;
        const first = await login(app.baseUrl, 'partner-member', TEMP);
        assert.equal(first.status, 200, JSON.stringify(first.json));
        const changed = await call(app.baseUrl, first, 'POST', '/api/account/password', {
            currentPassword: TEMP,
            newPassword: REPLACEMENT,
            confirmPassword: REPLACEMENT
        });
        assert.equal(changed.status, 200, changed.text);
        const second = await login(app.baseUrl, 'partner-member', REPLACEMENT);
        assert.equal(second.status, 200, JSON.stringify(second.json));
        const granted = await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: second.cookie,
            csrf: second.csrf,
            clientId: client.json.client.id,
            clientSecret: client.json.clientSecret,
            redirectUri: REDIRECT,
            scope: 'profile:read rates:read sailings:read'
        });
        assert.equal(granted.status, 302, JSON.stringify(granted));
        assert.equal(granted.tokenStatus, 200, JSON.stringify(granted.token));
        assert.equal(typeof granted.token.refresh_token, 'string');
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 1);

        const deactivated = await call(app.baseUrl, admin, 'PATCH', `/api/admin/users/${memberId}`, {
            disabled: true,
            companyId: ownerId
        });
        assert.equal(deactivated.status, 200, deactivated.text);
        assert.equal(row(memberId).disabled, 1);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 0);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 0);

        const reactivated = await call(app.baseUrl, admin, 'PATCH', `/api/admin/users/${memberId}`, {
            disabled: false,
            companyId: ownerId
        });
        assert.equal(reactivated.status, 200, reactivated.text);
        assert.equal(row(memberId).disabled, 0);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 0);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 0);

        const refreshed = await fetch(`${app.baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: granted.token.refresh_token,
                client_id: client.json.client.id,
                client_secret: client.json.clientSecret
            })
        });
        const refreshBody = await refreshed.json();
        assert.equal(refreshed.status, 400, JSON.stringify(refreshBody));
        assert.equal(refreshBody.error, 'invalid_grant');
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`).get(memberId).count, 0);
    });
});
