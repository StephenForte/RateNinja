const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-old-db-'));
const dbFile = path.join(tmpDir, 'legacy.db');
process.env.SQLITE_DB_PATH = dbFile;
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';

const legacy = new DatabaseSync(dbFile);
legacy.exec(`
    CREATE TABLE rates (
        id TEXT PRIMARY KEY,
        rate_type TEXT,
        origin_port TEXT,
        destination_port TEXT,
        inland_delivery_location TEXT,
        commodity_type TEXT,
        carrier TEXT,
        contract_owner TEXT,
        rate_20d REAL,
        rate_40d REAL,
        rate_40hc REAL,
        rate_effective_date TEXT,
        rate_expiration_date TEXT,
        notes_1 TEXT,
        rate_view TEXT
    );
    CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        pwd TEXT,
        display_name TEXT,
        rate_view TEXT,
        company_id TEXT,
        company_reference TEXT,
        admin_screen INTEGER
    );
    CREATE TABLE companies (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        company_name TEXT,
        company_type TEXT,
        rate_view TEXT,
        admin INTEGER,
        margin_percent REAL,
        margin_number REAL
    );
    CREATE TABLE sailings (
        id TEXT PRIMARY KEY,
        departure TEXT,
        arrival TEXT,
        transit_time TEXT,
        vessel TEXT,
        voyage TEXT,
        service TEXT,
        carrier TEXT,
        departure_port TEXT
    );
`);
legacy.prepare(`
    INSERT INTO rates (id, carrier, origin_port, destination_port, rate_20d, rate_view)
    VALUES ('keep-me', 'MSC', 'SHA', 'LAX', 1500, 'kings')
`).run();
legacy.prepare(`
    INSERT INTO users (id, username, pwd, display_name) VALUES ('legacy-user', 'Legacy', 'old-secret', 'Legacy')
`).run();
legacy.prepare(`
    INSERT INTO companies (id, company_id, company_name, company_type, margin_percent)
    VALUES ('kings-live', 'kings-live', 'Kings Group', 'Contract Owner', 0.1)
`).run();
legacy.close();

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { getRatesByOwner } = require('../lib/store');
const { ensureFoundation } = require('../lib/foundation');

describe('existing sqlite file migration', () => {
    after(() => {
        try {
            db.close();
        } catch {
            // Temporary database.
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('adds missing columns and tables without deleting rows', () => {
        const rateColumns = db.prepare('PRAGMA table_info(rates)').all().map(column => column.name);
        const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
        assert.ok(rateColumns.includes('owner_company_id'));
        assert.ok(userColumns.includes('password_hash'));
        assert.ok(userColumns.includes('company_record_id'));
        assert.ok(userColumns.includes('email'));
        assert.ok(userColumns.includes('totp_enabled'));

        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name);
        for (const name of [
            'company_types',
            'company_margins',
            'oauth_clients',
            'oauth_grants',
            'oauth_refresh_tokens',
            'audit_events',
            'password_reset_tokens',
            'mfa_recovery_codes',
            'login_challenges'
        ]) {
            assert.ok(tables.includes(name), name);
        }

        const kept = db.prepare('SELECT id, carrier, rate_20d, owner_company_id FROM rates WHERE id = ?').get('keep-me');
        assert.equal(kept.carrier, 'MSC');
        assert.equal(kept.rate_20d, 1500);
        assert.equal(kept.owner_company_id, null);
        const legacyUser = db.prepare('SELECT username, pwd FROM users WHERE id = ?').get('legacy-user');
        assert.equal(legacyUser.username, 'Legacy');
        assert.equal(legacyUser.pwd, 'old-secret');
        assert.deepEqual(getRatesByOwner('nobody'), []);

        ensureFoundation();
        assert.equal(db.prepare('SELECT id FROM rates WHERE id = ?').get('keep-me').id, 'keep-me');
        assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get('legacy-user').id, 'legacy-user');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rates').get().count >= 1, true);
    });
});
