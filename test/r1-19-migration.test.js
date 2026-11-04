'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r119-mig-'));
const EARLIER = [
    '001-roles.js',
    '002-password-lifecycle.js',
    '003-saved-preferences.js',
    '004-login-uniqueness.js',
    '005-customer-authorization.js',
    '006-data-operations.js',
    '008-import-jobs.js'
];
const FULL = ['001', '002', '003', '004', '005', '006', '008', '010'];

function boot(dbPath, migrationsDir) {
    const env = { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath };
    delete env.MIGRATIONS_DIR;
    if (migrationsDir) env.MIGRATIONS_DIR = migrationsDir;
    const result = spawnSync(process.execPath, ['-e', `
        const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const ids = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id);
        process.stdout.write(JSON.stringify(ids));
        db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}

function backups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

describe('r1-19 migration 010', () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('applies on a fresh database and is a no-op the second time', () => {
        const dir = path.join(root, 'fresh');
        fs.mkdirSync(dir);
        const dbPath = path.join(dir, 'app.db');
        const first = boot(dbPath);
        assert.deepEqual(first, FULL);
        const opened = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(opened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'booking_requests'`).get().name, 'booking_requests');
        opened.close();
        const firstBackups = backups(dbPath);
        assert.equal(firstBackups.length, 1);
        assert.match(firstBackups[0], /^rateninja-\d{8}T\d{9}Z-pre-001\.db$/);
        const second = boot(dbPath);
        assert.deepEqual(second, FULL);
        assert.deepEqual(backups(dbPath), firstBackups);
    });

    it('applies on a populated pre-010 database, keeps existing rows, and writes a pre-010 backup', () => {
        const dir = path.join(root, 'populated');
        fs.mkdirSync(dir);
        const dbPath = path.join(dir, 'app.db');
        const earlier = fs.mkdtempSync(path.join(root, 'earlier-'));
        for (const name of EARLIER) {
            fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', name), path.join(earlier, name));
        }
        assert.deepEqual(boot(dbPath, earlier), ['001', '002', '003', '004', '005', '006', '008']);
        const db = new DatabaseSync(dbPath);
        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
            VALUES ('own-1', 'own-1', 'Synthetic Owner', 'Contract Owner', 'contract_owner', 1)
        `).run();
        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
            VALUES ('cus-1', 'cus-1', 'Synthetic Customer', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
        `).run();
        db.prepare(`
            INSERT INTO users (id, username, display_name, company_record_id, company_role, is_system_admin, admin_screen, disabled, session_epoch)
            VALUES ('user-1', 'synthetic-user', 'Synthetic User', 'own-1', 'member', 0, 0, 0, 0)
        `).run();
        db.prepare(`
            INSERT INTO company_margins (
                id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at, status
            ) VALUES ('margin-1', 'own-1', 'cus-1', 0.1, 25, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active')
        `).run();
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, owner_company_id)
            VALUES ('rate-keep', 'MSC', 'SHA', 'LAX', 1000, 'own-1')
        `).run();
        const before = {
            companies: db.prepare('SELECT COUNT(*) AS count FROM companies').get().count,
            users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
            margins: db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count,
            rates: db.prepare('SELECT rate_20d FROM rates WHERE id = ?').get('rate-keep').rate_20d
        };
        assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'booking_requests'`).get(), undefined);
        db.close();

        const applied = boot(dbPath);
        assert.deepEqual(applied, FULL);
        const names = backups(dbPath);
        const pre010 = names.filter(name => name.endsWith('-pre-010.db'));
        assert.equal(pre010.length, 1);
        assert.match(pre010[0], /^rateninja-\d{8}T\d{9}Z-pre-010\.db$/);
        const opened = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM companies').get().count, before.companies);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM users').get().count, before.users);
        assert.equal(opened.prepare('SELECT company_role FROM users WHERE id = ?').get('user-1').company_role, 'member');
        assert.equal(opened.prepare('SELECT margin_percent, margin_number FROM company_margins WHERE id = ?').get('margin-1').margin_number, 25);
        assert.equal(opened.prepare('SELECT rate_20d FROM rates WHERE id = ?').get('rate-keep').rate_20d, before.rates);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM booking_requests').get().count, 0);
        opened.close();

        const again = boot(dbPath);
        assert.deepEqual(again, FULL);
        assert.deepEqual(backups(dbPath), names);
    });
});
