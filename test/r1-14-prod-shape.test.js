'use strict';

// Reproductions for the production-shaped startup drill. These assert the
// behavior the release requires. They are expected to fail until the defects
// are fixed, and they are marked todo so a failing assertion does not fail CI.
// The database is a synthetic temp file. Do not point this at data/rateninja.db
// or at a backup under data/backups.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r114-'));
const dbPath = path.join(directory, 'app.db');
const LEGACY_PASSWORD = 'legacy-plain-secret';

function seed() {
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE companies (
            id TEXT PRIMARY KEY,
            company_id TEXT,
            company_name TEXT,
            company_type TEXT,
            company_type_id TEXT,
            rate_view TEXT,
            admin INTEGER,
            margin_percent REAL,
            margin_number REAL
        );
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT,
            pwd TEXT,
            display_name TEXT,
            rate_view TEXT,
            company_id TEXT,
            company_reference TEXT,
            admin_screen INTEGER,
            password_hash TEXT,
            password_hash_version TEXT,
            disabled INTEGER NOT NULL DEFAULT 0,
            session_epoch INTEGER NOT NULL DEFAULT 0,
            company_record_id TEXT
        );
        CREATE TABLE rates (
            id TEXT PRIMARY KEY,
            carrier TEXT,
            origin_port TEXT,
            destination_port TEXT,
            rate_20d REAL,
            rate_effective_date TEXT,
            rate_expiration_date TEXT,
            rate_view TEXT,
            owner_company_id TEXT
        );
        CREATE TABLE sailings (
            id TEXT PRIMARY KEY,
            carrier TEXT,
            departure_port TEXT,
            departure TEXT,
            owner_company_id TEXT
        );
        CREATE TABLE company_margins (
            id TEXT PRIMARY KEY,
            owner_company_id TEXT NOT NULL,
            customer_company_id TEXT NOT NULL,
            margin_percent REAL NOT NULL DEFAULT 0,
            margin_number REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE company_types (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );
    `);
    db.prepare(`
        INSERT INTO companies (
            id, company_id, company_name, company_type, company_type_id, rate_view, admin, margin_percent, margin_number
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run('kings', 'kings', 'Kings', 'rec-unmapped-owner', 'kings', 1, 0.01, 0);
    db.prepare(`
        INSERT INTO companies (
            id, company_id, company_name, company_type, company_type_id, rate_view, admin, margin_percent, margin_number
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run('blackwater', 'blackwater', 'Blackwater Shippers', 'rec-unmapped-customer', 'blackwater', 0, 25, 42);
    const insertUser = db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen,
            password_hash, disabled, session_epoch, company_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?)
    `);
    insertUser.run('user-stevef', 'stevef', LEGACY_PASSWORD, 'SteveF', 'kings', 'kings', 'kings', 1, 'kings');
    insertUser.run('user-ops', 'opslead', LEGACY_PASSWORD, 'Ops Lead', 'blackwater', 'blackwater', 'blackwater', 0, 'blackwater');
    db.prepare(`
        INSERT INTO rates (
            id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, rate_expiration_date, rate_view, owner_company_id
        ) VALUES ('rate-1', 'Fixture Line', 'Fixture Harbor', 'North Quay', 1000, '2026-01-01', '2026-02-01', 'kings', NULL)
    `).run();
    db.prepare(`
        INSERT INTO sailings (id, carrier, departure_port, departure, owner_company_id)
        VALUES ('sail-1', 'Fixture Line', 'Fixture Harbor', '2026-03-01T00:00:00.000Z', NULL)
    `).run();
    db.close();
}

function boot() {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    delete env.MIGRATIONS_DIR;
    const result = spawnSync(process.execPath, ['-e', `
        const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'db.js'))});
        const { ensureFoundation } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'foundation.js'))});
        const { verifyPassword } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'passwords.js'))});
        ensureFoundation();
        const companies = db.prepare('SELECT id, company_name, company_type, company_type_id FROM companies ORDER BY company_name').all();
        const margins = db.prepare('SELECT customer_company_id, margin_percent, margin_number, status FROM company_margins ORDER BY customer_company_id').all();
        const users = db.prepare('SELECT username, pwd IS NOT NULL AS has_pwd, password_hash FROM users ORDER BY username').all();
        const rate = db.prepare('SELECT owner_company_id FROM rates WHERE id = ?').get('rate-1');
        const sailing = db.prepare('SELECT owner_company_id FROM sailings WHERE id = ?').get('sail-1');
        const steve = users.find(user => user.username.toLowerCase() === 'stevef');
        const payload = {
            companies,
            margins,
            usernames: users.map(user => user.username),
            userCount: users.length,
            rateOwner: rate && rate.owner_company_id,
            sailingOwner: sailing && sailing.owner_company_id,
            steveHasPwd: Boolean(steve && steve.has_pwd),
            steveHashVerifies: Boolean(steve && steve.password_hash && verifyPassword(steve.password_hash, ${JSON.stringify(LEGACY_PASSWORD)}))
        };
        process.stdout.write(JSON.stringify(payload));
        db.close();
    `], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const line = result.stdout.trim().split('\n').pop();
    return JSON.parse(line);
}

seed();
const started = boot();

describe('production-shaped startup', () => {
    after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('normalizes unmapped company types, copies legacy margins, and assigns rate ownership', { todo: 'R114-1' }, () => {
        const kings = started.companies.find(company => company.id === 'kings');
        const blackwater = started.companies.find(company => company.id === 'blackwater');
        const blackwaterMargin = started.margins.find(row => row.customer_company_id === 'blackwater');
        const problems = [];
        if (!kings || (kings.company_type !== 'Contract Owner' && kings.company_type_id !== 'contract_owner')) {
            problems.push(`kings type stayed ${kings && kings.company_type}`);
        }
        if (!blackwater || (blackwater.company_type !== 'Freight Forwarder/Customer' && blackwater.company_type_id !== 'freight_forwarder_customer')) {
            problems.push(`blackwater type stayed ${blackwater && blackwater.company_type}`);
        }
        if (!blackwaterMargin || blackwaterMargin.margin_percent !== 25 || blackwaterMargin.margin_number !== 42 || blackwaterMargin.status !== 'active') {
            problems.push(`blackwater margin ${JSON.stringify(blackwaterMargin || null)}`);
        }
        if (started.rateOwner !== 'kings') problems.push(`rate owner ${started.rateOwner}`);
        assert.deepEqual(problems, []);
    });

    it('does not add foundation users when the existing accounts use other login names', { todo: 'R114-2' }, () => {
        assert.deepEqual(started.usernames, ['opslead', 'stevef']);
    });

    it('keeps a usable credential when a user has only a legacy pwd', { todo: 'R114-3' }, () => {
        assert.equal(started.steveHasPwd || started.steveHashVerifies, true);
    });
});
