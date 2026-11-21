'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');
const migration = require('../lib/migrations/015-booking-receipts');

const root = path.resolve(__dirname, '..');

it('applies migration 015 to fresh and populated databases without backfill, and reruns safely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r140-migration-'));
    const migrations = path.join(root, 'lib/migrations');
    const prior = path.join(dir, 'pre-015');
    let db;

    function boot(database, migrationsDir) {
        execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
            cwd: root,
            env: { ...process.env, SQLITE_DB_PATH: database, MIGRATIONS_DIR: migrationsDir },
            stdio: 'pipe'
        });
    }

    function snapshot() {
        return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
            .flatMap(({ name }) => {
                if (name === 'managed_agent_runs') return [];
                const filter = name === 'schema_migrations' ? " WHERE id NOT IN ('015', '016', '017')" : '';
                const table = '"' + name.replaceAll('"', '""') + '"';
                return [[name, db.prepare(`SELECT * FROM ${table}${filter}`).all()]];
            }));
    }

    try {
        const fresh = path.join(dir, 'fresh.db');
        boot(fresh, migrations);
        db = new DatabaseSync(fresh);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '015'").get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_receipts').get().n, 0);
        db.close();
        db = null;

        // Preserve migration-relative require() paths, including ../limits.
        fs.mkdirSync(prior);
        fs.copyFileSync(path.join(root, 'lib/limits.js'), path.join(dir, 'limits.js'));
        for (const name of fs.readdirSync(migrations)) {
            if (/^\d{3}-.+\.js$/.test(name) && name < '015') {
                fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
            }
        }

        const populated = path.join(dir, 'populated.db');
        boot(populated, prior);
        db = new DatabaseSync(populated);
        const insert = db.prepare(`
            INSERT INTO booking_requests (
                id, rate_id, status, container_size, slots, customer_price, requesting_user_id, requesting_company_id,
                owner_company_id, created_at, decided_at
            ) VALUES (?, 'synthetic-rate', ?, '20D', 1, 9000, 'synthetic-user', 'synthetic-buyer', 'synthetic-owner', ?, ?)
        `);
        const now = '2026-11-19T00:00:00.000Z';
        for (const status of ['pending', 'approved', 'declined']) insert.run(status, status, now, status === 'pending' ? null : now);
        const before = snapshot();
        assert.equal(before.booking_receipts, undefined);
        db.close();
        db = null;

        boot(populated, migrations);
        db = new DatabaseSync(populated);
        assert.deepEqual(snapshot(), { ...before, booking_receipts: [] });
        const applied = db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '015'").get();
        assert.ok(applied);
        assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(name => name.endsWith('-pre-015.db')).length, 1);
        db.prepare(`
            INSERT INTO booking_receipts (request_id, status, receipt_hash, created_at, updated_at)
            VALUES ('approved', 'pending', 'synthetic-digest', ?, ?)
        `).run(now, now);
        const after = snapshot();
        migration.up(db);
        assert.deepEqual(snapshot(), after);
        db.close();
        db = null;

        boot(populated, migrations);
        db = new DatabaseSync(populated);
        assert.deepEqual(snapshot(), after);
        assert.deepEqual(db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '015'").get(), applied);
        assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter(name => name.endsWith('-pre-015.db')).length, 1);
    } finally {
        db?.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
