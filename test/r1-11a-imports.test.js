'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { insertCompany, insertUser } = require('./helpers/r1-12');
const { RATE_MAPPING, SAILING_MAPPING, uploadFile, readJson } = require('./helpers/r1-11a');

const IMPORT_ROUTES = [
    ['GET', '/api/admin/imports/limits'],
    ['POST', '/api/admin/imports/uploads'],
    ['POST', '/api/admin/imports/00000000-0000-4000-8000-000000000000/sheet'],
    ['POST', '/api/admin/imports/00000000-0000-4000-8000-000000000000/suggest'],
    ['POST', '/api/admin/imports/00000000-0000-4000-8000-000000000000/validate'],
    ['POST', '/api/admin/imports/00000000-0000-4000-8000-000000000000/commit'],
    ['POST', '/api/admin/imports/00000000-0000-4000-8000-000000000000/cancel']
];

function post(app, urlPath, body, session) {
    const headers = { 'content-type': 'application/json' };
    if (session) {
        headers.cookie = session.cookie;
        headers['x-csrf-token'] = session.csrf;
    }
    return fetch(new URL(urlPath, app.baseUrl), {
        method: 'POST',
        headers,
        body: body === undefined ? JSON.stringify({ companyId: app.company.id }) : body
    });
}

async function login(app, username) {
    const response = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'sail-the-ocean' })
    });
    const body = await response.json();
    const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return { cookie: cookies, csrf: body.csrfToken };
}

describe('r1-11a imports', { concurrency: 1 }, () => {
    let app;
    let customer;

    before(async () => {
        app = await startApp({ companyName: 'Harbor Owner', username: 'import-owner' });
        insertCompany(app.db, {
            id: 'import-customer',
            name: 'Import Customer',
            type: 'Freight Forwarder/Customer',
            typeId: 'freight_forwarder_customer'
        });
        insertUser(app.db, { id: 'import-customer-user', username: 'import-customer', companyId: 'import-customer', admin: 1 });
        const { setPasswordByUsername } = require('../lib/accounts');
        assert.equal(setPasswordByUsername('import-customer', 'sail-the-ocean').ok, true);
        customer = await login(app, 'import-customer');
    });

    after(async () => {
        delete process.env.IMPORT_MAX_BYTES;
        delete process.env.IMPORT_MAX_ROWS;
        if (app) await app.close();
    });

    it('rejects a customer admin and a restricted session on every import route', async () => {
        for (const [method, urlPath] of IMPORT_ROUTES) {
            const response = method === 'GET'
                ? await fetch(new URL(urlPath, app.baseUrl), { headers: { cookie: customer.cookie } })
                : await post(app, urlPath, method === 'POST' && urlPath.endsWith('/uploads') ? Buffer.from('nope') : JSON.stringify({ companyId: 'import-customer' }), customer);
            const body = await response.json().catch(() => ({}));
            assert.equal(response.status, 403, `${method} ${urlPath} ${JSON.stringify(body)}`);
        }
        app.db.prepare(`UPDATE users SET must_change_password = 1 WHERE username = ?`).run(app.username);
        try {
            for (const [method, urlPath] of IMPORT_ROUTES) {
                const response = method === 'GET'
                    ? await app.request(urlPath)
                    : await app.request(urlPath, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: urlPath.endsWith('/uploads') ? Buffer.from('nope') : JSON.stringify({})
                    });
                const body = await response.json().catch(() => ({}));
                assert.equal(response.status, 403, `${method} ${urlPath}`);
                assert.equal(body.code, 'password_change_required');
            }
        } finally {
            app.db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(app.username);
        }
    });

    it('refuses an oversized upload before reading the rest of the body', async () => {
        process.env.IMPORT_MAX_BYTES = '1000';
        const status = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: new URL(app.baseUrl).port,
                path: '/api/admin/imports/uploads',
                method: 'POST',
                headers: {
                    cookie: app.cookie,
                    'x-csrf-token': app.csrf,
                    'content-type': 'application/octet-stream',
                    'content-length': '5000',
                    'x-import-filename': 'big.xlsx',
                    'x-import-dataset': 'rates'
                }
            }, (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode));
            });
            req.on('error', reject);
            req.setTimeout(2000, () => {
                req.destroy();
                reject(new Error('timed out waiting for 413'));
            });
            req.write(Buffer.alloc(64));
        });
        assert.equal(status, 413);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM import_jobs`).get().count, 0);
        delete process.env.IMPORT_MAX_BYTES;
    });

    it('rejects Numbers and other types, and keeps the upload outside public/', async () => {
        const numbers = await app.request('/api/admin/imports/uploads', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-import-filename': 'rates.numbers',
                'x-import-dataset': 'rates'
            },
            body: Buffer.from('not a workbook')
        });
        const numbersBody = await numbers.json();
        assert.equal(numbers.status, 400);
        assert.match(numbersBody.error, /Numbers/);
        assert.match(numbersBody.error, /Excel/);
        const pdf = await app.request('/api/admin/imports/uploads', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-import-filename': 'rates.pdf',
                'x-import-dataset': 'rates'
            },
            body: Buffer.from('%PDF')
        });
        assert.equal(pdf.status, 400);
        assert.match((await pdf.json()).error, /Numbers/);

        const uploaded = await uploadFile(app, 'rates.xlsx', 'rates');
        assert.equal(uploaded.status, 201, uploaded.text);
        const stored = path.join(require('../lib/imports/storage').importsDir(), `${uploaded.body.jobId}.upload`);
        assert.equal(fs.existsSync(stored), true);
        assert.equal(stored.includes(`${path.sep}public${path.sep}`), false);
        const fetched = await app.request(`/imports-tmp/${uploaded.body.jobId}.upload`);
        assert.equal(fetched.status, 404);
        const summary = uploaded.body.sheets.find(sheet => sheet.name === 'Summary');
        assert.equal(summary.ignored, true);
        assert.equal(uploaded.body.suggestedSheet, 'Fixture_Rates');

        const selected = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'Fixture_Rates', companyId: app.company.id })
        }));
        assert.equal(selected.status, 200, selected.text);
        const validated = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/validate`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'Fixture_Rates',
                mapping: RATE_MAPPING,
                dateOrder: null,
                excludedRows: []
            })
        }));
        assert.equal(validated.status, 200, validated.text);
        assert.equal(validated.body.acceptedCount, 5);
        assert.equal(validated.body.rejectedCount, 0);
        const submissionId = 'import-rates-once';
        const committed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'Fixture_Rates',
                mapping: RATE_MAPPING,
                dateOrder: null,
                excludedRows: [],
                submissionId,
                acknowledgeAppend: true
            })
        }));
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.acceptedCount, 5);
        assert.equal(fs.existsSync(stored), false);
        const rows = app.db.prepare(`SELECT * FROM rates WHERE carrier = 'Fixture Line' ORDER BY rate_effective_date`).all();
        assert.equal(rows.length, 5);
        assert.equal(rows[0].rate_effective_date, '2026-03-02');
        assert.equal(rows[0].rate_expiration_date, '2026-03-20');
        assert.equal(rows[0].rate_20d, 1100.5);
        assert.equal(rows[0].rate_40d, 2100.25);
        assert.equal(rows[0].rate_40hc, 2200);
        assert.equal(rows[0].contract_number, 'FX-1001');
        assert.equal(rows[0].owner_company_id, app.company.id);
        assert.equal(rows[1].rate_20d, null);
        assert.equal(rows[1].rate_40d, 1800.4);
        assert.equal(rows[2].origin_port, 'Padded Port');
        assert.equal(rows[2].rate_20d, 999.99);
        assert.equal(rows[3].rate_40d, 1400.1);
        assert.equal(rows[3].rate_40hc, 1450.55);
        assert.equal(rows[4].rate_20d, 750.5);
        assert.equal(rows[4].rate_40d, null);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE type = 'import' AND submission_id = ?`).get(submissionId).count, 1);

        const replay = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                mapping: RATE_MAPPING,
                submissionId,
                acknowledgeAppend: true
            })
        }));
        assert.equal(replay.status, 200, replay.text);
        assert.equal(replay.body.operationId, committed.body.operationId);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE carrier = 'Fixture Line'`).get().count, 5);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = ?`).get(submissionId).count, 1);

        const browsed = await readJson(await app.request('/api/rates'));
        const blank = browsed.body.rates.find(rate => rate.originPort === 'Cedar Dock');
        assert.equal(blank.rate20D, null);
        assert.equal(browsed.body.rates.find(rate => rate.contractNumber === 'FX-1001').contractNumber, 'FX-1001');
        const visibility = require('../lib/visibility');
        const partner = visibility.listPartnerRates({ companyRecordId: app.company.id }, {});
        assert.equal(partner.data.some(row => Object.hasOwn(row, 'contractNumber')), false);
        assert.equal(partner.data.some(row => Object.hasOwn(row, 'arrivalPort')), false);
    });

    it('rejects every rates-bad defect until those rows are excluded', async () => {
        const uploaded = await uploadFile(app, 'rates-bad.xlsx', 'rates');
        assert.equal(uploaded.status, 201, uploaded.text);
        await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'Fixture_Rates', companyId: app.company.id })
        }));
        const validated = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/validate`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                mapping: RATE_MAPPING,
                dateOrder: null,
                excludedRows: []
            })
        }));
        assert.equal(validated.body.acceptedCount, 0);
        assert.equal(validated.body.rejectedCount, 4);
        assert.equal(validated.body.needsDateChoice, true);
        const messages = validated.body.errors.map(error => `${error.row} ${error.field} ${error.message}`).join('\n');
        assert.match(messages, /originPort/);
        assert.match(messages, /ambiguous/);
        assert.match(messages, /non-negative/);
        assert.match(messages, /not USD/);
        const blocked = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                mapping: RATE_MAPPING,
                dateOrder: null,
                excludedRows: [],
                submissionId: 'bad-open',
                acknowledgeAppend: true
            })
        }));
        assert.equal(blocked.status, 409);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'bad-open'`).get().count, 0);
        const chosen = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/validate`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                mapping: RATE_MAPPING,
                dateOrder: 'mdy',
                excludedRows: [2, 4, 5]
            })
        }));
        assert.equal(chosen.body.needsDateChoice, false);
        assert.equal(chosen.body.acceptedCount, 1);
        assert.equal(chosen.body.rejectedCount, 3);
    });

    it('imports sailings, then undo removes only the imported rows', async () => {
        const uploaded = await uploadFile(app, 'sailings.xlsx', 'sailings');
        assert.equal(uploaded.status, 201, uploaded.text);
        const committed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'Fixture_Sailings',
                mapping: SAILING_MAPPING,
                excludedRows: [],
                submissionId: 'import-sailings',
                acknowledgeAppend: true
            })
        }));
        assert.equal(committed.status, 200, committed.text);
        assert.equal(committed.body.acceptedCount, 4);
        const sailings = app.db.prepare(`SELECT * FROM sailings WHERE carrier = 'Fixture Line' ORDER BY departure`).all();
        assert.equal(sailings.length, 4);
        assert.equal(sailings[0].transit_time, '21');
        assert.equal(sailings[0].arrival_port, 'North Quay');
        assert.equal(sailings[0].departure, '2026-04-02');
        assert.equal(sailings[2].vessel, null);
        assert.equal(sailings[3].arrival_port, null);
        const visibility = require('../lib/visibility');
        const partner = visibility.listPartnerSailings({ companyRecordId: app.company.id }, {});
        assert.equal(partner.data.some(row => Object.hasOwn(row, 'arrivalPort')), false);
        const session = await readJson(await app.request('/api/sailings?carrier=Fixture%20Line&originPort=Cedar%20Dock&after=2026-01-01'));
        assert.equal(session.body.sailings[0].arrivalPort, 'North Quay');

        const operationId = app.db.prepare(`SELECT id FROM data_operations WHERE submission_id = 'import-rates-once'`).get().id;
        const undone = await readJson(await app.request(`/api/admin/data/operations/${operationId}/undo`, {
            method: 'POST',
            body: JSON.stringify({ submissionId: 'undo-rates', companyId: app.company.id })
        }));
        assert.equal(undone.status, 200, undone.text);
        assert.equal(undone.body.affectedCount, 5);
        const hidden = app.db.prepare(`SELECT deleted_at FROM rates WHERE carrier = 'Fixture Line'`).all();
        assert.equal(hidden.length, 5);
        assert.equal(hidden.every(row => row.deleted_at), true);
        const store = require('../lib/store');
        assert.equal(store.getAllRates().some(row => row.fields.Carrier === 'Fixture Line'), false);
        const browsed = await readJson(await app.request('/api/rates'));
        assert.equal(browsed.body.rates.some(rate => rate.carrier === 'Fixture Line'), false);
        const again = require('../lib/visibility').listPartnerRates({ companyRecordId: app.company.id }, {});
        assert.equal(again.data.some(row => row.carrier === 'Fixture Line'), false);
    });

    it('refuses undo after an imported row is edited', async () => {
        const uploaded = await uploadFile(app, 'rates.xlsx', 'rates');
        const committed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'Fixture_Rates',
                mapping: RATE_MAPPING,
                excludedRows: [],
                submissionId: 'import-rates-edit',
                acknowledgeAppend: true
            })
        }));
        assert.equal(committed.status, 200, committed.text);
        const row = app.db.prepare(`SELECT id, row_version FROM rates WHERE contract_number = 'FX-1001' AND deleted_at IS NULL`).get();
        const edited = await readJson(await app.request(`/api/admin/data/rates/${row.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                carrier: 'Edited Line',
                expectedRowVersion: row.row_version,
                companyId: app.company.id
            })
        }));
        assert.equal(edited.status, 200, edited.text);
        const refused = await readJson(await app.request(`/api/admin/data/operations/${committed.body.operationId}/undo`, {
            method: 'POST',
            body: JSON.stringify({ submissionId: 'undo-edited', companyId: app.company.id })
        }));
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.body.code, 'undo_conflict');
        const kept = app.db.prepare(`SELECT carrier, deleted_at FROM rates WHERE id = ?`).get(row.id);
        assert.equal(kept.carrier, 'Edited Line');
        assert.equal(kept.deleted_at, null);
        assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates WHERE carrier = 'Fixture Line' AND deleted_at IS NULL`).get().count, 4);
    });

    it('rolls back a forced failure and does not leave an operation', async () => {
        const beforeRates = app.db.prepare(`SELECT COUNT(*) AS count FROM rates`).get().count;
        const beforeOps = app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE type = 'import'`).get().count;
        app.db.exec(`
            CREATE TRIGGER fail_import_mid
            BEFORE INSERT ON rates
            WHEN NEW.origin_port = 'Cedar Dock' AND NEW.notes_1 = 'No twenty-foot price on this row'
            BEGIN
                SELECT RAISE(ABORT, 'forced failure');
            END;
        `);
        try {
            const uploaded = await uploadFile(app, 'rates.xlsx', 'rates');
            const committed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
                method: 'POST',
                body: JSON.stringify({
                    companyId: app.company.id,
                    sheetName: 'Fixture_Rates',
                    mapping: RATE_MAPPING,
                    excludedRows: [],
                    submissionId: 'import-atomic',
                    acknowledgeAppend: true
                })
            }));
            assert.notEqual(committed.status, 200);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM rates`).get().count, beforeRates);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE type = 'import'`).get().count, beforeOps);
            assert.equal(app.db.prepare(`SELECT COUNT(*) AS count FROM data_operations WHERE submission_id = 'import-atomic'`).get().count, 0);
        } finally {
            app.db.exec('DROP TRIGGER IF EXISTS fail_import_mid');
        }
    });

    it('does not call Claude without confirmation, and discards a bad or timed-out response', async () => {
        const claude = require('../lib/imports/claude');
        const uploaded = await uploadFile(app, 'rates.xlsx', 'rates');
        await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            body: JSON.stringify({ sheetName: 'Fixture_Rates', companyId: app.company.id })
        }));
        claude.setClient(async () => {
            throw new Error('should not be called');
        });
        const unconfirmed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/suggest`, {
            method: 'POST',
            body: JSON.stringify({ confirmed: false, companyId: app.company.id })
        }));
        assert.equal(unconfirmed.status, 400);
        assert.equal(claude.clientCalls(), 0);
        const headers = RATE_MAPPING.map(pair => pair.source);
        claude.setClient(async () => ({
            text: JSON.stringify({
                dataset: 'rates',
                mappings: headers.map(source => ({
                    source,
                    target: source === 'Origin Port' ? 'owner_company_id' : 'rate20D',
                    confidence: 'high',
                    reason: 'Invented a constant.',
                    value: 1
                }))
            })
        }));
        const malicious = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/suggest`, {
            method: 'POST',
            body: JSON.stringify({ confirmed: true, companyId: app.company.id })
        }));
        assert.equal(malicious.status, 200, malicious.text);
        assert.equal(malicious.body.suggestions, null);
        assert.equal(malicious.body.fallback, 'manual');
        assert.equal(claude.clientCalls(), 1);
        const manual = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/validate`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                mapping: RATE_MAPPING,
                excludedRows: []
            })
        }));
        assert.equal(manual.body.acceptedCount, 5);
        claude.setClient(async () => {
            const error = new Error('timed out');
            error.name = 'TimeoutError';
            throw error;
        });
        const timedOut = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/suggest`, {
            method: 'POST',
            body: JSON.stringify({ confirmed: true, companyId: app.company.id })
        }));
        assert.equal(timedOut.body.suggestions, null);
        assert.equal(timedOut.body.fallback, 'manual');
        assert.equal(timedOut.body.reason, 'timeout');
    });

    it('sweeps an expired upload and enforces the row cap', async () => {
        const uploaded = await uploadFile(app, 'rates.csv', 'rates');
        assert.equal(uploaded.status, 201, uploaded.text);
        const stored = path.join(require('../lib/imports/storage').importsDir(), `${uploaded.body.jobId}.upload`);
        assert.equal(fs.existsSync(stored), true);
        app.db.prepare(`UPDATE import_jobs SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', uploaded.body.jobId);
        assert.equal(require('../lib/imports/jobs').sweepExpired(), 1);
        assert.equal(fs.existsSync(stored), false);
        assert.equal(app.db.prepare(`SELECT status FROM import_jobs WHERE id = ?`).get(uploaded.body.jobId).status, 'expired');
        process.env.IMPORT_MAX_ROWS = '2';
        const tooMany = await uploadFile(app, 'rates.csv', 'rates');
        assert.equal(tooMany.status, 413);
        delete process.env.IMPORT_MAX_ROWS;
        const validated = await uploadFile(app, 'rates.csv', 'rates');
        const checked = await readJson(await app.request(`/api/admin/imports/${validated.body.jobId}/validate`, {
            method: 'POST',
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'CSV',
                mapping: RATE_MAPPING,
                excludedRows: []
            })
        }));
        assert.equal(checked.status, 200, checked.text);
        assert.equal(checked.body.acceptedCount, 5);
        assert.equal(checked.body.rejectedCount, 0);
    });
});
