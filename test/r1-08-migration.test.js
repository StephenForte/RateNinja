'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r108-mig-'));

function openRead(dbPath) {
    return new DatabaseSync(dbPath, { readOnly: true });
}

function spawnNode(source, env) {
    const { spawnSync } = require('node:child_process');
    return spawnSync(process.execPath, ['-e', source], {
        cwd: repoRoot,
        env,
        encoding: 'utf8'
    });
}

function createBaseline(dbPath) {
    const empty = fs.mkdtempSync(path.join(root, 'baseline-'));
    const env = { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: empty };
    const result = spawnNode(`
        const opened = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        opened.db.close();
    `, env);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function apply001(dbPath) {
    const dir = fs.mkdtempSync(path.join(root, 'only-001-'));
    fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', '001-roles.js'), path.join(dir, '001-roles.js'));
    const env = { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: dir };
    const result = spawnNode(`
        const opened = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const ids = opened.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id);
        if (ids.join(',') !== '001') throw new Error('expected only 001, got ' + ids.join(','));
        opened.db.close();
    `, env);
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
    db.prepare(`
        INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_40d, rate_effective_date, owner_company_id)
        VALUES ('rate-1', 'MSC', 'SHA', 'LAX', 1000, NULL, '2026-04-01', 'kings')
    `).run();
    db.prepare(`
        INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id)
        VALUES ('rate-2', 'CMA', 'NGB', 'NYC', 800, '2026-05-01', 'kings')
    `).run();
    db.prepare(`
        INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
        VALUES ('sail-1', '2026-05-01T00:00:00.000Z', 'MSC', 'SHA', 'kings')
    `).run();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES ('margin-1', 'kings', 'blackwater-shippers', 0.1, 25, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES ('margin-2', 'kings', 'eceiPwdeF95uwQfD', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
}

function counts(db) {
    return {
        rates: db.prepare('SELECT COUNT(*) AS count FROM rates').get().count,
        sailings: db.prepare('SELECT COUNT(*) AS count FROM sailings').get().count,
        margins: db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count
    };
}

function listBackups(dbPath) {
    const dir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.db')).sort();
}

function startServer(dbPath) {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.MIGRATIONS_DIR;
    env.SQLITE_DB_PATH = dbPath;
    env.PORT = '35108';
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

describe('r1-08 migration 006', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('versions a populated database that already has 001, then does nothing on the next start', async () => {
        const dir = fs.mkdtempSync(path.join(root, 'populated-'));
        const dbPath = path.join(dir, 'r108.db');
        assert.equal(dbPath.includes(`${path.sep}data${path.sep}rateninja.db`), false);
        createBaseline(dbPath);
        apply001(dbPath);
        const seeded = new DatabaseSync(dbPath);
        seed(seeded);
        const before = counts(seeded);
        assert.equal(seeded.prepare(`SELECT name FROM pragma_table_info('rates') WHERE name = 'row_version'`).get(), undefined);
        seeded.close();

        const first = startServer(dbPath);
        try {
            await first.ready;
        } catch (error) {
            await stopServer(first.child);
            throw error;
        }
        await stopServer(first.child);

        const opened = openRead(dbPath);
        let migrations;
        try {
            migrations = opened.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
            assert.deepEqual(migrations.map(row => row.id), ['001', '002', '005', '006']);
            assert.deepEqual(counts(opened), before);
            for (const table of ['rates', 'sailings']) {
                const rows = opened.prepare(`SELECT id, row_version, deleted_at FROM ${table} ORDER BY id`).all();
                assert.ok(rows.length > 0, table);
                for (const row of rows) {
                    assert.equal(row.row_version, 1, row.id);
                    assert.equal(row.deleted_at, null, row.id);
                }
            }
            assert.equal(opened.prepare(`SELECT rate_40d FROM rates WHERE id = 'rate-1'`).get().rate_40d, null);
            const indexes = opened.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map(row => row.name);
            assert.ok(indexes.includes('idx_rates_deleted_at'));
            assert.ok(indexes.includes('idx_sailings_deleted_at'));
        } finally {
            opened.close();
        }
        const backups = listBackups(dbPath);
        assert.ok(backups.some(name => name.includes('-pre-002.db')));

        const second = startServer(dbPath);
        try {
            await second.ready;
        } catch (error) {
            await stopServer(second.child);
            throw error;
        }
        await stopServer(second.child);
        const again = openRead(dbPath);
        try {
            assert.deepEqual(again.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(), migrations);
            assert.deepEqual(counts(again), before);
            assert.equal(again.prepare(`SELECT row_version, deleted_at FROM rates WHERE id = 'rate-1'`).get().row_version, 1);
        } finally {
            again.close();
        }
        assert.deepEqual(listBackups(dbPath), backups);
    });
});
