const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATION_BACKUPS_KEPT } = require('../limits');

const MIGRATION_FILE = /^(\d{3})-[A-Za-z0-9][A-Za-z0-9-]*\.js$/;
const BACKUP_FILE = /^rateninja-\d{8}T\d{9}Z-pre-\d{3}\.db$/;

function defaultMigrationsDir() {
    return __dirname;
}

function resolveMigrationsDir(explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return path.resolve(explicit);
    if (typeof process.env.MIGRATIONS_DIR === 'string' && process.env.MIGRATIONS_DIR.trim()) {
        return path.resolve(process.env.MIGRATIONS_DIR);
    }
    return defaultMigrationsDir();
}

function isFileBacked(dbPath) {
    if (typeof dbPath !== 'string') return false;
    const value = dbPath.trim();
    if (!value || value === ':memory:' || value.includes('mode=memory')) return false;
    return true;
}

function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function utcStamp(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureSchemaMigrations(db) {
    const existing = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (existing) return;
    db.exec(`
        CREATE TABLE schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
    `);
}

function loadMigrations(directory) {
    let entries;
    try {
        entries = fs.readdirSync(directory);
    } catch (cause) {
        throw new Error(`Migrations directory not found (${directory}): ${cause.message}`);
    }
    const loaded = [];
    const seen = new Set();
    for (const name of entries) {
        const match = MIGRATION_FILE.exec(name);
        if (!match) continue;
        const filePath = path.join(directory, name);
        if (!fs.statSync(filePath).isFile()) continue;
        const resolved = require.resolve(filePath);
        delete require.cache[resolved];
        const migration = require(resolved);
        const id = migration && migration.id;
        if (id !== match[1]) {
            throw new Error(`Migration file ${name} exports id '${id}', which does not match its filename prefix ${match[1]}.`);
        }
        if (typeof migration.description !== 'string' || !migration.description.trim()) {
            throw new Error(`Migration ${id} is missing a description.`);
        }
        if (typeof migration.up !== 'function') {
            throw new Error(`Migration ${id} is missing an up(db) function.`);
        }
        if (seen.has(id)) throw new Error(`Duplicate migration id ${id}.`);
        seen.add(id);
        loaded.push({ id, description: migration.description, up: migration.up, file: name });
    }
    loaded.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
    return loaded;
}

function assertBackupReadable(backupPath) {
    const snap = new DatabaseSync(backupPath, { readOnly: true });
    try {
        const row = snap.prepare('PRAGMA integrity_check').get();
        const value = row && row.integrity_check;
        if (value !== 'ok') throw new Error(`integrity check returned ${value}`);
    } finally {
        snap.close();
    }
}

function pruneBackups(backupDir) {
    const names = fs.readdirSync(backupDir).filter(name => BACKUP_FILE.test(name)).sort();
    if (names.length <= MIGRATION_BACKUPS_KEPT) return;
    const excess = names.slice(0, names.length - MIGRATION_BACKUPS_KEPT);
    for (const name of excess) {
        fs.unlinkSync(path.join(backupDir, name));
    }
}

function failBackup(firstPendingId, cause) {
    const message = cause && cause.message ? cause.message : String(cause);
    if (message.startsWith('Pre-migration backup failed before applying ')) {
        return cause instanceof Error ? cause : new Error(message);
    }
    const error = new Error(`Pre-migration backup failed before applying ${firstPendingId}: ${message}`);
    error.cause = cause;
    return error;
}

function createBackup(db, dbPath, firstPendingId) {
    const backupDir = path.join(path.dirname(path.resolve(dbPath)), 'backups');
    let backupPath = '';
    let wrote = false;
    try {
        fs.mkdirSync(backupDir, { recursive: true });
        let filename = '';
        for (let attempt = 0; attempt < 5; attempt += 1) {
            filename = `rateninja-${utcStamp()}-pre-${firstPendingId}.db`;
            backupPath = path.join(backupDir, filename);
            if (!fs.existsSync(backupPath)) break;
            sleepSync(2);
        }
        if (!BACKUP_FILE.test(filename)) {
            throw new Error(`refusing to write an unexpected backup name ${filename}`);
        }
        if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${filename}`);
        wrote = true;
        db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
        assertBackupReadable(backupPath);
        wrote = false;
        pruneBackups(backupDir);
        return backupPath;
    } catch (cause) {
        if (wrote) {
            try {
                fs.rmSync(backupPath, { force: true });
            } catch {
                // The failed snapshot is removed when the directory allows it.
            }
        }
        throw failBackup(firstPendingId, cause);
    }
}

function applyMigration(db, migration) {
    db.exec('BEGIN IMMEDIATE');
    try {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
            migration.id,
            new Date().toISOString()
        );
        db.exec('COMMIT');
    } catch (cause) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // The transaction may already be closed.
        }
        const message = cause && cause.message ? cause.message : String(cause);
        const error = new Error(`Migration ${migration.id} failed: ${message}`);
        error.cause = cause;
        error.migrationId = migration.id;
        throw error;
    }
}

function runMigrations(db, options = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
        throw new TypeError('runMigrations requires a database connection.');
    }
    if (typeof options.dbPath !== 'string') {
        throw new TypeError('runMigrations requires dbPath so a file-backed database can be backed up before migrations.');
    }
    const directory = resolveMigrationsDir(options.migrationsDir);
    ensureSchemaMigrations(db);
    const discovered = loadMigrations(directory);
    const appliedIds = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(row => row.id));
    const pending = discovered.filter(migration => !appliedIds.has(migration.id));
    if (pending.length === 0) return { applied: [], backupPath: null };
    const backupPath = isFileBacked(options.dbPath) ? createBackup(db, options.dbPath, pending[0].id) : null;
    const applied = [];
    for (const migration of pending) {
        applyMigration(db, migration);
        applied.push(migration.id);
    }
    return { applied, backupPath };
}

module.exports = {
    runMigrations,
    defaultMigrationsDir
};
