'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r102-mig-'));

function listBackups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

function openRead(dbPath) {
    return new DatabaseSync(dbPath, { readOnly: true });
}

function createBaseline(dbPath) {
    const empty = fs.mkdtempSync(path.join(root, 'baseline-'));
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.MIGRATIONS_DIR;
    env.SQLITE_DB_PATH = dbPath;
    env.MIGRATIONS_DIR = empty;
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `
        const opened = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const columns = opened.db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
        if (columns.includes('company_role') || columns.includes('is_system_admin')) {
            throw new Error('Baseline database already has role columns.');
        }
        opened.db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function seedPreChange(db) {
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('kings', 'kings', 'Kings Custom', 'Contract Owner', 'contract_owner', 1)
    `).run();
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('blackwater-shippers', 'blackwater-shippers', 'Blackwater Shippers', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
    `).run();
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
        VALUES ('eceiPwdeF95uwQfD', 'eceiPwdeF95uwQfD', 'Blue Sky Custom', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
    `).run();
    db.prepare(`
        INSERT INTO users (id, username, display_name, admin_screen, password_hash, company_record_id, company_id, disabled, session_epoch)
        VALUES ('user-stevef', 'SteveF', 'SteveF', 1, 'hash-keep', 'kings', 'kings', 0, 0)
    `).run();
    db.prepare(`
        INSERT INTO users (id, username, display_name, admin_screen, company_record_id, company_id, disabled, session_epoch)
        VALUES ('user-alan', 'Alan', 'Alan', 0, 'blackwater-shippers', 'blackwater-shippers', 0, 0)
    `).run();
    db.prepare(`
        INSERT INTO users (id, username, display_name, admin_screen, company_record_id, company_id, disabled, session_epoch)
        VALUES ('user-bob', 'Bob', 'Bob', 0, 'eceiPwdeF95uwQfD', 'eceiPwdeF95uwQfD', 0, 0)
    `).run();
    db.prepare(`
        INSERT INTO users (id, username, display_name, admin_screen, company_record_id, company_id, disabled, session_epoch)
        VALUES ('user-cara', 'Cara', 'Cara', 1, 'blackwater-shippers', 'blackwater-shippers', 0, 0)
    `).run();
    db.prepare(`
        INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
        VALUES ('rate-1', 'MSC', 'SHA', 'LAX', 1000, '2026-04-01', 'kings')
    `).run();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES ('margin-1', 'kings', 'blackwater-shippers', 0.1, 25, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES ('margin-2', 'kings', 'eceiPwdeF95uwQfD', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
        UPDATE users SET display_name = 'Stephen Forte' WHERE username = 'SteveF'
    `).run();
    db.prepare(`
        UPDATE users SET company_record_id = 'blackwater-shippers', company_id = 'blackwater-shippers' WHERE username = 'Bob'
    `).run();
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

function roles(db) {
    return db.prepare(`
        SELECT username, admin_screen, company_role, is_system_admin, display_name, company_record_id, password_hash
        FROM users ORDER BY username
    `).all();
}

function startServer(dbPath) {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.MIGRATIONS_DIR;
    env.SQLITE_DB_PATH = dbPath;
    env.PORT = '0';
    env.HOST = '127.0.0.1';
    env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
    env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Server did not start:\n${output}`));
        }, 20000);
        const onData = chunk => {
            output += chunk.toString();
            if (output.includes('Rate Ninja is running')) {
                clearTimeout(timer);
                resolve(output);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', code => {
            clearTimeout(timer);
            reject(new Error(`Server exited ${code} before listening:\n${output}`));
        });
    });
    return { child, ready };
}

function stopServer(child) {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function boot(dbPath) {
    const started = startServer(dbPath);
    try {
        await started.ready;
    } catch (error) {
        await stopServer(started.child);
        throw error;
    }
    await stopServer(started.child);
}

describe('r1-02 migration 001', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('backfills a populated pre-change database once and keeps administrator edits', async () => {
        const dir = fs.mkdtempSync(path.join(root, 'populated-'));
        const dbPath = path.join(dir, 'rateninja.db');
        assert.equal(dbPath.includes(`${path.sep}data${path.sep}rateninja.db`), false);
        createBaseline(dbPath);
        const db = new DatabaseSync(dbPath);
        seedPreChange(db);
        const before = counts(db);
        db.close();

        await boot(dbPath);
        const first = openRead(dbPath);
        let firstMigrations;
        let firstRoles;
        let firstCounts;
        let firstCompanies;
        try {
            firstMigrations = first.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
            firstRoles = roles(first);
            firstCounts = counts(first);
            firstCompanies = first.prepare('SELECT id, company_name FROM companies ORDER BY id').all();
            const columns = first.prepare('PRAGMA table_info(users)').all().map(column => column.name);
            assert.ok(columns.includes('is_system_admin'));
            assert.ok(columns.includes('company_role'));
        } finally {
            first.close();
        }
        const firstBackups = listBackups(dbPath);
        assert.deepEqual(firstMigrations.map(row => row.id), ['001', '002']);
        assert.equal(firstBackups.length, 1);
        assert.match(firstBackups[0], /^rateninja-\d{8}T\d{9}Z-pre-001\.db$/);
        assert.deepEqual(firstCounts, before);
        assert.deepEqual(firstRoles.map(row => ({
            username: row.username,
            admin_screen: row.admin_screen,
            company_role: row.company_role,
            is_system_admin: row.is_system_admin
        })), [
            { username: 'Alan', admin_screen: 0, company_role: 'member', is_system_admin: 0 },
            { username: 'Bob', admin_screen: 0, company_role: 'member', is_system_admin: 0 },
            { username: 'Cara', admin_screen: 1, company_role: 'company_admin', is_system_admin: 0 },
            { username: 'SteveF', admin_screen: 1, company_role: 'company_admin', is_system_admin: 1 }
        ]);
        const steve = firstRoles.find(row => row.username === 'SteveF');
        const bob = firstRoles.find(row => row.username === 'Bob');
        assert.equal(steve.display_name, 'Stephen Forte');
        assert.equal(steve.password_hash, 'hash-keep');
        assert.equal(bob.company_record_id, 'blackwater-shippers');
        assert.equal(firstCompanies.find(row => row.id === 'kings').company_name, 'Kings Custom');
        assert.equal(firstCompanies.find(row => row.id === 'eceiPwdeF95uwQfD').company_name, 'Blue Sky Custom');

        await boot(dbPath);
        const second = openRead(dbPath);
        let secondMigrations;
        let secondRoles;
        try {
            secondMigrations = second.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
            secondRoles = roles(second);
        } finally {
            second.close();
        }
        assert.deepEqual(secondMigrations, firstMigrations);
        assert.deepEqual(listBackups(dbPath), firstBackups);
        assert.equal(secondRoles.find(row => row.username === 'SteveF').display_name, 'Stephen Forte');
        assert.equal(secondRoles.find(row => row.username === 'Bob').company_record_id, 'blackwater-shippers');
    });

    it('is safe when the role columns already exist', async () => {
        const dir = fs.mkdtempSync(path.join(root, 'columns-'));
        const dbPath = path.join(dir, 'rateninja.db');
        createBaseline(dbPath);
        const db = new DatabaseSync(dbPath);
        db.exec(`
            ALTER TABLE users ADD COLUMN is_system_admin INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE users ADD COLUMN company_role TEXT NOT NULL DEFAULT 'member';
        `);
        db.prepare(`
            INSERT INTO users (id, username, display_name, admin_screen, company_role, is_system_admin, disabled, session_epoch)
            VALUES ('user-stevef', 'SteveF', 'Already', 1, 'member', 0, 0, 0)
        `).run();
        db.close();
        await boot(dbPath);
        const opened = openRead(dbPath);
        try {
            const row = opened.prepare(`
                SELECT company_role, is_system_admin, display_name FROM users WHERE username = 'SteveF'
            `).get();
            assert.equal(row.company_role, 'company_admin');
            assert.equal(row.is_system_admin, 1);
            assert.equal(row.display_name, 'Already');
            assert.deepEqual(opened.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id), ['001', '002']);
        } finally {
            opened.close();
        }
        assert.equal(listBackups(dbPath).length, 1);
    });
});
