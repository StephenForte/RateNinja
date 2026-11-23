'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');
const { utcDay } = require('./helpers/r1-19');
const { seedManagedAgents, BUYER, RATE_TYPE } = require('./helpers/r1-33');
const { hashTables } = require('./helpers/r1-34');

const root = path.resolve(__dirname, '..');

function boot(dbPath, source, migrationsDir) {
    const env = { ...process.env, SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: migrationsDir };
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], { cwd: source, env, stdio: 'pipe' });
}

it('applies 014 to populated 013 data and reopens without changing rows or creating another backup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r134-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const source = process.env.R1_34_BASELINE_ROOT || root;
    const migrations = path.join(root, 'lib/migrations');
    const previous = path.join(directory, 'previous');
    let db;
    try {
        fs.mkdirSync(previous);
        for (const name of fs.readdirSync(path.join(source, 'lib/migrations'))) {
            if (/^\d{3}-.*\.js$/.test(name) && name < '014') {
                fs.copyFileSync(path.join(source, 'lib/migrations', name), path.join(previous, name));
            }
        }
        boot(dbPath, source, previous);
        db = new DatabaseSync(dbPath);
        assert.equal(db.prepare('SELECT max(id) AS id FROM schema_migrations').get().id, '013');
        const users = seedManagedAgents(db);
        const insert = db.prepare(`
            INSERT INTO managed_agents (
                id, batch_id, company_id, created_by_user_id, rate_type, origin_port, destination_port, sailing_date,
                container_type, allow_alternative_routes, allow_booking_request, price_min, price_max, created_at, updated_at
            ) VALUES (?, 'batch', ?, ?, ?, 'SHA', 'LAX', ?, '20D', 0, ?, ?, ?, '2000-01-01', '2000-01-02')
        `);
        insert.run('booking-on', BUYER, users.creator, RATE_TYPE, utcDay(2), 1, 1000, 1200);
        insert.run('booking-off', BUYER, users.member, RATE_TYPE, utcDay(2), 0, null, null);
        const before = hashTables(db);
        db.close();
        db = null;

        boot(dbPath, root, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(db.prepare("SELECT id FROM schema_migrations WHERE id >= '014' ORDER BY id").all()
            .map(row => row.id), ['014', '015', '016', '017', '018', '019', '020']);
        assert.deepEqual(hashTables(db, { migrationComparison: true }), before);
        assert.deepEqual(db.prepare('SELECT id, booking_slots, booking_request_id FROM managed_agents ORDER BY id').all()
            .map(row => [row.id, row.booking_slots, row.booking_request_id]), [
            ['booking-off', null, null], ['booking-on', 1, null]
        ]);
        const migrated = hashTables(db);
        const backupDir = path.join(directory, 'backups');
        const backups = fs.readdirSync(backupDir);
        assert.equal(backups.filter(name => name.endsWith('-pre-014.db')).length, 1);
        db.close();
        db = null;

        boot(dbPath, root, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(hashTables(db), migrated);
        assert.deepEqual(fs.readdirSync(backupDir), backups);
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
