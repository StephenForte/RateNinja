const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const defaultDbPath = path.join(repoRoot, 'data', 'rateninja.db');
const defaultBackupDir = path.join(repoRoot, 'data', 'backups');
const repoBackupDir = path.join(repoRoot, 'backups');
const runnerPath = path.join(repoRoot, 'lib', 'migrations', 'index.js');
const dbModulePath = path.join(repoRoot, 'lib', 'db.js');

function statOf(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
}

const defaultDbBefore = statOf(defaultDbPath);
const defaultBackupsBefore = fs.existsSync(defaultBackupDir);
const repoBackupsBefore = fs.existsSync(repoBackupDir);

const { runMigrations, defaultMigrationsDir, MIGRATION_BACKUPS_KEPT: keptFromRunner } = (() => {
    const runner = require('../lib/migrations');
    const limits = require('../lib/limits');
    return { ...runner, MIGRATION_BACKUPS_KEPT: limits.MIGRATION_BACKUPS_KEPT };
})();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r101-'));

function writeMigration(dir, id, upBody) {
    fs.writeFileSync(path.join(dir, `${id}-fixture.js`), `'use strict';
module.exports = {
    id: ${JSON.stringify(id)},
    description: ${JSON.stringify(`fixture ${id}`)},
    up(db) {
        ${upBody}
    }
};
`);
}

function listBackups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

function rowsOf(db, sql) {
    return JSON.parse(JSON.stringify(db.prepare(sql).all()));
}

function spawnNode(source, { dbPath, migrationsDir } = {}) {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.MIGRATIONS_DIR;
    if (dbPath) env.SQLITE_DB_PATH = dbPath;
    if (migrationsDir) env.MIGRATIONS_DIR = migrationsDir;
    return spawnSync(process.execPath, ['-e', source], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
}

function dbStartupSource() {
    return `
        const opened = require(${JSON.stringify(dbModulePath)});
        const rows = opened.db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        process.stdout.write(JSON.stringify({ dbPath: opened.dbPath, rows }));
        opened.db.close();
    `;
}

function startDatabase(dbPath, migrationsDir) {
    const result = spawnNode(dbStartupSource(), { dbPath, migrationsDir });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
}

function openRead(dbPath) {
    return new DatabaseSync(dbPath, { readOnly: true });
}

describe('r1-01 migration runner', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        assert.deepEqual(statOf(defaultDbPath), defaultDbBefore);
        assert.equal(fs.existsSync(defaultBackupDir), defaultBackupsBefore);
        assert.equal(fs.existsSync(repoBackupDir), repoBackupsBefore);
    });

    it('ignores a pre-migration backup under data/', () => {
        const result = spawnSync('git', ['check-ignore', '-q', '--', 'data/backups/x.db'], { cwd: repoRoot });
        assert.equal(result.status, 0, 'data/backups/x.db must stay gitignored; it is a full database copy');
    });

    it('publishes the D-011 limits and keeps that many backups', () => {
        const limits = require('../lib/limits');
        assert.equal(limits.MAX_GROUP_FIELDS, 2);
        assert.equal(limits.MAX_SORT_RULES, 3);
        assert.equal(limits.RESTORE_WINDOW_DAYS, 30);
        assert.equal(limits.MIGRATION_BACKUPS_KEPT, 5);
        assert.equal(keptFromRunner, 5);
    });

    it('resolves the migrations directory at call time, not at require time', () => {
        assert.equal(defaultMigrationsDir(), path.join(repoRoot, 'lib', 'migrations'));
        const dir = fs.mkdtempSync(path.join(root, 'call-time-'));
        const dbPath = path.join(dir, 'call.db');
        writeMigration(dir, '001', `db.exec('CREATE TABLE call_time (id TEXT PRIMARY KEY)');`);
        const source = `
            const { runMigrations } = require(${JSON.stringify(runnerPath)});
            process.env.MIGRATIONS_DIR = ${JSON.stringify(dir)};
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(${JSON.stringify(dbPath)});
            const result = runMigrations(db, { dbPath: ${JSON.stringify(dbPath)} });
            process.stdout.write(JSON.stringify(result.applied));
            db.close();
        `;
        const result = spawnNode(source, { dbPath });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ['001']);
        const backups = listBackups(dbPath);
        assert.equal(backups.length, 1);
        assert.equal(path.dirname(path.join(dir, 'backups', backups[0])), path.join(dir, 'backups'));
    });

    it('applies pending migrations once and takes no backup on the second startup', () => {
        const dir = fs.mkdtempSync(path.join(root, 'once-'));
        const dbPath = path.join(dir, 'once.db');
        writeMigration(dir, '001', `
            db.exec('CREATE TABLE markers (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
            db.prepare('INSERT INTO markers (id, value) VALUES (?, ?)').run('001', 'applied');
        `);
        const first = startDatabase(dbPath, dir);
        assert.equal(first.dbPath, dbPath);
        assert.deepEqual(first.rows.map(row => row.id), ['001']);
        assert.equal(typeof first.rows[0].applied_at, 'string');
        assert.ok(first.rows[0].applied_at.endsWith('Z'));
        const backups = listBackups(dbPath);
        assert.equal(backups.length, 1);
        assert.match(backups[0], /^rateninja-\d{8}T\d{9}Z-pre-001\.db$/);

        const second = startDatabase(dbPath, dir);
        assert.deepEqual(second.rows.map(row => row.id), ['001']);
        assert.deepEqual(listBackups(dbPath), backups);
        const live = openRead(dbPath);
        try {
            assert.equal(live.prepare(`SELECT value FROM markers WHERE id = '001'`).get().value, 'applied');
            const info = live.prepare('PRAGMA table_info(schema_migrations)').all();
            const appliedAt = info.find(column => column.name === 'applied_at');
            assert.equal(appliedAt.notnull, 1);
            assert.equal(info.find(column => column.name === 'id').pk, 1);
        } finally {
            live.close();
        }
    });

    it('applies a migration that arrives after a higher id', () => {
        const dir = fs.mkdtempSync(path.join(root, 'order-'));
        const dbPath = path.join(dir, 'order.db');
        const db = new DatabaseSync(dbPath);
        writeMigration(dir, '001', `db.exec('CREATE TABLE IF NOT EXISTS markers (id TEXT PRIMARY KEY)');
            db.prepare('INSERT INTO markers (id) VALUES (?)').run('001');`);
        writeMigration(dir, '003', `db.exec('CREATE TABLE IF NOT EXISTS markers (id TEXT PRIMARY KEY)');
            db.prepare('INSERT INTO markers (id) VALUES (?)').run('003');`);
        const first = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.deepEqual(first.applied, ['001', '003']);
        writeMigration(dir, '002', `db.prepare('INSERT INTO markers (id) VALUES (?)').run('002');`);
        const second = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.deepEqual(second.applied, ['002']);
        assert.deepEqual(rowsOf(db, 'SELECT id FROM markers ORDER BY id'), [
            { id: '001' },
            { id: '002' },
            { id: '003' }
        ]);
        const third = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.deepEqual(third.applied, []);
        assert.equal(third.backupPath, null);
        assert.equal(listBackups(dbPath).length, 2);
        db.close();
    });

    it('rolls a throwing migration back, names its id, and leaves the database openable', () => {
        const dir = fs.mkdtempSync(path.join(root, 'throw-'));
        const dbPath = path.join(dir, 'throw.db');
        writeMigration(dir, '001', `
            db.exec('CREATE TABLE markers (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
            db.prepare('INSERT INTO markers (id, value) VALUES (?, ?)').run('001', 'kept');
        `);
        writeMigration(dir, '002', `
            db.prepare('INSERT INTO markers (id, value) VALUES (?, ?)').run('002', 'gone');
            throw new Error('intentional failure');
        `);
        const result = spawnNode(dbStartupSource(), { dbPath, migrationsDir: dir });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Migration 002 failed: intentional failure/);
        const live = openRead(dbPath);
        try {
            assert.equal(live.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
            assert.deepEqual(rowsOf(live, 'SELECT id, value FROM markers ORDER BY id'), [{ id: '001', value: 'kept' }]);
            assert.deepEqual(rowsOf(live, 'SELECT id FROM schema_migrations ORDER BY id'), [{ id: '001' }]);
        } finally {
            live.close();
        }
    });

    it('backs up only when a migration is pending, keeps the pre-migration rows, and retains five files', () => {
        const dir = fs.mkdtempSync(path.join(root, 'backup-'));
        const dbPath = path.join(dir, 'backup.db');
        const db = new DatabaseSync(dbPath);
        db.exec(`CREATE TABLE seed (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        db.prepare(`INSERT INTO seed (id, value) VALUES ('row', 'before')`).run();
        const idle = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.deepEqual(idle.applied, []);
        assert.equal(idle.backupPath, null);
        assert.deepEqual(listBackups(dbPath), []);

        writeMigration(dir, '001', `db.prepare("UPDATE seed SET value = 'after' WHERE id = 'row'").run();`);
        const applied = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.deepEqual(applied.applied, ['001']);
        assert.equal(db.prepare(`SELECT value FROM seed WHERE id = 'row'`).get().value, 'after');
        const backups = listBackups(dbPath);
        assert.equal(backups.length, 1);
        const snap = openRead(path.join(dir, 'backups', backups[0]));
        try {
            assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
            assert.equal(snap.prepare(`SELECT value FROM seed WHERE id = 'row'`).get().value, 'before');
            assert.equal(snap.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get().count, 0);
        } finally {
            snap.close();
        }
        const again = runMigrations(db, { dbPath, migrationsDir: dir });
        assert.equal(again.backupPath, null);
        assert.deepEqual(listBackups(dbPath), backups);

        for (let number = 2; number <= 6; number += 1) {
            const id = String(number).padStart(3, '0');
            writeMigration(dir, id, 'db.exec("CREATE TABLE IF NOT EXISTS cap (id TEXT)");');
            runMigrations(db, { dbPath, migrationsDir: dir });
        }
        const kept = listBackups(dbPath);
        assert.equal(kept.length, 5);
        assert.equal(kept.some(name => name.endsWith('-pre-001.db')), false);
        assert.equal(kept.some(name => name.endsWith('-pre-002.db')), true);
        assert.equal(kept.some(name => name.endsWith('-pre-006.db')), true);
        db.close();
    });

    it('aborts before applying a migration when the backup cannot be written', () => {
        const dir = fs.mkdtempSync(path.join(root, 'nobackup-'));
        const dbPath = path.join(dir, 'nobackup.db');
        const db = new DatabaseSync(dbPath);
        db.exec(`CREATE TABLE seed (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        db.prepare(`INSERT INTO seed (id, value) VALUES ('row', 'before')`).run();
        db.close();
        fs.writeFileSync(path.join(dir, 'backups'), 'not a directory');
        writeMigration(dir, '001', `db.prepare("UPDATE seed SET value = 'after' WHERE id = 'row'").run();`);
        const result = spawnNode(dbStartupSource(), { dbPath, migrationsDir: dir });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Pre-migration backup failed before applying 001/);
        const live = openRead(dbPath);
        try {
            assert.equal(live.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
            assert.equal(live.prepare(`SELECT value FROM seed WHERE id = 'row'`).get().value, 'before');
            assert.equal(live.prepare(`SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '001'`).get().count, 0);
        } finally {
            live.close();
        }
    });

    it('does not back up a memory database and does not open the default file', () => {
        const dir = fs.mkdtempSync(path.join(root, 'memory-'));
        writeMigration(dir, '001', `db.exec('CREATE TABLE memory_marker (id TEXT)');`);
        const db = new DatabaseSync(':memory:');
        const result = runMigrations(db, { dbPath: ':memory:', migrationsDir: dir });
        assert.equal(result.backupPath, null);
        assert.deepEqual(result.applied, ['001']);
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM memory_marker`).get().count, 0);
        db.close();
        assert.equal(fs.existsSync(repoBackupDir), repoBackupsBefore);
    });

    it('leaves a populated pre-change database unchanged when nothing is pending', () => {
        const dir = fs.mkdtempSync(path.join(root, 'populated-'));
        const emptyDir = fs.mkdtempSync(path.join(dir, 'empty-'));
        const dbPath = path.join(dir, 'populated.db');
        const db = new DatabaseSync(dbPath);
        db.exec(`
            CREATE TABLE company_types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE companies (
                id TEXT PRIMARY KEY, company_id TEXT, company_name TEXT, company_type TEXT,
                company_type_id TEXT, margin_percent REAL, margin_number REAL
            );
            CREATE TABLE users (
                id TEXT PRIMARY KEY, username TEXT, pwd TEXT, display_name TEXT, admin_screen INTEGER,
                password_hash TEXT, company_record_id TEXT, disabled INTEGER NOT NULL DEFAULT 0,
                session_epoch INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE company_margins (
                id TEXT PRIMARY KEY, owner_company_id TEXT NOT NULL, customer_company_id TEXT NOT NULL,
                margin_percent REAL NOT NULL DEFAULT 0, margin_number REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE rates (
                id TEXT PRIMARY KEY, carrier TEXT, origin_port TEXT, destination_port TEXT,
                rate_20d REAL, rate_view TEXT, owner_company_id TEXT
            );
            CREATE TABLE sailings (
                id TEXT PRIMARY KEY, departure TEXT, carrier TEXT, departure_port TEXT, owner_company_id TEXT
            );
        `);
        db.prepare(`INSERT INTO company_types (id, name) VALUES ('contract_owner', 'Contract Owner')`).run();
        db.prepare(`INSERT INTO company_types (id, name) VALUES ('freight_forwarder_customer', 'Freight Forwarder/Customer')`).run();
        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, margin_percent, margin_number)
            VALUES ('owner-1', 'owner-1', 'Kept Owner', 'Contract Owner', 'contract_owner', NULL, NULL)
        `).run();
        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, margin_percent, margin_number)
            VALUES ('cust-1', 'cust-1', 'Kept Customer', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0.1, 25)
        `).run();
        db.prepare(`
            INSERT INTO users (id, username, pwd, display_name, admin_screen, password_hash, company_record_id)
            VALUES ('user-1', 'kept-user', 'plain-secret', 'Kept User', 1, 'hash-keep', 'owner-1')
        `).run();
        db.prepare(`
            INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
            VALUES ('margin-1', 'owner-1', 'cust-1', 0.15, 40, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
        `).run();
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_view, owner_company_id)
            VALUES ('rate-1', 'MSC', 'SHA', 'LAX', 1800, 'owner-1', 'owner-1')
        `).run();
        db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
            VALUES ('sailing-1', '2026-05-01T00:00:00.000Z', 'MSC', 'SHA', 'owner-1')
        `).run();
        db.close();

        function snapshot(file) {
            const opened = openRead(file);
            try {
                return JSON.parse(JSON.stringify({
                    users: opened.prepare(`SELECT id, username, pwd, display_name, admin_screen, password_hash, company_record_id FROM users ORDER BY id`).all(),
                    companies: opened.prepare(`SELECT id, company_id, company_name, company_type, company_type_id, margin_percent, margin_number FROM companies ORDER BY id`).all(),
                    margins: opened.prepare(`SELECT id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at FROM company_margins ORDER BY id`).all(),
                    rates: opened.prepare(`SELECT id, carrier, origin_port, destination_port, rate_20d, rate_view, owner_company_id FROM rates ORDER BY id`).all(),
                    sailings: opened.prepare(`SELECT id, departure, carrier, departure_port, owner_company_id FROM sailings ORDER BY id`).all()
                }));
            } finally {
                opened.close();
            }
        }

        const before = snapshot(dbPath);
        const first = startDatabase(dbPath, emptyDir);
        assert.deepEqual(first.rows, []);
        assert.deepEqual(listBackups(dbPath), []);
        assert.deepEqual(snapshot(dbPath), before);
        assert.deepEqual(snapshot(dbPath).users.map(row => row.password_hash), ['hash-keep']);
        const second = startDatabase(dbPath, emptyDir);
        assert.deepEqual(second.rows, []);
        assert.deepEqual(listBackups(dbPath), []);
        assert.deepEqual(snapshot(dbPath), before);
    });

    it('applies every shipped migration once on a fresh database and does not back up again', () => {
        const shipped = fs.readdirSync(path.join(repoRoot, 'lib', 'migrations'))
            .filter(name => /^\d{3}-.+\.js$/.test(name));
        // R1-02 removed the assertion that this list was empty. 001-roles.js is the
        // first shipped migration. The count and second-startup checks stay.
        const dir = fs.mkdtempSync(path.join(root, 'shipped-'));
        const dbPath = path.join(dir, 'shipped.db');
        const first = startDatabase(dbPath);
        assert.equal(first.dbPath, dbPath);
        assert.equal(first.rows.length, shipped.length);
        assert.equal(listBackups(dbPath).length, shipped.length === 0 ? 0 : 1);
        const backups = listBackups(dbPath);
        const second = startDatabase(dbPath);
        assert.deepEqual(second.rows.map(row => row.id), first.rows.map(row => row.id));
        assert.deepEqual(listBackups(dbPath), backups);
    });
});
