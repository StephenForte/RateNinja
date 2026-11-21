'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');
const { seedManagedAgents, tableHashes } = require('./helpers/r1-33');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function boot(dbPath, source, migrationsDir) {
    const env = { ...process.env, SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: migrationsDir };
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], { cwd: source, env, stdio: 'pipe' });
}

it('R1-33 migration 013 preserves populated 012 data and does no work on the next boot', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r133-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const baselineRoot = process.env.R1_33_BASELINE_ROOT || root;
    const earlier = path.join(directory, 'earlier');
    let db;
    try {
        fs.mkdirSync(earlier);
        for (const name of fs.readdirSync(path.join(baselineRoot, 'lib', 'migrations'))) {
            if (/^\d{3}-.+\.js$/.test(name) && name < '013') {
                fs.copyFileSync(path.join(baselineRoot, 'lib', 'migrations', name), path.join(earlier, name));
            }
        }
        boot(dbPath, baselineRoot, earlier);
        db = new DatabaseSync(dbPath);
        seedManagedAgents(db);
        const ids = () => db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id);
        const beforeIds = ids();
        assert.equal(beforeIds.at(-1), '012');
        const before = tableHashes(db);
        assert.ok(!Object.hasOwn(before, 'managed_agents'));
        db.close();
        db = null;

        boot(dbPath, root, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(ids(), [...beforeIds, '013', '014', '015', '016', '017', '018']);
        const {
            managed_agents: agentsHash, booking_receipts: receiptsHash, managed_agent_runs: runsHash, ...after
        } = tableHashes(db);
        assert.ok(agentsHash);
        assert.ok(receiptsHash);
        assert.ok(runsHash);
        assert.deepEqual(after, before);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_agents').get().n, 0);
        const index = db.prepare('PRAGMA index_info(managed_agents_company_created)').all();
        assert.deepEqual(index.map(column => column.name), ['company_id', 'created_at']);
        const applied = db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '013'").get();
        const backupDir = path.join(directory, 'backups');
        const backups = fs.readdirSync(backupDir);
        assert.equal(backups.filter(name => name.endsWith('-pre-013.db')).length, 1);
        db.close();
        db = null;

        boot(dbPath, root, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(ids(), [...beforeIds, '013', '014', '015', '016', '017', '018']);
        assert.deepEqual(tableHashes(db), {
            ...before, managed_agents: agentsHash, booking_receipts: receiptsHash, managed_agent_runs: runsHash
        });
        assert.deepEqual(db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '013'").get(), applied);
        assert.deepEqual(fs.readdirSync(backupDir), backups);
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
