'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r104-mig-'));

function listBackups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

function counts(db) {
    return {
        users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
        companies: db.prepare('SELECT COUNT(*) AS count FROM companies').get().count,
        rates: db.prepare('SELECT COUNT(*) AS count FROM rates').get().count,
        margins: db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count,
        sailings: db.prepare('SELECT COUNT(*) AS count FROM sailings').get().count
    };
}

function createBaseline(dbPath) {
    const empty = fs.mkdtempSync(path.join(root, 'baseline-'));
    const result = spawnSync(process.execPath, ['-e', `
        const opened = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const columns = opened.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
        if (columns.includes('must_change_password') || columns.includes('company_role')) {
            throw new Error('Baseline database already has later columns.');
        }
        opened.db.close();
    `], {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: empty },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function seed(db) {
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('kings', 'kings', 'Kings', 'Contract Owner', 'contract_owner', 1)
    `).run();
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('blackwater-shippers', 'blackwater-shippers', 'Blackwater Shippers', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
    `).run();
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('eceiPwdeF95uwQfD', 'eceiPwdeF95uwQfD', 'Blue Sky Shipping', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
    `).run();
    for (const user of [
        ['user-stevef', 'SteveF', 1, 'kings'],
        ['user-alan', 'Alan', 0, 'blackwater-shippers'],
        ['user-bob', 'Bob', 0, 'eceiPwdeF95uwQfD'],
        ['user-cara', 'Cara', 1, 'blackwater-shippers']
    ]) {
        db.prepare(`
            INSERT INTO users (id, username, display_name, admin_screen, password_hash, company_record_id, company_id, disabled, session_epoch)
            VALUES (?, ?, ?, ?, 'hash-keep', ?, ?, 0, 4)
        `).run(user[0], user[1], user[1], user[2], user[3], user[3]);
    }
    db.prepare(`
        INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
        VALUES ('rate-1', 'MSC', 'SHA', 'LAX', 1000, '2026-04-01', 'kings')
    `).run();
}

function boot(dbPath, migrationsDir) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        PORT: '0',
        HOST: '127.0.0.1',
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    delete env.MIGRATIONS_DIR;
    if (migrationsDir) env.MIGRATIONS_DIR = migrationsDir;
    const result = spawnSync(process.execPath, ['-e', `
        const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const { ensureFoundation } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'foundation.js'))});
        ensureFoundation();
        const ids = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id);
        process.stdout.write(JSON.stringify({ ids }));
        db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
}

describe('r1-04 migration 002', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('adds the password columns to a populated pre-002 database and is a no-op the second time', () => {
        const dir = fs.mkdtempSync(path.join(root, 'populated-'));
        const dbPath = path.join(dir, 'rateninja.db');
        const only001 = fs.mkdtempSync(path.join(root, 'only-001-'));
        fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', '001-roles.js'), path.join(only001, '001-roles.js'));
        createBaseline(dbPath);
        const seeded = new DatabaseSync(dbPath);
        seed(seeded);
        seeded.close();

        const first = boot(dbPath, only001);
        assert.deepEqual(first.ids, ['001']);
        const after001 = new DatabaseSync(dbPath, { readOnly: true });
        let beforeCounts;
        let beforeUsers;
        try {
            beforeCounts = counts(after001);
            beforeUsers = after001.prepare('SELECT COUNT(*) AS count FROM users').get().count;
            const columns = after001.prepare('PRAGMA table_info(users)').all().map(column => column.name);
            assert.equal(columns.includes('must_change_password'), false);
        } finally {
            after001.close();
        }
        const backupsAfter001 = listBackups(dbPath);
        assert.equal(backupsAfter001.length, 1);
        assert.match(backupsAfter001[0], /-pre-001\.db$/);

        const second = boot(dbPath);
        assert.deepEqual(second.ids, ['001', '002']);
        const migrated = new DatabaseSync(dbPath, { readOnly: true });
        let flags;
        let afterCounts;
        let applied;
        try {
            flags = migrated.prepare(`
                SELECT username, must_change_password, password_changed_at, password_hash, session_epoch
                FROM users ORDER BY username
            `).all();
            afterCounts = counts(migrated);
            applied = migrated.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        } finally {
            migrated.close();
        }
        assert.equal(flags.length, beforeUsers);
        assert.ok(flags.length >= 4);
        for (const user of flags) {
            assert.equal(user.must_change_password, 0, user.username);
            assert.equal(user.password_changed_at, null, user.username);
        }
        assert.equal(flags.find(user => user.username === 'SteveF').password_hash, 'hash-keep');
        assert.equal(flags.find(user => user.username === 'Cara').session_epoch, 4);
        assert.deepEqual(afterCounts, beforeCounts);
        const backupsAfter002 = listBackups(dbPath);
        assert.equal(backupsAfter002.length, 2);
        assert.equal(backupsAfter002.some(name => name.endsWith('-pre-002.db')), true);

        const third = boot(dbPath);
        assert.deepEqual(third.ids, ['001', '002']);
        const again = new DatabaseSync(dbPath, { readOnly: true });
        let appliedAgain;
        try {
            appliedAgain = again.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
            assert.deepEqual(counts(again), afterCounts);
        } finally {
            again.close();
        }
        assert.deepEqual(appliedAgain, applied);
        assert.deepEqual(listBackups(dbPath), backupsAfter002);

        const replay = new DatabaseSync(dbPath);
        try {
            const migration = require('../lib/migrations/002-password-lifecycle');
            migration.up(replay);
            assert.equal(replay.prepare('SELECT COUNT(*) AS count FROM users').get().count, flags.length);
            assert.equal(replay.prepare(`
                SELECT COUNT(*) AS count FROM users WHERE must_change_password = 0
            `).get().count, flags.length);
        } finally {
            replay.close();
        }
    });
});
