const fs = require('node:fs');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { COMPANY_TYPE_CUSTOMER } = require('../lib/constants');

describe('r1-01 test harness', { concurrency: 1 }, () => {
    it('seeds a customer member, logs in, and deletes the temp database', async () => {
        const app = await startApp({
            companyType: 'customer',
            role: 'member',
            username: 'r101-member'
        });
        const directory = app.directory;
        const dbPath = app.dbPath;
        try {
            assert.equal(fs.existsSync(pathToBackups(dbPath)), false);
            const user = app.db.prepare(`SELECT admin_screen, company_record_id, pwd FROM users WHERE username = ?`).get('r101-member');
            assert.equal(user.admin_screen, 0);
            assert.equal(user.pwd, null);
            const company = app.db.prepare(`SELECT company_type, company_name FROM companies WHERE id = ?`).get(user.company_record_id);
            assert.equal(company.company_type, COMPANY_TYPE_CUSTOMER);
            assert.equal(company.company_name, 'R1 Test Company');
            assert.match(app.cookie, /^rate_ninja_session=/);
            assert.ok(app.csrf);
            const session = await app.request('/api/session');
            const body = await session.json();
            assert.equal(session.status, 200);
            assert.equal(body.user.username, 'r101-member');
            assert.equal(body.csrfToken, app.csrf);
            const anonymous = await app.request('/api/session', { cookie: false });
            assert.equal(anonymous.status, 401);
        } finally {
            await app.close();
        }
        assert.equal(fs.existsSync(directory), false);
        assert.equal(fs.existsSync(dbPath), false);
    });
});

function pathToBackups(dbPath) {
    return require('node:path').join(require('node:path').dirname(dbPath), 'backups');
}
