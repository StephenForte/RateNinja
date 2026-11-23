'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');
const { utcDay } = require('./helpers/r1-19');
const { BUYER, RATE_TYPE, seedManagedAgents } = require('./helpers/r1-33');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function boot(dbPath, migrationsDir) {
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env: { ...process.env, SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: migrationsDir },
        stdio: 'pipe'
    });
}

function snapshot(db) {
    return Object.fromEntries(['managed_agents', 'rates', 'booking_requests'].map(table => [
        table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    ]));
}

it('applies 019 to a populated 018 database and defaults all 50 agents to off', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r161-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const prior = path.join(directory, 'migrations');
    let db;
    try {
        fs.mkdirSync(prior);
        fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
        for (const name of fs.readdirSync(migrations)) {
            if (/^\d{3}-.+\.js$/.test(name) && name < '019') {
                fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
            }
        }
        boot(dbPath, prior);
        db = new DatabaseSync(dbPath);
        const applied = () => db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
        const beforeIds = applied();
        assert.equal(beforeIds.at(-1).id, '018');
        const { creator } = seedManagedAgents(db);
        db.prepare(`
            INSERT INTO booking_requests (
                id, rate_id, status, container_size, slots, customer_price, requesting_user_id, requesting_company_id,
                owner_company_id, created_at
            ) VALUES ('synthetic-booking', 'managed-rate-1', 'pending', '20D', 1, 1070, ?, ?, 'managed-owner', ?)
        `).run(creator, BUYER, utcDay(0));
        const insert = db.prepare(`
            INSERT INTO managed_agents (
                id, batch_id, company_id, created_by_user_id, status, rate_type, origin_port, destination_port,
                sailing_date, container_type, allow_alternative_routes, allow_booking_request, price_min, price_max,
                booking_slots, booking_request_id, created_at, updated_at
            ) VALUES (?, 'synthetic-batch', ?, ?, ?, ?, 'SHA', 'LAX', ?, '20D', 0, 1, 0, 2000, 12, ?, ?, ?)
        `);
        const states = ['queued', 'running', 'completed', 'failed', 'cancelled'];
        const date = utcDay(0);
        for (let i = 0; i < 50; i += 1) {
            insert.run('agent-' + i, BUYER, creator, states[i % states.length], RATE_TYPE,
                utcDay(2), i === 2 ? 'synthetic-booking' : null, date, date);
        }
        const before = snapshot(db);
        assert.equal(before.managed_agents.length, 50);
        assert.ok(before.rates.length > 0);
        assert.equal(before.booking_requests.length, 1);
        db.close();
        db = undefined;

        boot(dbPath, migrations);
        db = new DatabaseSync(dbPath);
        const afterIds = applied();
        assert.deepEqual(afterIds.slice(0, -3), beforeIds);
        assert.equal(afterIds.at(-3).id, '019');
        assert.equal(afterIds.at(-2).id, '020');
        assert.equal(afterIds.at(-1).id, '021');
        const after = snapshot(db);
        assert.deepEqual(after, {
            ...before,
            managed_agents: before.managed_agents.map(row =>
                Object.assign(Object.create(null), row, { accept_max_slots: 0 }))
        });
        assert.throws(() => db.prepare('UPDATE managed_agents SET accept_max_slots = 2').run(), /CHECK constraint failed/);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        db.close();
        db = undefined;

        boot(dbPath, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(applied(), afterIds);
        assert.deepEqual(snapshot(db), after);
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
