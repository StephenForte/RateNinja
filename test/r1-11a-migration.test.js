'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r111-mig-'));
const EARLIER = [
    '001-roles.js',
    '002-password-lifecycle.js',
    '003-saved-preferences.js',
    '004-login-uniqueness.js',
    '005-customer-authorization.js',
    '006-data-operations.js'
];

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

describe('r1-11a migration 008', () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('adds the job table and columns on a populated database and is a no-op the second time', () => {
        const dbPath = path.join(root, 'populated.db');
        const earlier = fs.mkdtempSync(path.join(root, 'earlier-'));
        for (const name of EARLIER) {
            fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', name), path.join(earlier, name));
        }
        const first = boot(dbPath, earlier);
        assert.deepEqual(first, ['001', '002', '003', '004', '005', '006']);
        const db = new DatabaseSync(dbPath);
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, owner_company_id)
            VALUES ('rate-keep', 'MSC', 'SHA', 'LAX', 1000, 'owner')
        `).run();
        db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
            VALUES ('sail-keep', '2026-05-01T00:00:00.000Z', 'MSC', 'SHA', 'owner')
        `).run();
        const before = {
            rates: db.prepare('SELECT COUNT(*) AS count FROM rates').get().count,
            sailings: db.prepare('SELECT COUNT(*) AS count FROM sailings').get().count
        };
        assert.equal(db.prepare(`PRAGMA table_info(rates)`).all().some(column => column.name === 'contract_number'), false);
        assert.equal(db.prepare(`PRAGMA table_info(sailings)`).all().some(column => column.name === 'arrival_port'), false);
        db.close();

        const second = boot(dbPath, path.join(repoRoot, 'lib', 'migrations'));
        assert.deepEqual(second, ['001', '002', '003', '004', '005', '006', '008']);
        const opened = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(opened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_jobs'`).get().name, 'import_jobs');
        assert.equal(opened.prepare(`PRAGMA table_info(rates)`).all().some(column => column.name === 'contract_number'), true);
        assert.equal(opened.prepare(`PRAGMA table_info(sailings)`).all().some(column => column.name === 'arrival_port'), true);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM rates').get().count, before.rates);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM sailings').get().count, before.sailings);
        assert.equal(opened.prepare(`SELECT rate_20d FROM rates WHERE id = 'rate-keep'`).get().rate_20d, 1000);
        opened.close();

        const third = boot(dbPath, path.join(repoRoot, 'lib', 'migrations'));
        assert.deepEqual(third, ['001', '002', '003', '004', '005', '006', '008']);
    });
});
