'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { insertCompany, insertUser, insertRate, insertMargin, COMPANY_TYPE_CUSTOMER, COMPANY_TYPE_CONTRACT_OWNER } = require('./helpers/r1-19');

it('R1-31 migration 012 preserves seeded 011 rows, enforces a unique hash, and is idempotent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r131-migration-'));
    const earlier = path.join(directory, 'earlier');
    fs.mkdirSync(earlier);
    const dbPath = path.join(directory, 'app.db');
    const migrations = path.resolve(__dirname, '../lib/migrations');
    for (const name of fs.readdirSync(migrations).filter(name => /^\d.*\.js$/.test(name) && name < '012')) {
        fs.copyFileSync(path.join(migrations, name), path.join(earlier, name));
    }
    function boot(dir) {
        const env = { ...process.env, SQLITE_DB_PATH: dbPath, MIGRATIONS_DIR: dir };
        const result = spawnSync(process.execPath, ['-e', "require('./lib/db').db.close()"], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    let db;
    try {
        boot(earlier);
        db = new DatabaseSync(dbPath);
        assert.equal(db.prepare('SELECT MAX(id) AS id FROM schema_migrations').get().id, '011');
        insertCompany(db, { id: 'owner', name: 'Synthetic Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'buyer', name: 'Synthetic Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertUser(db, { id: 'buyer-user', username: 'synthetic', companyId: 'buyer' });
        insertRate(db, { id: 'rate', owner: 'owner' });
        insertMargin(db, { id: 'margin', owner: 'owner', customer: 'buyer', percent: 0.1 });
        db.prepare("INSERT INTO sailings (id, owner_company_id, carrier, departure_port) VALUES ('sailing', 'owner', 'MSC', 'SHA')").run();
        const tables = ['users', 'companies', 'company_margins', 'rates', 'sailings'];
        const snapshot = () => tables.map(table => {
            const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
            if (table === 'rates') {
                for (const row of rows) delete row.max_slots_allowed;
            }
            return JSON.stringify(rows);
        });
        const before = snapshot();
        db.close(); db = null;
        boot(migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(snapshot(), before);
        assert.deepEqual(db.prepare("SELECT id FROM schema_migrations WHERE id >= '012' ORDER BY id").all().map(row => row.id), ['012', '013', '014', '015', '016', '017', '018', '019', '020', '021']);
        assert.deepEqual(db.prepare('PRAGMA table_info(buyer_api_keys)').all().map(c => c.name),
            ['id', 'user_id', 'label', 'key_prefix', 'key_hash', 'created_at', 'last_used_at', 'revoked_at']);
        const unique = db.prepare('PRAGMA index_list(buyer_api_keys)').all().find(i => i.name === 'buyer_api_keys_hash_unique');
        assert.equal(unique.unique, 1);
        const insert = db.prepare('INSERT INTO buyer_api_keys (id,user_id,label,key_prefix,key_hash,created_at) VALUES (?,?,?,?,?,?)');
        insert.run('key-1', 'buyer-user', 'Synthetic', 'prefix', 'hash', '2026-11-17');
        assert.throws(() => insert.run('key-2', 'buyer-user', 'Synthetic', 'prefix', 'hash', '2026-11-17'), /UNIQUE/);
        const backup = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-012.db'));
        assert.equal(backup.length, 1);
        db.close(); db = null;
        boot(migrations);
        db = new DatabaseSync(dbPath);
        assert.deepEqual(snapshot(), before);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM buyer_api_keys').get().n, 1);
    } finally {
        if (db) db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
