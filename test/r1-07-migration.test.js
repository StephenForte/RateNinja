'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r107-mig-'));

function snapshot(db) {
    return db.prepare(`
        SELECT id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at
        FROM company_margins
        ORDER BY id
    `).all();
}

function startServer(dbPath) {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.MIGRATIONS_DIR;
    env.SQLITE_DB_PATH = dbPath;
    env.PORT = '35107';
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
    return { child, ready, output: () => output };
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

describe('r1-07 migration 005', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps existing margin rows active, logs margin_percent = 1, and does nothing on a second start', async () => {
        const dir = fs.mkdtempSync(path.join(root, 'populated-'));
        const dbPath = path.join(dir, 'r107.db');
        const migrations = fs.mkdtempSync(path.join(dir, 'migrations-'));
        fs.copyFileSync(
            path.join(repoRoot, 'lib', 'migrations', '001-roles.js'),
            path.join(migrations, '001-roles.js')
        );
        const seed = path.join(dir, 'seed.js');
        fs.writeFileSync(seed, `
            const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
            const now = '2026-03-01T00:00:00.000Z';
            db.prepare(\`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin) VALUES ('kings', 'kings', 'Kings', 'Contract Owner', 'contract_owner', 1)\`).run();
            db.prepare(\`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin) VALUES ('blackwater-shippers', 'blackwater-shippers', 'Blackwater Shippers', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)\`).run();
            db.prepare(\`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin) VALUES ('eceiPwdeF95uwQfD', 'eceiPwdeF95uwQfD', 'Blue Sky Shipping', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)\`).run();
            db.prepare(\`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin) VALUES ('percent-one', 'percent-one', 'Percent One', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)\`).run();
            db.prepare(\`INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin) VALUES ('percent-ten', 'percent-ten', 'Percent Ten', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)\`).run();
            db.prepare(\`INSERT INTO users (id, username, display_name, admin_screen, company_role, is_system_admin, company_record_id, disabled, session_epoch) VALUES ('user-stevef', 'SteveF', 'SteveF', 1, 'company_admin', 1, 'kings', 0, 0)\`).run();
            db.prepare(\`INSERT INTO users (id, username, display_name, admin_screen, company_role, is_system_admin, company_record_id, disabled, session_epoch) VALUES ('user-alan', 'Alan', 'Alan', 0, 'member', 0, 'blackwater-shippers', 0, 0)\`).run();
            db.prepare(\`INSERT INTO users (id, username, display_name, admin_screen, company_role, is_system_admin, company_record_id, disabled, session_epoch) VALUES ('user-bob', 'Bob', 'Bob', 0, 'member', 0, 'eceiPwdeF95uwQfD', 0, 0)\`).run();
            const insert = db.prepare(\`INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at) VALUES (?, 'kings', ?, ?, ?, ?, ?)\`);
            insert.run('margin-blackwater', 'blackwater-shippers', 0.1, 25, now, now);
            insert.run('margin-bluesky', 'eceiPwdeF95uwQfD', 0, 0, now, now);
            insert.run('margin-one', 'percent-one', 1, 5, now, now);
            insert.run('margin-ten', 'percent-ten', 10, 0, now, now);
            db.close();
        `);
        const seeded = spawn(process.execPath, [seed], {
            cwd: repoRoot,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                SQLITE_DB_PATH: dbPath,
                MIGRATIONS_DIR: migrations,
                SESSION_SECRET: 'test-session-secret-value-which-is-long'
            }
        });
        const seedResult = await new Promise(resolve => {
            let stderr = '';
            seeded.stderr.on('data', chunk => { stderr += chunk.toString(); });
            seeded.on('exit', code => resolve({ code, stderr }));
        });
        assert.equal(seedResult.code, 0, seedResult.stderr);

        const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
        const before = snapshot(beforeDb);
        const beforeCount = beforeDb.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count;
        beforeDb.close();
        assert.equal(beforeCount, 4);
        assert.equal(before.find(row => row.id === 'margin-one').margin_percent, 1);

        const first = startServer(dbPath);
        let firstOutput = '';
        try {
            firstOutput = await first.ready;
        } finally {
            await stopServer(first.child);
        }
        assert.match(firstOutput, /R1-07 customer-authorization margin_percent=1 id=margin-one/);
        assert.equal(firstOutput.split('id=margin-one').length - 1, 1);
        assert.equal(firstOutput.includes('id=margin-ten'), false);
        assert.equal(firstOutput.includes('id=margin-blackwater'), false);

        const afterDb = new DatabaseSync(dbPath, { readOnly: true });
        const after = snapshot(afterDb);
        const statuses = afterDb.prepare('SELECT id, status, authorized_at, revoked_at, updated_by FROM company_margins ORDER BY id').all();
        const applied = afterDb.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        afterDb.close();
        assert.equal(after.length, beforeCount);
        assert.deepEqual(after, before);
        assert.deepEqual(applied.map(row => row.id), ['001', '002', '003', '005', '006']);
        for (const row of statuses) {
            assert.equal(row.status, 'active', row.id);
            assert.equal(row.revoked_at, null, row.id);
            assert.equal(row.updated_by, null, row.id);
            const original = before.find(item => item.id === row.id);
            assert.equal(row.authorized_at, original.created_at, row.id);
        }
        assert.equal(statuses.find(row => row.id === 'margin-one').status, 'active');

        const second = startServer(dbPath);
        let secondOutput = '';
        try {
            secondOutput = await second.ready;
        } finally {
            await stopServer(second.child);
        }
        assert.equal(secondOutput.includes('margin_percent=1'), false);
        const finalDb = new DatabaseSync(dbPath, { readOnly: true });
        const finalApplied = finalDb.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        const finalRows = snapshot(finalDb);
        finalDb.close();
        assert.deepEqual(finalApplied, applied);
        assert.deepEqual(finalRows, before);
    });
});
