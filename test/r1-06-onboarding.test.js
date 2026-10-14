'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { call, counts, login } = require('./helpers/r1-06');

const TEMP = 'temporary-pass-1';
const REPLACEMENT = 'replaced-pass-99';

describe('r1-06 company onboarding', { concurrency: 1 }, () => {
    let app;
    let admin;

    before(async () => {
        app = await startApp({
            companyType: 'Contract Owner',
            role: 'admin',
            username: 'r106-admin'
        });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        admin = { cookie: app.cookie, csrf: app.csrf };
    });

    after(async () => {
        if (app) await app.close();
    });

    function userRow(loginName) {
        return app.db.prepare(`
            SELECT id, username, company_role, is_system_admin, must_change_password, company_record_id
            FROM users WHERE lower(username) = lower(?)
        `).get(loginName);
    }

    it('creates one customer company and one admin whose first login is restricted', async () => {
        const before = counts(app.db);
        const created = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
            companyName: 'Harbor Forwarding',
            companyType: 'Freight Forwarder/Customer',
            admin: {
                displayName: 'Harbor Admin',
                email: 'harbor.admin@example.com',
                temporaryPassword: TEMP
            },
            submissionId: 'harbor-1'
        });
        assert.equal(created.status, 200, created.text);
        assert.equal(created.text.includes(TEMP), false);
        assert.match(created.json.summary, /Harbor Forwarding/);
        assert.match(created.json.summary, /Freight Forwarder\/Customer/);
        assert.match(created.json.handoff, /will not email/i);
        assert.equal(created.json.admin.loginName, 'harbor.admin@example.com');
        assert.equal(created.json.admin.role, 'company_admin');
        assert.equal(Object.hasOwn(created.json, 'temporaryPassword'), false);
        assert.equal(Object.hasOwn(created.json.admin, 'password'), false);
        const after = counts(app.db);
        assert.equal(after.companies, before.companies + 1);
        assert.equal(after.users, before.users + 1);
        assert.equal(after.margins, before.margins);
        assert.equal(after.rates, before.rates);
        const row = userRow('harbor.admin@example.com');
        assert.equal(row.company_role, 'company_admin');
        assert.equal(row.is_system_admin, 0);
        assert.equal(row.must_change_password, 1);
        assert.equal(row.company_record_id, created.json.company.id);
        const links = app.db.prepare(`
            SELECT COUNT(*) AS count FROM company_margins
            WHERE owner_company_id = ? OR customer_company_id = ?
        `).get(created.json.company.id, created.json.company.id).count;
        assert.equal(links, 0);
        const ownedRates = app.db.prepare('SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = ?')
            .get(created.json.company.id).count;
        assert.equal(ownedRates, 0);

        const session = await login(app.baseUrl, 'harbor.admin@example.com', TEMP);
        assert.equal(session.status, 200, JSON.stringify(session.json));
        const actor = { cookie: session.cookie, csrf: session.csrf };
        const gate = await call(app.baseUrl, actor, 'GET', '/api/rates');
        assert.equal(gate.status, 403);
        assert.equal(gate.json.code, 'password_change_required');
        const view = await call(app.baseUrl, actor, 'GET', '/api/session');
        assert.equal(view.json.user.mustChangePassword, true);
        const changed = await call(app.baseUrl, actor, 'POST', '/api/account/password', {
            currentPassword: TEMP,
            newPassword: REPLACEMENT,
            confirmPassword: REPLACEMENT
        });
        assert.equal(changed.status, 200, changed.text);
    });

    it('creates an owner with no rates and no customer links', async () => {
        const before = counts(app.db);
        const created = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
            companyName: 'Northwind Contracts',
            companyType: 'Contract Owner',
            admin: {
                displayName: 'North Admin',
                email: 'north.admin@example.com',
                loginName: 'north-admin',
                temporaryPassword: TEMP
            },
            submissionId: 'north-1'
        });
        assert.equal(created.status, 200, created.text);
        assert.equal(created.text.includes(TEMP), false);
        const after = counts(app.db);
        assert.equal(after.companies, before.companies + 1);
        assert.equal(after.users, before.users + 1);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM rates WHERE owner_company_id = ?').get(created.json.company.id).count, 0);
        assert.equal(app.db.prepare(`
            SELECT COUNT(*) AS count FROM company_margins
            WHERE owner_company_id = ? OR customer_company_id = ?
        `).get(created.json.company.id, created.json.company.id).count, 0);
        assert.equal(userRow('north-admin').must_change_password, 1);
    });

    it('rolls back the company when the admin insert fails', async () => {
        app.db.exec(`
            CREATE TRIGGER r106_fail_admin BEFORE INSERT ON users
            WHEN NEW.username = 'fail-admin@example.com'
            BEGIN
                SELECT RAISE(ABORT, 'forced admin insert failure');
            END
        `);
        const before = counts(app.db);
        try {
            const failed = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
                companyName: 'Should Not Exist',
                companyType: 'Freight Forwarder/Customer',
                admin: {
                    displayName: 'Fail Admin',
                    email: 'fail-admin@example.com',
                    temporaryPassword: TEMP
                },
                submissionId: 'fail-1'
            });
            assert.equal(failed.status, 500, failed.text);
            assert.deepEqual(counts(app.db), before);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM companies WHERE company_name = 'Should Not Exist'`).get().count, 0);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM users WHERE lower(username) = 'fail-admin@example.com'`).get().count, 0);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM onboarding_submissions WHERE submission_id = 'fail-1'`).get().count, 0);
        } finally {
            app.db.exec('DROP TRIGGER r106_fail_admin');
        }
    });

    it('returns the first result when submissionId is repeated', async () => {
        const before = counts(app.db);
        const body = {
            companyName: 'Replay Shipping',
            companyType: 'Freight Forwarder/Customer',
            admin: {
                displayName: 'Replay Admin',
                email: 'replay.admin@example.com',
                temporaryPassword: TEMP
            },
            submissionId: 'replay-1'
        };
        const first = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', body);
        assert.equal(first.status, 200, first.text);
        const second = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
            ...body,
            companyName: 'Replay Shipping Renamed'
        });
        assert.equal(second.status, 200, second.text);
        assert.equal(second.json.company.id, first.json.company.id);
        assert.equal(second.json.admin.id, first.json.admin.id);
        assert.equal(second.json.company.name, 'Replay Shipping');
        assert.equal(second.text.includes(TEMP), false);
        const after = counts(app.db);
        assert.equal(after.companies, before.companies + 1);
        assert.equal(after.users, before.users + 1);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM companies WHERE company_name = 'Replay Shipping Renamed'`).get().count, 0);
    });

    it('refuses a case-insensitive duplicate login and writes nothing', async () => {
        const before = counts(app.db);
        const duplicate = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
            companyName: 'Duplicate Login Co',
            companyType: 'Contract Owner',
            admin: {
                displayName: 'Same Login',
                email: 'other@example.com',
                loginName: 'R106-ADMIN',
                temporaryPassword: TEMP
            },
            submissionId: 'dup-login-1'
        });
        assert.equal(duplicate.status, 400, duplicate.text);
        assert.match(duplicate.json.error, /login name/i);
        assert.deepEqual(counts(app.db), before);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM companies WHERE company_name = 'Duplicate Login Co'`).get().count, 0);
    });

    it('refuses everyone except a system admin', async () => {
        const before = counts(app.db);
        app.db.prepare('UPDATE users SET is_system_admin = 0 WHERE username = ?').run(app.username);
        try {
            const denied = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
                companyName: 'Not Allowed Co',
                companyType: 'Contract Owner',
                admin: {
                    displayName: 'Nope',
                    email: 'nope.admin@example.com',
                    temporaryPassword: TEMP
                },
                submissionId: 'denied-1'
            });
            assert.equal(denied.status, 403);
            const name = await call(app.baseUrl, admin, 'GET', '/api/admin/onboarding/name-check?q=Kings');
            assert.equal(name.status, 403);
            assert.deepEqual(counts(app.db), before);
        } finally {
            app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        }
    });

    it('warns when a company name already matches, without creating one', async () => {
        const before = counts(app.db);
        const hit = await call(app.baseUrl, admin, 'GET', '/api/admin/onboarding/name-check?q=harbor%20forwarding');
        assert.equal(hit.status, 200, hit.text);
        assert.equal(hit.json.match, true);
        assert.match(hit.json.warning, /Harbor Forwarding/);
        const miss = await call(app.baseUrl, admin, 'GET', '/api/admin/onboarding/name-check?q=Brand%20New%20Name');
        assert.equal(miss.status, 200);
        assert.equal(miss.json.match, false);
        assert.equal(miss.json.warning, '');
        assert.deepEqual(counts(app.db), before);
    });

    it('refuses system-admin assignment on the initial administrator', async () => {
        const before = counts(app.db);
        const denied = await call(app.baseUrl, admin, 'POST', '/api/admin/onboarding', {
            companyName: 'Elevated Co',
            companyType: 'Contract Owner',
            admin: {
                displayName: 'Elevated',
                email: 'elevated@example.com',
                temporaryPassword: TEMP,
                isSystemAdmin: true
            },
            submissionId: 'elevated-1'
        });
        assert.equal(denied.status, 400);
        assert.deepEqual(counts(app.db), before);
    });
});
