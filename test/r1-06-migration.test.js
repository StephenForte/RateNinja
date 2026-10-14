'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r106-mig-'));
const migration = require('../lib/migrations/004-login-uniqueness');
const PRIOR = ['001-roles.js', '002-password-lifecycle.js', '003-saved-preferences.js', '005-customer-authorization.js', '006-data-operations.js'];

function boot(dbPath, migrationsDir) {
    const env = { ...process.env, NODE_ENV: 'test', SQLITE_DB_PATH: dbPath };
    delete env.MIGRATIONS_DIR;
    if (migrationsDir) env.MIGRATIONS_DIR = migrationsDir;
    const result = spawnSync(process.execPath, ['-e', `
        const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const { ensureFoundation } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'foundation.js'))});
        ensureFoundation();
        const ids = db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'users_lower_username_key'").get();
        process.stdout.write(JSON.stringify({ ids, index: index ? index.sql : null }));
        db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const lines = result.stdout.trim().split('\n');
    return {
        logs: lines.slice(0, -1).join('\n'),
        payload: JSON.parse(lines[lines.length - 1])
    };
}

describe('r1-06 migration 004', { concurrency: 1 }, () => {
    after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses the pre-assigned id', () => {
        assert.equal(migration.id, '004');
        assert.match(migration.description, /login/i);
    });

    it('logs colliding user ids, creates no index, and still completes startup', () => {
        const dir = fs.mkdtempSync(path.join(root, 'collision-'));
        const partial = fs.mkdtempSync(path.join(root, 'partial-'));
        for (const name of PRIOR) {
            fs.copyFileSync(path.join(repoRoot, 'lib', 'migrations', name), path.join(partial, name));
        }
        const dbPath = path.join(dir, 'populated.db');
        const first = boot(dbPath, partial);
        assert.deepEqual(first.payload.ids.map(row => row.id), ['001', '002', '003', '005', '006']);
        assert.equal(first.payload.index, null);

        const seeded = new DatabaseSync(dbPath);
        seeded.prepare(`
            INSERT INTO users (id, username, display_name, admin_screen, disabled, session_epoch, company_role, is_system_admin)
            VALUES ('collision-1', 'CaseUser', 'One', 0, 0, 0, 'member', 0),
                   ('collision-2', 'caseuser', 'Two', 0, 0, 0, 'member', 0)
        `).run();
        seeded.close();

        const second = boot(dbPath);
        assert.match(second.logs, /004-login-uniqueness colliding-user-ids/);
        assert.match(second.logs, /\bcollision-1\b/);
        assert.match(second.logs, /\bcollision-2\b/);
        assert.equal(second.logs.includes('CaseUser'), false);
        assert.equal(second.logs.includes('caseuser'), false);
        assert.equal(second.payload.index, null);
        assert.deepEqual(second.payload.ids.map(row => row.id), ['001', '002', '003', '004', '005', '006']);
        const appliedAt = second.payload.ids.find(row => row.id === '004').applied_at;

        const third = boot(dbPath);
        assert.equal(third.logs.includes('colliding-user-ids'), false);
        assert.equal(third.payload.index, null);
        assert.equal(third.payload.ids.find(row => row.id === '004').applied_at, appliedAt);
        const live = new DatabaseSync(dbPath, { readOnly: true });
        try {
            assert.equal(live.prepare(`SELECT COUNT(*) AS count FROM users WHERE lower(username) = 'caseuser'`).get().count, 2);
        } finally {
            live.close();
        }
    });

    it('creates the index on a clean database and rejects a case-only duplicate', () => {
        const dir = fs.mkdtempSync(path.join(root, 'clean-'));
        const dbPath = path.join(dir, 'clean.db');
        const first = boot(dbPath);
        assert.equal(first.logs.includes('colliding-user-ids'), false);
        assert.match(first.payload.index, /lower\(username\)/i);
        assert.ok(first.payload.ids.some(row => row.id === '004'));
        const appliedAt = first.payload.ids.find(row => row.id === '004').applied_at;

        const live = new DatabaseSync(dbPath);
        try {
            assert.equal(live.prepare(`SELECT username FROM users WHERE lower(username) = 'stevef'`).get().username, 'SteveF');
            assert.throws(
                () => live.prepare(`
                    INSERT INTO users (id, username, display_name, disabled, session_epoch)
                    VALUES ('dup-stevef', 'stevef', 'Duplicate', 0, 0)
                `).run(),
                /UNIQUE/i
            );
            assert.equal(live.prepare(`SELECT COUNT(*) AS count FROM users WHERE lower(username) = 'stevef'`).get().count, 1);
        } finally {
            live.close();
        }

        const second = boot(dbPath);
        assert.equal(second.logs.includes('colliding-user-ids'), false);
        assert.equal(second.payload.ids.find(row => row.id === '004').applied_at, appliedAt);
        assert.match(second.payload.index, /lower\(username\)/i);
    });
});
