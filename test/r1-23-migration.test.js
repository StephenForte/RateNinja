'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { ratesSailingsChecksum } = require('./helpers/r1-23');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r123-mig-'));
const EARLIER = [
    '001-roles.js',
    '002-password-lifecycle.js',
    '003-saved-preferences.js',
    '004-login-uniqueness.js',
    '005-customer-authorization.js',
    '006-data-operations.js',
    '008-import-jobs.js',
    '010-booking-requests.js'
];
const FULL = ['001', '002', '003', '004', '005', '006', '008', '010', '011', '012', '013', '014', '015'];

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

describe('r1-23 migration 011', () => {
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
        assert.equal(opened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ports'`).get().name, 'ports');
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM ports').get().count, 0);
        const columns = opened.prepare('PRAGMA table_info(ports)').all().map(row => row.name).sort();
        assert.deepEqual(columns, ['code', 'created_at', 'id', 'name', 'updated_at']);
        opened.close();
        const firstBackups = backups(dbPath);
        assert.equal(firstBackups.length, 1);
        assert.match(firstBackups[0], /^rateninja-\d{8}T\d{9}Z-pre-001\.db$/);
        const second = boot(dbPath);
        assert.deepEqual(second, FULL);
        assert.deepEqual(backups(dbPath), firstBackups);
    });

    it('applies on a populated pre-011 database without changing rates or sailings', () => {
        const dir = path.join(root, 'populated');
        fs.mkdirSync(dir);
        const dbPath = path.join(dir, 'app.db');
        const earlier = fs.mkdtempSync(path.join(root, 'earlier-'));
        for (const name of EARLIER) {
            fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', name), path.join(earlier, name));
        }
        assert.deepEqual(boot(dbPath, earlier), ['001', '002', '003', '004', '005', '006', '008', '010']);
        const db = new DatabaseSync(dbPath);
        db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
            VALUES ('own-1', 'own-1', 'Synthetic Owner', 'Contract Owner', 'contract_owner', 1)
        `).run();
        db.prepare(`
            INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, owner_company_id, row_version)
            VALUES ('rate-keep', 'MSC', 'Port Klang', 'Seattle', 1000, 'own-1', 1)
        `).run();
        db.prepare(`
            INSERT INTO sailings (id, carrier, departure_port, arrival_port, owner_company_id, row_version)
            VALUES ('sail-keep', 'MSC', 'LALB', 'Port Klang', 'own-1', 1)
        `).run();
        const beforeCounts = {
            rates: db.prepare('SELECT COUNT(*) AS count FROM rates').get().count,
            sailings: db.prepare('SELECT COUNT(*) AS count FROM sailings').get().count
        };
        const beforeChecksum = ratesSailingsChecksum(db);
        assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ports'`).get(), undefined);
        db.close();

        const applied = boot(dbPath);
        assert.deepEqual(applied, FULL);
        const names = backups(dbPath);
        const pre011 = names.filter(name => name.endsWith('-pre-011.db'));
        assert.equal(pre011.length, 1);
        assert.match(pre011[0], /^rateninja-\d{8}T\d{9}Z-pre-011\.db$/);

        const opened = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM rates').get().count, beforeCounts.rates);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM sailings').get().count, beforeCounts.sailings);
        assert.equal(ratesSailingsChecksum(opened), beforeChecksum);
        assert.equal(opened.prepare('SELECT COUNT(*) AS count FROM ports').get().count, 0);
        opened.close();

        const again = boot(dbPath);
        assert.deepEqual(again, FULL);
        assert.deepEqual(backups(dbPath), names);
        const finalDb = new DatabaseSync(dbPath, { readOnly: true });
        assert.equal(ratesSailingsChecksum(finalDb), beforeChecksum);
        finalDb.close();
    });
});
