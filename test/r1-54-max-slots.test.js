'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it } = require('node:test');
const migration = require('../lib/migrations/017-rate-max-slots');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function boot(dbPath, migrationsDir) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        MIGRATIONS_DIR: migrationsDir,
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    const result = spawnSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function priorMigrations(directory) {
    const prior = path.join(directory, 'prior');
    fs.mkdirSync(prior);
    fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
    for (const name of fs.readdirSync(migrations)) {
        if (/^\d{3}-.+\.js$/.test(name) && name < '017') {
            fs.copyFileSync(path.join(migrations, name), path.join(prior, name));
        }
    }
    return prior;
}

// 018 rewrites the CHECK and the insert trigger. These tests still boot a
// database whose newest migration is 017, so they keep asserting 017 itself.
function migrationsThrough017(directory) {
    const dest = path.join(directory, 'through-017');
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(migrations)) {
        if (/^\d{3}-.+\.js$/.test(name) && name < '018') {
            fs.copyFileSync(path.join(migrations, name), path.join(dest, name));
        }
    }
    return dest;
}

function rateBodies(db) {
    const columns = db.prepare('PRAGMA table_info(rates)').all()
        .map(column => column.name)
        .filter(name => name !== 'max_slots_allowed');
    const list = columns.map(name => `"${name}"`).join(', ');
    return db.prepare(`SELECT ${list} FROM rates ORDER BY id`).all();
}

function triggerRows(db) {
    return db.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'trg_rates_max_slots_default'
    `).all();
}

function slotValues(db) {
    return db.prepare('SELECT max_slots_allowed AS value FROM rates').all().map(row => row.value);
}

function assertSlotsInRange(values) {
    assert.ok(values.length > 0);
    for (const value of values) {
        assert.equal(typeof value, 'number');
        assert.ok(Number.isInteger(value));
        assert.ok(value >= 1 && value <= 5, String(value));
    }
}

describe('r1-54 max slots allowed', { concurrency: 1 }, () => {
    it('backfills a populated 016 database, keeps a preset on re-run, and idles on the next boot', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r154-populated-'));
        const dbPath = path.join(directory, 'app.db');
        let db;
        try {
            boot(dbPath, priorMigrations(directory));
            db = new DatabaseSync(dbPath);
            db.prepare(`
                INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
                VALUES ('owner-a', 'owner-a', 'Owner A', 'Contract Owner', 'contract_owner', 1)
            `).run();
            db.prepare(`
                INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
                VALUES ('owner-b', 'owner-b', 'Owner B', 'Contract Owner', 'contract_owner', 1)
            `).run();
            const insert = db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_20d, rate_40d, rate_40hc,
                    rate_effective_date, owner_company_id, row_version
                ) VALUES (?, 'MSC', 'SHA', 'LAX', ?, ?, ?, '2026-03-01', ?, ?)
            `);
            for (let index = 0; index < 210; index += 1) {
                const id = `r${String(index).padStart(4, '0')}`;
                const nullPrice = index >= 200;
                insert.run(
                    id,
                    nullPrice ? null : 1000 + index,
                    nullPrice ? null : 1800,
                    nullPrice ? null : 1900,
                    index % 2 === 0 ? 'owner-a' : 'owner-b',
                    index === 8 ? 7 : 1
                );
            }
            db.prepare(`UPDATE rates SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE id < 'r0008'`).run();
            db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id, row_version
                ) VALUES ('pf-source', 'PF Line', 'SHA', 'LAX', 1400, '2026-11-01', 'owner-a', 1)
            `).run();
            const before = rateBodies(db);
            assert.equal(before.length, 211);
            assert.equal(db.prepare(`SELECT name FROM pragma_table_info('rates') WHERE name = 'max_slots_allowed'`).get(), undefined);
            db.close();
            db = null;

            const through017 = migrationsThrough017(directory);
            boot(dbPath, through017);
            db = new DatabaseSync(dbPath);
            assert.deepEqual(rateBodies(db), before);
            const filled = slotValues(db);
            assert.equal(filled.length, 211);
            assertSlotsInRange(filled);
            assert.equal(filled.includes(null), false);
            // One random() call, or a scalar subquery, would give every row the same
            // number. All five values on 211 rows is the per-row check.
            assert.deepEqual([...new Set(filled)].sort(), [1, 2, 3, 4, 5]);
            assert.equal(db.prepare(`SELECT row_version FROM rates WHERE id = 'r0008'`).get().row_version, 7);
            assert.equal(db.prepare(`SELECT deleted_at FROM rates WHERE id = 'r0000'`).get().deleted_at, '2026-01-02T00:00:00.000Z');
            assert.equal(db.prepare(`SELECT rate_20d FROM rates WHERE id = 'r0200'`).get().rate_20d, null);
            const column = db.prepare(`PRAGMA table_info(rates)`).all().find(item => item.name === 'max_slots_allowed');
            assert.equal(column.notnull, 0);
            assert.equal(column.dflt_value, null);
            const tableSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rates'`).get().sql;
            assert.match(tableSql, /max_slots_allowed INTEGER CHECK \(max_slots_allowed IS NULL OR max_slots_allowed >= 1\)/);
            assert.equal(/max_slots_allowed[^,\n]*DEFAULT/i.test(tableSql), false);
            const triggers = triggerRows(db);
            assert.equal(triggers.length, 1);
            assert.match(triggers[0].sql, /WHEN NEW\.max_slots_allowed IS NULL/);
            assert.match(triggers[0].sql, /SET max_slots_allowed = \(abs\(random\(\)\) % 5\) \+ 1/);
            assert.match(triggers[0].sql, /WHERE id = NEW\.id/);
            assert.equal(/row_version/.test(triggers[0].sql), false);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '017'`).get().n, 1);
            const applied = db.prepare(`SELECT applied_at FROM schema_migrations WHERE id = '017'`).get();
            const backups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-017.db'));
            assert.equal(backups.length, 1);

            const keptId = 'r0010';
            const keptValue = db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = ?`).get(keptId).max_slots_allowed;
            const untouched = db.prepare(`
                SELECT id, max_slots_allowed FROM rates
                WHERE id NOT IN ('r0010', 'r0011')
                ORDER BY id
            `).all();
            db.prepare(`UPDATE rates SET max_slots_allowed = NULL WHERE id = 'r0011'`).run();
            const bodiesBeforeRerun = rateBodies(db);
            migration.up(db);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = ?`).get(keptId).max_slots_allowed, keptValue);
            const refilled = db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'r0011'`).get().max_slots_allowed;
            assert.ok(refilled >= 1 && refilled <= 5);
            assert.deepEqual(db.prepare(`
                SELECT id, max_slots_allowed FROM rates
                WHERE id NOT IN ('r0010', 'r0011')
                ORDER BY id
            `).all(), untouched);
            assert.deepEqual(rateBodies(db), bodiesBeforeRerun);
            assert.equal(triggerRows(db).length, 1);
            db.close();
            db = null;

            boot(dbPath, through017);
            db = new DatabaseSync(dbPath);
            assert.deepEqual(rateBodies(db), bodiesBeforeRerun);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = ?`).get(keptId).max_slots_allowed, keptValue);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'r0011'`).get().max_slots_allowed, refilled);
            assert.deepEqual(db.prepare(`SELECT applied_at FROM schema_migrations WHERE id = '017'`).get(), applied);
            assert.deepEqual(
                fs.readdirSync(path.join(directory, 'backups')).filter(name => name.endsWith('-pre-017.db')),
                backups
            );
            assert.equal(triggerRows(db).length, 1);
        } finally {
            db?.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not replace a value already stored when the column is added ahead of the migration', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r154-preset-'));
        const dbPath = path.join(directory, 'app.db');
        let db;
        try {
            boot(dbPath, priorMigrations(directory));
            db = new DatabaseSync(dbPath);
            db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, row_version)
                VALUES ('preset', 'MSC', 'SHA', 'LAX', '2026-03-01', 'owner-a', 4),
                       ('open', 'MSC', 'SHA', 'NYC', '2026-03-01', 'owner-b', 2)
            `).run();
            db.exec(`
                ALTER TABLE rates
                ADD COLUMN max_slots_allowed INTEGER
                CHECK (max_slots_allowed IS NULL OR max_slots_allowed >= 1)
            `);
            db.prepare(`UPDATE rates SET max_slots_allowed = 9 WHERE id = 'preset'`).run();
            const before = rateBodies(db);
            db.close();
            db = null;

            boot(dbPath, migrationsThrough017(directory));
            db = new DatabaseSync(dbPath);
            assert.deepEqual(rateBodies(db), before);
            assert.equal(db.prepare(`SELECT max_slots_allowed, row_version FROM rates WHERE id = 'preset'`).get().max_slots_allowed, 9);
            assert.equal(db.prepare(`SELECT row_version FROM rates WHERE id = 'preset'`).get().row_version, 4);
            const open = db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'open'`).get().max_slots_allowed;
            assert.ok(open >= 1 && open <= 5);
            assert.equal(triggerRows(db).length, 1);
            migration.up(db);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'preset'`).get().max_slots_allowed, 9);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'open'`).get().max_slots_allowed, open);
            assert.equal(triggerRows(db).length, 1);
        } finally {
            db?.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('fills direct inserts, an import, and a pull-forward copy without changing other rows', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r154-writers-'));
        const dbPath = path.join(directory, 'app.db');
        let db;
        try {
            boot(dbPath, priorMigrations(directory));
            db = new DatabaseSync(dbPath);
            db.prepare(`
                INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, admin)
                VALUES ('owner-a', 'owner-a', 'Owner A', 'Contract Owner', 'contract_owner', 1)
            `).run();
            db.prepare(`
                INSERT INTO users (
                    id, username, display_name, company_id, company_reference, company_record_id, admin_screen, disabled, session_epoch
                ) VALUES ('user-a', 'owner-a', 'Owner A', 'owner-a', 'owner-a', 'owner-a', 1, 0, 0)
            `).run();
            db.prepare(`
                INSERT INTO rates (
                    id, carrier, origin_port, destination_port, rate_20d, rate_effective_date, owner_company_id, row_version
                ) VALUES ('existing', 'MSC', 'SHA', 'LAX', 1000, '2026-03-01', 'owner-a', 3),
                         ('pf-source', 'PF Line', 'SHA', 'LAX', 1400, '2026-11-01', 'owner-a', 1)
            `).run();
            db.close();
            db = null;
            const through017 = migrationsThrough017(directory);
            boot(dbPath, through017);
            db = new DatabaseSync(dbPath);
            const existingBefore = db.prepare(`SELECT * FROM rates ORDER BY id`).all();
            const existingSlots = existingBefore.map(row => ({ id: row.id, max_slots_allowed: row.max_slots_allowed }));

            const direct = db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id)
                VALUES (?, 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a')
            `);
            const directValues = [];
            for (let index = 0; index < 60; index += 1) {
                const id = `direct-${index}`;
                direct.run(id);
                directValues.push(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = ?`).get(id).max_slots_allowed);
            }
            assertSlotsInRange(directValues);
            assert.ok(new Set(directValues).size > 1);
            db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed)
                VALUES ('explicit-3', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', 3)
            `).run();
            db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed)
                VALUES ('explicit-9', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', 9)
            `).run();
            assert.equal(db.prepare(`SELECT max_slots_allowed, row_version FROM rates WHERE id = 'explicit-3'`).get().max_slots_allowed, 3);
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'explicit-9'`).get().max_slots_allowed, 9);
            assert.equal(db.prepare(`SELECT row_version FROM rates WHERE id = 'explicit-3'`).get().row_version, 1);
            assert.throws(
                () => db.prepare(`
                    INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed)
                    VALUES ('explicit-0', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', 0)
                `).run(),
                /CHECK constraint failed/
            );
            db.prepare(`
                INSERT INTO rates (id, carrier, origin_port, destination_port, rate_effective_date, owner_company_id, max_slots_allowed)
                VALUES ('cleared', 'Direct', 'SHA', 'LAX', '2026-04-01', 'owner-a', 2)
            `).run();
            db.prepare(`UPDATE rates SET max_slots_allowed = NULL WHERE id = 'cleared'`).run();
            assert.equal(db.prepare(`SELECT max_slots_allowed FROM rates WHERE id = 'cleared'`).get().max_slots_allowed, null);
            assert.deepEqual(
                db.prepare(`SELECT id, max_slots_allowed FROM rates WHERE id IN ('existing', 'pf-source') ORDER BY id`).all().map(row => ({ ...row })),
                existingSlots
            );
            db.close();
            db = null;

            const child = spawnSync(process.execPath, ['-e', `
                const { db } = require('./lib/db');
                const { createUpload, loadJob, commitImport } = require('./lib/imports/jobs');
                const { previewPullForward, commitPullForward } = require('./lib/pull-forward');
                const csv = [
                    'Origin Port,Destination Port/Via Port,Carrier,Effective Date,Expiry Date,20D Rate',
                    'SHA,LAX,Fixture Line,2026-06-01,2026-12-01,1500',
                    'NGB,NYC,Fixture Line,2026-06-02,2026-12-02,1600'
                ].join('\\n');
                const mapping = [
                    ['Origin Port', 'originPort'],
                    ['Destination Port/Via Port', 'destinationPort'],
                    ['Carrier', 'carrier'],
                    ['Effective Date', 'rateEffectiveDate'],
                    ['Expiry Date', 'rateExpirationDate'],
                    ['20D Rate', 'rate20D']
                ].map(([source, target]) => ({ source, target }));
                (async () => {
                    const uploaded = await createUpload({
                        companyId: 'owner-a',
                        actorUserId: 'user-a',
                        dataset: 'rates',
                        filename: 'rates.csv',
                        buffer: Buffer.from(csv)
                    });
                    const job = loadJob(uploaded.jobId, 'owner-a');
                    await commitImport({
                        job,
                        companyId: 'owner-a',
                        companyName: 'Owner A',
                        actorUserId: 'user-a',
                        body: {
                            acknowledgeAppend: true,
                            submissionId: 'r154-import',
                            sheetName: 'CSV',
                            mapping,
                            excludedRows: [],
                            dateOrder: null
                        }
                    });
                    const preview = previewPullForward({
                        dataset: 'rates',
                        companyId: 'owner-a',
                        companyName: 'Owner A',
                        body: {
                            sourceStart: '2026-11-01',
                            sourceEnd: '2026-11-01',
                            targetStart: '2026-12-01',
                            targetEnd: '2026-12-01',
                            priceIncreasePercent: 0,
                            conflict: 'keep',
                            filter: { carrier: 'PF Line', origin: 'SHA', destination: 'LAX' }
                        }
                    });
                    commitPullForward({
                        previewId: preview.previewId,
                        submissionId: 'r154-forward',
                        companyId: 'owner-a',
                        companyName: 'Owner A',
                        actorUserId: 'user-a'
                    });
                    const stored = db.prepare(\`
                        SELECT action, prior_json FROM data_operation_items
                        WHERE action = 'create'
                        ORDER BY record_id
                    \`).all();
                    console.log('R154 ' + JSON.stringify(stored));
                    db.close();
                })().catch(error => {
                    console.error(error && error.stack ? error.stack : error);
                    if (error && error.extra) console.error(JSON.stringify(error.extra));
                    process.exit(1);
                });
            `], {
                cwd: root,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    SQLITE_DB_PATH: dbPath,
                    MIGRATIONS_DIR: through017,
                    SESSION_SECRET: 'test-session-secret-value-which-is-long',
                    OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
                },
                encoding: 'utf8'
            });
            assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
            const line = child.stdout.trim().split('\n').find(item => item.startsWith('R154 '));
            const stored = JSON.parse(line.slice(5));
            db = new DatabaseSync(dbPath);
            assert.equal(stored.length, 3);
            for (const item of stored) {
                const recorded = JSON.parse(item.prior_json);
                const row = db.prepare(`SELECT * FROM rates WHERE id = ?`).get(recorded.id);
                assert.deepEqual(JSON.parse(JSON.stringify(row)), recorded);
                assert.ok(recorded.max_slots_allowed >= 1 && recorded.max_slots_allowed <= 5);
                assert.equal(row.row_version, 1);
            }
            const imported = db.prepare(`SELECT id, max_slots_allowed FROM rates WHERE carrier = 'Fixture Line' ORDER BY id`).all();
            assert.equal(imported.length, 2);
            const copied = db.prepare(`SELECT id, max_slots_allowed, rate_effective_date, carrier FROM rates WHERE carrier = 'PF Line' ORDER BY rate_effective_date`).all();
            assert.deepEqual(copied.map(row => row.rate_effective_date), ['2026-11-01', '2026-12-01']);
            assert.ok(copied[1].max_slots_allowed >= 1 && copied[1].max_slots_allowed <= 5);
            assert.deepEqual(
                db.prepare(`SELECT id, max_slots_allowed FROM rates WHERE id IN ('existing', 'pf-source') ORDER BY id`).all().map(row => ({ ...row })),
                existingSlots
            );
        } finally {
            db?.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps owner and partner rate response keys the same across the migration', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r154-surface-'));
        const dbPath = path.join(directory, 'app.db');
        const script = `
            const { server } = require('./server');
            const { db } = require('./lib/db');
            const { setPasswordByUsername } = require('./lib/accounts');
            const crypto = require('node:crypto');
            const password = 'sail-the-ocean';
            if (!db.prepare('SELECT id FROM companies WHERE id = ?').get('owner-r154')) {
                db.prepare(\`
                    INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
                    VALUES ('owner-r154', 'owner-r154', 'Surface Owner', 'Contract Owner', 'contract_owner', 'owner-r154', 1)
                \`).run();
                db.prepare(\`
                    INSERT INTO users (
                        id, username, display_name, company_id, company_reference, company_record_id,
                        admin_screen, disabled, session_epoch
                    ) VALUES ('user-r154', 'surface-owner', 'Surface Owner', 'owner-r154', 'owner-r154', 'owner-r154', 1, 0, 0)
                \`).run();
                db.prepare(\`
                    INSERT INTO rates (
                        id, carrier, origin_port, destination_port, contract_owner, rate_20d, rate_effective_date, rate_expiration_date, owner_company_id
                    ) VALUES ('surface-rate', 'MSC', 'SHA', 'LAX', 'Surface Owner', 1000, '2026-04-01', '2026-12-01', 'owner-r154')
                \`).run();
                db.prepare(\`
                    INSERT INTO oauth_clients (
                        id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
                    ) VALUES (
                        'client-r154', 'Synthetic', NULL, 'public', '[]', '["rates:read"]', 'active',
                        '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'
                    )
                \`).run();
                db.prepare(\`
                    INSERT INTO oauth_grants (id, client_id, user_id, scopes, consent_version, created_at, revoked_at)
                    VALUES ('grant-r154', 'client-r154', 'user-r154', 'rates:read', '1', ?, NULL)
                \`).run(Date.now());
            }
            const set = setPasswordByUsername('surface-owner', password);
            if (!set.ok) throw new Error(set.error || 'password');
            const epoch = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get('user-r154').session_epoch;
            const issuedAt = Date.now();
            const payload = {
                sub: 'user-r154',
                client_id: 'client-r154',
                scope: 'rates:read',
                aud: 'rn:partner-api',
                exp: issuedAt + 60 * 60 * 1000,
                iat: issuedAt,
                grant_id: 'grant-r154',
                company_record_id: 'owner-r154',
                session_epoch: epoch
            };
            const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
            const signature = crypto.createHmac('sha256', process.env.OAUTH_SIGNING_SECRET).update(body).digest('base64url');
            const token = 'rn1.' + body + '.' + signature;
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const base = 'http://127.0.0.1:' + server.address().port;
                    const login = await fetch(base + '/api/auth/login', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ username: 'surface-owner', password })
                    });
                    const session = await login.json();
                    if (login.status !== 200) throw new Error('login ' + login.status + ' ' + JSON.stringify(session));
                    const cookie = (login.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
                    const ownerResponse = await fetch(base + '/api/rates', { headers: { cookie } });
                    const owner = await ownerResponse.json();
                    if (ownerResponse.status !== 200) throw new Error('rates ' + ownerResponse.status + ' ' + JSON.stringify(owner));
                    const partnerResponse = await fetch(base + '/api/partner/v1/me/rates', {
                        headers: { authorization: 'Bearer ' + token }
                    });
                    const partner = await partnerResponse.json();
                    if (partnerResponse.status !== 200) throw new Error('partner ' + partnerResponse.status + ' ' + JSON.stringify(partner));
                    const ownerRate = (owner.rates || []).find(rate => rate.id === 'surface-rate');
                    const partnerRate = (partner.data || []).find(rate => rate.id === 'surface-rate');
                    if (!ownerRate || !partnerRate) throw new Error('missing rate ' + JSON.stringify({ owner, partner }));
                    const storedRate = db.prepare('SELECT * FROM rates WHERE id = ?').get('surface-rate');
                    console.log('R154 ' + JSON.stringify({
                        ownerKeys: Object.keys(ownerRate).sort(),
                        partnerKeys: Object.keys(partnerRate).sort(),
                        ownerTop: Object.keys(owner).sort(),
                        partnerTop: Object.keys(partner).sort(),
                        ownerRate,
                        partnerRate,
                        storedMaxSlotsAllowed: storedRate.max_slots_allowed ?? null
                    }));
                    server.close();
                    db.close();
                } catch (error) {
                    console.error(error && error.stack ? error.stack : error);
                    process.exit(1);
                }
            });
        `;
        function readSurface(migrationsDir) {
            const env = {
                ...process.env,
                NODE_ENV: 'test',
                SQLITE_DB_PATH: dbPath,
                MIGRATIONS_DIR: migrationsDir,
                PARTNER_OAUTH_ENABLED: 'true',
                SESSION_SECRET: 'test-session-secret-value-which-is-long',
                OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
            };
            const result = spawnSync(process.execPath, ['-e', script], {
                cwd: root,
                env,
                encoding: 'utf8',
                timeout: 60000
            });
            assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
            const line = result.stdout.trim().split('\n').find(item => item.startsWith('R154 '));
            return JSON.parse(line.slice(5));
        }
        try {
            const before = readSurface(priorMigrations(directory));
            const after = readSurface(migrations);
            assert.deepEqual(after.ownerKeys, before.ownerKeys);
            assert.deepEqual(after.partnerKeys, before.partnerKeys);
            assert.deepEqual(after.ownerTop, before.ownerTop);
            assert.deepEqual(after.partnerTop, before.partnerTop);
            assert.deepEqual(after.ownerRate, before.ownerRate);
            assert.equal(before.partnerRate.maxSlotsAllowed, null);
            assertSlotsInRange([after.storedMaxSlotsAllowed]);
            assert.deepEqual(after.partnerRate, { ...before.partnerRate, maxSlotsAllowed: after.storedMaxSlotsAllowed });
            assert.equal(after.ownerKeys.includes('max_slots_allowed'), false);
            assert.equal(after.partnerKeys.includes('max_slots_allowed'), false);
            assert.equal(after.ownerKeys.includes('maxSlotsAllowed'), false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
