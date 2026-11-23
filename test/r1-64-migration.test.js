'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function environment(dbPath, migrationsDir = migrations) {
    return { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: migrationsDir,
        SESSION_SECRET: 'r164-synthetic-session-secret-required-for-boot',
        OAUTH_SIGNING_SECRET: 'r164-synthetic-signing-secret-required-for-boot',
        FORTEL2_RECEIPT_PRIVATE_KEY: '', PORT: '0', HOST: '127.0.0.1' };
}

function boot(dbPath, migrationsDir) {
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], { cwd: root,
        env: environment(dbPath, migrationsDir), stdio: 'pipe' });
}

const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

it('migrates populated 020 data and backs it up, then recovers only running rows on server boot', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r164-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const prior = path.join(directory, 'migrations');
    let db;
    t.after(() => {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.mkdirSync(prior);
    fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
    for (const name of fs.readdirSync(migrations).filter(name => /^\d{3}-.+\.js$/.test(name) && name < '021')) {
        fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
    }
    boot(dbPath, prior);
    db = new DatabaseSync(dbPath);
    const migration = () => db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
    assert.equal(migration().id, '020');
    const insertSwarm = db.prepare(`
        INSERT INTO swarms (id, company_id, created_by_user_id, name, instructions, created_at, updated_at)
        VALUES (?, 'synthetic-company', 'synthetic-user', 'Synthetic swarm', '', 't', 't')
    `);
    const insertLane = db.prepare(`
        INSERT INTO swarm_lanes (id, swarm_id, position, rate_type, origin_port, destination_port,
            sailing_date, container_type, allow_alternative_routes, allow_booking_request)
        VALUES (?, ?, ?, 'Port to Port', 'SHA', 'LAX', '2026-12-01', '20D', 0, 0)
    `);
    for (let i = 1; i <= 2; i += 1) {
        insertSwarm.run(`synthetic-swarm-${i}`);
        for (let j = 1; j <= 25; j += 1) insertLane.run(`synthetic-lane-${i}-${j}`, `synthetic-swarm-${i}`, j);
    }
    function hashes(connection = db) {
        return ['swarms', 'swarm_lanes'].map(table => hash(connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
    }
    const before = hashes();
    db.close();
    db = null;
    boot(dbPath);
    db = new DatabaseSync(dbPath);
    assert.deepEqual(hashes(), before);
    const applied = migration();
    assert.equal(applied.id, '021');
    const backups = () => fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-021.db'));
    const firstBackups = backups();
    assert.equal(firstBackups.length, 1);
    const backup = new DatabaseSync(path.join(directory, 'backups', firstBackups[0]), { readOnly: true });
    try {
        assert.deepEqual(hashes(backup), before);
        assert.equal(backup.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id = '021'").get().n, 0);
    } finally {
        backup.close();
    }

    db.prepare(`
        INSERT INTO swarm_runs (id, swarm_id, company_id, started_by_user_id, status, snapshot, started_at)
        VALUES ('active', 'synthetic-swarm-1', 'synthetic-company', 'synthetic-user', 'running', '{}', 't'),
            ('completed', 'synthetic-swarm-1', 'synthetic-company', 'synthetic-user', 'completed', '{}', 't')
    `).run();
    db.prepare(`
        INSERT INTO swarm_run_agents (id, run_id, role, attempt, status, started_at, report)
        VALUES ('active-agent', 'active', 'master', 1, 'running', 't', NULL),
            ('completed-agent', 'completed', 'master', 1, 'completed', 't', 'existing report')
    `).run();
    const existingRun = db.prepare("SELECT * FROM swarm_runs WHERE id = 'completed'").get();
    const existingAgent = db.prepare("SELECT * FROM swarm_run_agents WHERE id = 'completed-agent'").get();
    db.close();
    db = null;

    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: environment(dbPath), stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const listening = AbortSignal.timeout(5000);
    async function waitForBoot() {
        for await (const chunk of child.stdout) {
            if (String(chunk).includes('Rate Ninja is running')) return true;
        }
        return false;
    }
    try {
        const ready = await Promise.race([
            waitForBoot(), exited.then(() => false),
            new Promise(resolve => listening.addEventListener('abort', () => resolve(false), { once: true }))
        ]);
        assert.equal(ready, true, stderr);
    } finally {
        child.kill();
        await exited;
    }
    db = new DatabaseSync(dbPath);
    assert.deepEqual(migration(), applied);
    assert.deepEqual(hashes(), before);
    assert.deepEqual(backups(), firstBackups);
    const recovered = db.prepare("SELECT * FROM swarm_runs WHERE id = 'active'").get();
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.failure_reason, 'process_restart');
    assert.ok(recovered.finished_at);
    assert.equal(db.prepare("SELECT status FROM swarm_run_agents WHERE id = 'active-agent'").get().status, 'failed');
    assert.deepEqual(db.prepare("SELECT * FROM swarm_runs WHERE id = 'completed'").get(), existingRun);
    assert.deepEqual(db.prepare("SELECT * FROM swarm_run_agents WHERE id = 'completed-agent'").get(), existingAgent);
});
