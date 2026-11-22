'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function boot(dbPath, migrationsDir) {
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            SQLITE_DB_PATH: dbPath,
            MIGRATIONS_DIR: migrationsDir,
            SESSION_SECRET: 'test-session-secret-value-which-is-long',
            OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
        },
        stdio: 'pipe'
    });
}

function digest(db, table) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    return {
        count: rows.length,
        hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        columns: db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)
    };
}

it('applies 020 to a populated 019 database, keeps managed agents, and is a no-op on the next boot', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r162-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const prior = path.join(directory, 'migrations');
    let db;
    try {
        fs.mkdirSync(prior);
        fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
        for (const name of fs.readdirSync(migrations)) {
            if (/^\d{3}-.+\.js$/.test(name) && name < '020') {
                fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
            }
        }
        boot(dbPath, prior);
        db = new DatabaseSync(dbPath);
        assert.equal(db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get().id, '019');
        const insertCompany = db.prepare(`
            INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
            VALUES (?, ?, ?, 'Freight Forwarder/Customer', 'freight_forwarder_customer', 0)
        `);
        for (let i = 0; i < 4; i += 1) insertCompany.run(`synthetic-co-${i}`, `synthetic-co-${i}`, `Synthetic Co ${i}`);
        const insertAgent = db.prepare(`
            INSERT INTO managed_agents (
                id, batch_id, company_id, created_by_user_id, status, rate_type, origin_port, destination_port,
                sailing_date, container_type, allow_alternative_routes, allow_booking_request, created_at, updated_at
            ) VALUES (?, 'synthetic-batch', 'synthetic-co-0', 'synthetic-user', 'queued', 'Port to Port', 'SHA', 'LAX',
                '2026-12-01', '20D', 0, 0, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z')
        `);
        for (let i = 0; i < 200; i += 1) insertAgent.run(`synthetic-agent-${i}`);
        const beforeAgents = digest(db, 'managed_agents');
        const beforeCompanies = digest(db, 'companies');
        assert.equal(beforeAgents.count, 200);
        assert.equal(beforeCompanies.count >= 4, true);
        db.close();
        db = undefined;

        boot(dbPath, migrations);
        db = new DatabaseSync(dbPath);
        const applied = db.prepare("SELECT id, applied_at FROM schema_migrations WHERE id = '020'").get();
        assert.ok(applied);
        const backups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-020.db'));
        assert.equal(backups.length, 1);
        assert.match(backups[0], /^rateninja-\d{8}T\d{9}Z-pre-020\.db$/);
        const afterAgents = digest(db, 'managed_agents');
        const afterCompanies = digest(db, 'companies');
        assert.deepEqual(afterAgents, beforeAgents);
        assert.deepEqual(afterCompanies, beforeCompanies);
        assert.deepEqual(
            db.prepare('PRAGMA index_info(swarms_company_created)').all().map(column => column.name),
            ['company_id', 'created_at']
        );
        db.close();
        db = undefined;

        boot(dbPath, migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(db.prepare("SELECT id, applied_at FROM schema_migrations WHERE id = '020'").get(), applied);
        assert.deepEqual(digest(db, 'managed_agents'), beforeAgents);
        assert.deepEqual(
            fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-020.db')),
            backups
        );
        db.exec('PRAGMA foreign_keys = ON');
        db.prepare(`
            INSERT INTO swarms (id, company_id, created_by_user_id, name, instructions, created_at, updated_at)
            VALUES ('synthetic-swarm', 'synthetic-co-0', 'synthetic-user', 'Name', '', 't', 't')
        `).run();
        db.prepare(`
            INSERT INTO swarm_lanes (
                id, swarm_id, position, rate_type, origin_port, destination_port, sailing_date,
                container_type, allow_alternative_routes, allow_booking_request
            ) VALUES ('synthetic-lane', 'synthetic-swarm', 1, 'Port to Port', 'SHA', 'LAX', '2026-12-01', '20D', 0, 0)
        `).run();
        db.prepare("DELETE FROM swarms WHERE id = 'synthetic-swarm'").run();
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM swarm_lanes WHERE id = 'synthetic-lane'").get().n, 0);
        assert.throws(() => db.prepare(`
            INSERT INTO company_swarm_settings (company_id, enabled, updated_at, updated_by_user_id)
            VALUES ('synthetic-co-1', 2, 't', 'synthetic-user')
        `).run(), /CHECK/);
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
