'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { it } = require('node:test');
const migration = require('../lib/migrations/016-managed-agent-runs');
const { insertCompany, insertUser, insertRate } = require('./helpers/r1-19');
const { COMPANY_TYPE_CUSTOMER, COMPANY_TYPE_CONTRACT_OWNER } = require('../lib/constants');

const root = path.resolve(__dirname, '..');

function boot(dbPath, migrationsDir) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        MIGRATIONS_DIR: migrationsDir,
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env,
        stdio: 'pipe'
    });
}

function snapshot(db) {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
        .flatMap(({ name }) => {
            if (name === 'managed_agent_runs') return [];
            const filter = name === 'schema_migrations' ? " WHERE id NOT IN ('016', '017')" : '';
            const table = '"' + name.replaceAll('"', '""') + '"';
            const rows = db.prepare(`SELECT * FROM ${table}${filter}`).all();
            if (name === 'rates') {
                for (const row of rows) delete row.max_slots_allowed;
            }
            return [[name, rows]];
        }));
}

it('applies migration 016 to a populated database and does nothing on a re-run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r145-migration-'));
    const dbPath = path.join(directory, 'app.db');
    const prior = path.join(directory, 'prior');
    let db;
    try {
        fs.copyFileSync(path.join(root, 'lib/limits.js'), path.join(directory, 'limits.js'));
        fs.mkdirSync(prior);
        for (const name of fs.readdirSync(path.join(root, 'lib/migrations'))) {
            if (/^\d{3}-.+\.js$/.test(name) && name < '016') {
                fs.copyFileSync(path.join(root, 'lib/migrations', name), path.join(prior, name));
            }
        }
        boot(dbPath, prior);
        db = new DatabaseSync(dbPath);
        insertCompany(db, { id: 'owner', name: 'Synthetic Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'buyer', name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(db, { id: 'buyer-user', username: 'synthetic', companyId: 'buyer' });
        insertRate(db, { id: 'rate-1', owner: 'owner' });
        db.prepare(`
            INSERT INTO managed_agents (
                id, batch_id, company_id, created_by_user_id, rate_type, origin_port, destination_port,
                sailing_date, container_type, allow_alternative_routes, allow_booking_request,
                created_at, updated_at
            ) VALUES ('agent-1', 'batch', 'buyer', 'buyer-user', 'FAK', 'SHA', 'LAX', '2026-12-01', '20D', 0, 0,
                '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')
        `).run();
        const before = snapshot(db);
        assert.equal(before.managed_agent_runs, undefined);
        db.close();
        db = null;

        boot(dbPath, path.join(root, 'lib/migrations'));
        db = new DatabaseSync(dbPath);
        assert.deepEqual(snapshot(db), before);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '016'").get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_agent_runs').get().n, 0);
        const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'managed_agent_runs_one_running'").get();
        assert.match(index.sql, /WHERE status = 'running'/);
        db.prepare(`
            INSERT INTO managed_agent_runs (
                id, started_by_user_id, started_at, status, started_agent_ids, summary
            ) VALUES ('run-1', 'buyer-user', '2026-11-20T02:00:00.000Z', 'succeeded', '["agent-1"]', 'kept')
        `).run();
        const applied = db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '016'").get();
        const backups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-016.db'));
        assert.equal(backups.length, 1);
        const kept = db.prepare('SELECT * FROM managed_agent_runs').all();
        migration.up(db);
        assert.deepEqual(db.prepare('SELECT * FROM managed_agent_runs').all(), kept);
        db.close();
        db = null;

        boot(dbPath, path.join(root, 'lib/migrations'));
        db = new DatabaseSync(dbPath);
        assert.deepEqual(db.prepare('SELECT * FROM managed_agent_runs').all(), kept);
        assert.deepEqual(db.prepare("SELECT applied_at FROM schema_migrations WHERE id = '016'").get(), applied);
        assert.deepEqual(
            fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-016.db')),
            backups
        );
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_agents').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rates').get().n, 1);
    } finally {
        db?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
