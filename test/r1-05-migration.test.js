'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r105-mig-'));
const migration = require('../lib/migrations/003-saved-preferences');

function listBackups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

function openDatabase(dbPath, migrationsDir) {
    const env = { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath };
    delete env.MIGRATIONS_DIR;
    if (migrationsDir) env.MIGRATIONS_DIR = migrationsDir;
    const result = spawnSync(process.execPath, ['-e', `
        const opened = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const rows = opened.db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        process.stdout.write(JSON.stringify(rows));
        opened.db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
}

function seedPopulated(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('kings', 'kings', 'Kings Custom', 'Contract Owner', 'contract_owner', 1)
    `).run();
    db.prepare(`
        INSERT INTO users (id, username, display_name, admin_screen, company_record_id, company_id, disabled, session_epoch)
        VALUES ('user-alan', 'Alan', 'Alan', 0, 'kings', 'kings', 0, 0)
    `).run();
    db.prepare(`
        INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
        VALUES ('rate-1', 'MSC', 'SHA', 'LAX', 1000, '2026-04-01', 'kings')
    `).run();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES ('margin-1', 'kings', 'blackwater', 0.1, 25, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    db.close();
}

describe('r1-05 migration 003', () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses the pre-assigned id', () => {
        assert.equal(migration.id, '003');
        assert.match(migration.description, /saved/i);
    });

    it('applies on a database that already has 001, keeps seeded rows, and is a no-op the second time', () => {
        const dir = fs.mkdtempSync(path.join(root, 'db-'));
        const only001 = fs.mkdtempSync(path.join(root, 'mig001-'));
        fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', '001-roles.js'), path.join(only001, '001-roles.js'));
        fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', '002-password-lifecycle.js'), path.join(only001, '002-password-lifecycle.js'));
        const dbPath = path.join(dir, 'populated.db');

        const after001 = openDatabase(dbPath, only001);
        assert.deepEqual(after001.map(row => row.id), ['001', '002']);
        seedPopulated(dbPath);

        const after003 = openDatabase(dbPath);
        assert.deepEqual(after003.map(row => row.id), ['001', '002', '003', '004', '005', '006', '008']);
        const backups = listBackups(dbPath);
        assert.equal(backups.length, 2);
        assert.match(backups[1], /pre-003\.db$/);

        const live = new DatabaseSync(dbPath);
        assert.equal(live.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
        assert.equal(live.prepare('SELECT COUNT(*) AS count FROM rates').get().count, 1);
        assert.equal(live.prepare('SELECT COUNT(*) AS count FROM companies').get().count, 1);
        assert.equal(live.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count, 1);
        assert.equal(live.prepare(`SELECT username FROM users`).get().username, 'Alan');
        const stamp = '2026-10-13T00:00:00.000Z';
        live.prepare(`
            INSERT INTO saved_queries (id, user_id, name, payload, config_version, created_at, updated_at)
            VALUES ('q1', 'user-alan', 'West Coast', '{}', 1, ?, ?)
        `).run(stamp, stamp);
        assert.throws(() => {
            live.prepare(`
                INSERT INTO saved_queries (id, user_id, name, payload, config_version, created_at, updated_at)
                VALUES ('q2', 'user-alan', 'west coast', '{}', 1, ?, ?)
            `).run(stamp, stamp);
        });
        live.prepare(`
            INSERT INTO saved_queries (id, user_id, name, payload, config_version, created_at, updated_at)
            VALUES ('q3', 'user-bob', 'west coast', '{}', 1, ?, ?)
        `).run(stamp, stamp);
        live.prepare(`
            INSERT INTO saved_views (id, user_id, name, payload, config_version, is_default, created_at, updated_at)
            VALUES ('v1', 'user-alan', 'Mine', '{}', 1, 1, ?, ?)
        `).run(stamp, stamp);
        assert.throws(() => {
            live.prepare(`
                INSERT INTO saved_views (id, user_id, name, payload, config_version, is_default, created_at, updated_at)
                VALUES ('v2', 'user-alan', 'Other', '{}', 1, 1, ?, ?)
            `).run(stamp, stamp);
        });
        live.prepare(`
            INSERT INTO saved_views (id, user_id, name, payload, config_version, is_default, created_at, updated_at)
            VALUES ('v3', 'user-bob', 'Theirs', '{}', 1, 1, ?, ?)
        `).run(stamp, stamp);
        live.close();

        const again = openDatabase(dbPath);
        assert.deepEqual(again, after003);
        assert.deepEqual(listBackups(dbPath), backups);
        const reread = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(reread.prepare(`SELECT name FROM saved_queries WHERE id = 'q1'`).get().name, 'West Coast');
        assert.equal(reread.prepare(`SELECT COUNT(*) AS count FROM saved_views WHERE is_default = 1`).get().count, 2);
        reread.close();
    });
});
