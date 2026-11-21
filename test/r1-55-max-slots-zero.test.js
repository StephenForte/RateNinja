'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it } = require('node:test');
const migration = require('../lib/migrations/018-rate-max-slots-zero');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');
const ZERO_CHECK = 'max_slots_allowed INTEGER CHECK (max_slots_allowed IS NULL OR max_slots_allowed >= 0)';

function boot(dbPath, migrationsDir) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        MIGRATIONS_DIR: migrationsDir,
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    const result = spawnSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function migrationsBefore018(directory) {
    const prior = path.join(directory, 'before-018');
    fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
    fs.mkdirSync(prior);
    for (const name of fs.readdirSync(migrations)) {
        if (/^\d{3}-.+\.js$/.test(name) && name < '018') {
            fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
        }
    }
    return prior;
}

function rateRows(db) {
    return db.prepare('SELECT * FROM rates ORDER BY id').all();
}

function triggerRows(db) {
    return db.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'trg_rates_max_slots_default'
    `).all();
}

describe('r1-55 max slots may be zero', { concurrency: 1 }, () => {
    it('keeps a populated 017 database byte-identical, accepts 0, and draws new rates from 0 to 5', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r155-migrate-'));
        const dbPath = path.join(directory, 'app.db');
        let db;
        try {
            boot(dbPath, migrationsBefore018(directory));
            db = new DatabaseSync(dbPath);
            db.exec('PRAGMA foreign_keys = ON');
            db.prepare(`
                INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
                VALUES ('owner-a', 'owner-a', 'Owner A', 'Contract Owner', 'contract_owner', 1)
            `).run();
            db.prepare(`
                INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
                VALUES ('owner-b', 'owner-b', 'Owner B', 'Contract Owner', 'contract_owner', 1)
            `).run();
            const insert = db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_20d, rate_40d, rate_40hc,
                    rate_effective_date, owner_company_id, row_version
                ) VALUES (?, 'MSC', 'SHA', 'LAX', ?, ?, ?, '2026-03-01', ?, ?)
            `);
            for (let index = 0; index < 220; index += 1) {
                const nullPrice = index >= 210;
                insert.run(
                    `r${String(index).padStart(4, '0')}`,
                    nullPrice ? null : 1000 + index,
                    nullPrice ? null : 1800,
                    nullPrice ? null : 1900,
                    index % 2 === 0 ? 'owner-a' : 'owner-b',
                    index === 8 ? 9 : 1
                );
            }
            db.prepare(`UPDATE rates SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE id < 'r0008'`).run();
            db.prepare(`UPDATE rates SET max_slots_allowed = 3 WHERE id = 'r0008'`).run();
            db.prepare(`UPDATE rates SET max_slots_allowed = 5 WHERE id = 'r0009'`).run();
            db.prepare(`UPDATE rates SET max_slots_allowed = NULL WHERE id = 'r0010'`).run();
            db.prepare(`UPDATE rates SET max_slots_allowed = 1 WHERE id = 'r0011'`).run();
            db.prepare(`
                INSERT INTO booking_requests (
                    id, rate_id, status, container_size, slots, customer_price,
                    requesting_user_id, requesting_company_id, owner_company_id, created_at
                ) VALUES (
                    'book-1', 'r0008', 'pending', '20D', 1, 1000,
                    'user-a', 'customer-a', 'owner-a', '2026-11-21T00:00:00.000Z'
                )
            `).run();
            const before = rateRows(db);
            const beforeNames = db.prepare('PRAGMA table_info(rates)').all().map(column => column.name);
            assert.equal(before.length, 220);
            assert.ok(beforeNames.includes('max_slots_allowed'));
            assert.equal(before.find(row => row.id === 'r0010').max_slots_allowed, null);
            assert.equal(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rates'`).get().sql.includes('max_slots_allowed >= 1'), true);
            db.close();
            db = null;

            boot(dbPath, migrations);
            db = new DatabaseSync(dbPath);
            db.exec('PRAGMA foreign_keys = ON');
            assert.deepEqual(rateRows(db), before);
            assert.deepEqual(db.prepare('PRAGMA table_info(rates)').all().map(column => column.name), beforeNames);
            assert.equal(db.prepare(`SELECT name FROM pragma_table_info('rates') WHERE name = 'max_slots_allowed_018'`).get(), undefined);
            const tableSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rates'`).get().sql;
            assert.equal(tableSql.includes(ZERO_CHECK), true);
            assert.equal(tableSql.includes('max_slots_allowed >= 1'), false);
            const triggers = triggerRows(db);
            assert.equal(triggers.length, 1);
            assert.match(triggers[0].sql, /WHEN NEW\.max_slots_allowed IS NULL/);
            assert.match(triggers[0].sql, /abs\(random\(\)\) % 6/);
            assert.equal(triggers[0].sql.includes('% 5'), false);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '018'`).get().n, 1);
            const applied = db.prepare(`SELECT applied_at FROM schema_migrations WHERE id = '018'`).get();
            const backups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-018.db'));
            assert.equal(backups.length, 1);
            assert.equal(db.prepare(`SELECT row_version FROM rates WHERE id = 'r0008'`).get().row_version, 9);
            assert.equal(db.prepare(`SELECT deleted_at FROM rates WHERE id = 'r0000'`).get().deleted_at, '2026-01-02T00:00:00.000Z');
            assert.equal(db.prepare(`SELECT rate_20d FROM rates WHERE id = 'r0210'`).get().rate_20d, null);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'r0010'`).get().max_slots_allowed, null);
            assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
            assert.equal(db.prepare(`SELECT rate_id FROM booking_requests WHERE id = 'book-1'`).get().rate_id, 'r0008');

            const afterCopy = rateRows(db);
            migration.up(db);
            assert.deepEqual(rateRows(db), afterCopy);
            assert.equal(triggerRows(db).length, 1);
            assert.match(triggerRows(db)[0].sql, /abs\(random\(\)\) % 6/);

            db.prepare(`UPDATE rates SET max_slots_allowed = 0 WHERE id = 'r0011'`).run();
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'r0011'`).get().max_slots_allowed, 0);
            db.exec('SAVEPOINT negative');
            assert.throws(() => {
                db.prepare(`UPDATE rates SET max_slots_allowed = -1 WHERE id = 'r0011'`).run();
            }, /CHECK|constraint/i);
            db.exec('ROLLBACK TO negative');
            db.exec('RELEASE negative');
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'r0011'`).get().max_slots_allowed, 0);

            const drawn = [];
            const insertOpen = db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id)
                VALUES (?, 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a')
            `);
            for (let index = 0; index < 60; index += 1) {
                const id = `drawn-${index}`;
                insertOpen.run(id);
                drawn.push(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = ?`).get(id).max_slots_allowed);
            }
            assert.equal(drawn.length, 60);
            for (const value of drawn) {
                assert.equal(typeof value, 'number');
                assert.ok(Number.isInteger(value));
                assert.ok(value >= 0 && value <= 5, String(value));
            }
            assert.ok(new Set(drawn).size > 1, drawn.join(','));
            db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed
                ) VALUES ('supplied-0', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', 0)
            `).run();
            db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed
                ) VALUES ('supplied-4', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-b', 4)
            `).run();
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'supplied-0'`).get().max_slots_allowed, 0);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'supplied-4'`).get().max_slots_allowed, 4);
            db.exec('SAVEPOINT negative_insert');
            assert.throws(() => {
                db.prepare(`
                    INSERT INTO rates (
                        id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed
                    ) VALUES ('supplied-neg', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', -1)
                `).run();
            }, /CHECK|constraint/i);
            db.exec('ROLLBACK TO negative_insert');
            db.exec('RELEASE negative_insert');
            assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

            const settled = rateRows(db);
            const booking = db.prepare('SELECT * FROM booking_requests').all();
            db.close();
            db = null;

            boot(dbPath, migrations);
            db = new DatabaseSync(dbPath);
            assert.deepEqual(rateRows(db), settled);
            assert.deepEqual(db.prepare('SELECT * FROM booking_requests').all(), booking);
            assert.deepEqual(db.prepare(`SELECT applied_at FROM schema_migrations WHERE id = '018'`).get(), applied);
            assert.deepEqual(
                fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-018.db')),
                backups
            );
            assert.equal(triggerRows(db).length, 1);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '018'`).get().n, 1);
        } finally {
            db?.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
