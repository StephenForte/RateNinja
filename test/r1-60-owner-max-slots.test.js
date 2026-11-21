'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { RATE_FIELDS } = require('../lib/record-validation');
const { startApp } = require('./helpers/app');
const { ratePatch } = require('./helpers/r1-08');
const { authorizeAndToken, mcpCall, partnerGet, REDIRECT_URI } = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    activate,
    call,
    insertCompany,
    insertMargin,
    insertRate,
    insertUser,
    login,
    utcDay
} = require('./helpers/r1-19');

const MESSAGE = 'Must be a whole number of 0 or more.';
const RATE_ID = 'r160-cap';

describe('r1-60 owner max slots', { concurrency: 1 }, () => {
    let app;
    let customer;
    let other;
    let customerToken;

    before(async () => {
        app = await startApp({ companyName: 'Slot Owner', username: 'slot-owner' });
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        const context = await app.request('/api/admin/context', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ companyId: app.company.id })
        });
        assert.equal(context.status, 200, await context.text());
        insertCompany(app.db, { id: 'r160-buyer', name: 'Slot Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(app.db, { id: 'r160-other', name: 'Other Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertUser(app.db, {
            id: 'r160-buyer-user', username: 'slot-buyer', companyId: 'r160-buyer', displayName: 'Slot Buyer'
        });
        insertUser(app.db, {
            id: 'r160-other-user', username: 'other-owner', companyId: 'r160-other',
            role: 'company_admin', displayName: 'Other Owner'
        });
        activate('slot-buyer');
        activate('other-owner');
        insertMargin(app.db, { id: 'r160-margin', owner: app.company.id, customer: 'r160-buyer', percent: 0 });
        insertRate(app.db, {
            id: RATE_ID,
            owner: app.company.id,
            expiration: utcDay(40),
            maxSlotsAllowed: 4
        });
        customer = await login(app.baseUrl, 'slot-buyer');
        other = await login(app.baseUrl, 'other-owner');
        const registered = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Synthetic R1-60',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['rates:read']
            })
        });
        const client = await registered.json();
        assert.equal(registered.status, 201, JSON.stringify(client));
        const token = await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: customer.cookie,
            csrf: customer.csrf,
            clientId: client.client.id,
            clientSecret: client.clientSecret,
            scope: 'rates:read'
        });
        customerToken = token.access_token;
    });

    after(async () => {
        if (app) await app.close();
    });

    function row(id = RATE_ID) {
        return app.db.prepare('SELECT * FROM rates WHERE id = ?').get(id);
    }

    async function readJson(response) {
        const text = await response.text();
        let body = null;
        if (text) body = JSON.parse(text);
        return { status: response.status, body, text };
    }

    function patch(version, extra = {}, id = RATE_ID) {
        return app.request(`/api/admin/data/rates/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(ratePatch(app.company.id, version, {
                rate20D: 1000,
                rate40D: 1800,
                rate40HC: 1900,
                rateExpirationDate: utcDay(40),
                ...extra
            }))
        }).then(readJson);
    }

    async function seenBy(session) {
        const response = await call(app.baseUrl, session, 'GET', '/api/rates');
        assert.equal(response.status, 200, response.text);
        const rate = response.json.rates.find(item => item.id === RATE_ID);
        assert.ok(rate, response.text);
        return rate.maxSlotsAllowed;
    }

    it('shows the stored max to the owner and the linked customer', async () => {
        const ownerSession = { cookie: app.cookie, csrf: app.csrf, user: app.user };
        assert.equal(await seenBy(ownerSession), 4);
        assert.equal(await seenBy(customer), 4);
        assert.equal(RATE_FIELDS.includes('maxSlotsAllowed'), false);
    });

    it('stores 0, 3 and 12 and then refuses a 4-slot booking', async () => {
        let version = row().row_version;
        for (const value of [0, 3, 12]) {
            const saved = await patch(version, { maxSlotsAllowed: value });
            assert.equal(saved.status, 200, saved.text);
            const stored = row();
            assert.equal(stored.max_slots_allowed, value);
            assert.equal(stored.row_version, version + 1);
            version = stored.row_version;
        }
        const back = await patch(version, { maxSlotsAllowed: 3 });
        assert.equal(back.status, 200, back.text);
        const ownerSession = { cookie: app.cookie, csrf: app.csrf, user: app.user };
        assert.equal(await seenBy(ownerSession), 3);
        assert.equal(await seenBy(customer), 3);

        const listed = await readJson(await app.request('/api/admin/data/rates'));
        assert.equal(listed.status, 200, listed.text);
        assert.equal(listed.body.records.find(record => record.id === RATE_ID).maxSlotsAllowed, 3);

        const partner = await partnerGet(app.baseUrl, customerToken, '/api/partner/v1/me/available-rates');
        assert.equal(partner.status, 200, partner.text);
        assert.equal(partner.body.data.find(rate => rate.id === RATE_ID).maxSlotsAllowed, 3);
        const mcp = await mcpCall(app.baseUrl, customerToken, 'tools/call', {
            name: 'rateninja_list_available_rates',
            arguments: {}
        });
        assert.equal(mcp.status, 200, mcp.text);
        assert.equal(mcp.body.result.isError, false, mcp.text);
        assert.equal(mcp.body.result.structuredContent.data.find(rate => rate.id === RATE_ID).maxSlotsAllowed, 3);

        const before = row();
        const refused = await call(app.baseUrl, customer, 'POST', '/api/booking-requests', {
            rateId: RATE_ID, containerSize: '20D', slots: 4
        });
        assert.equal(refused.status, 400, refused.text);
        assert.equal(refused.json.error, 'This rate allows at most 3 slots per request.');
        assert.deepEqual(row(), before);
    });

    it('rejects a max that is not a whole number of 0 or more', async () => {
        const before = row();
        for (const value of [-1, 2.5, '3', '', null, true]) {
            const rejected = await patch(before.row_version, { maxSlotsAllowed: value });
            assert.equal(rejected.status, 400, `${JSON.stringify(value)} ${rejected.text}`);
            assert.equal(rejected.body.code, 'validation');
            assert.deepEqual(rejected.body.errors, [{ field: 'maxSlotsAllowed', message: MESSAGE }]);
            assert.deepEqual(row(), before);
        }
    });

    it('keeps the stored max when the edit omits the field', async () => {
        const before = row();
        const saved = await patch(before.row_version, { carrier: 'EDITED SLOTS' });
        assert.equal(saved.status, 200, saved.text);
        const stored = row();
        assert.equal(stored.carrier, 'EDITED SLOTS');
        assert.equal(stored.max_slots_allowed, before.max_slots_allowed);
        assert.equal(stored.row_version, before.row_version + 1);
    });

    it('changes nothing for a stale version or another owner', async () => {
        const before = row();
        const stale = await patch(before.row_version - 1, { maxSlotsAllowed: 1 });
        assert.equal(stale.status, 409, stale.text);
        assert.equal(stale.body.code, 'stale_row_version');
        assert.deepEqual(row(), before);

        const foreign = await call(app.baseUrl, other, 'PATCH', `/api/admin/data/rates/${RATE_ID}`, ratePatch('r160-other', before.row_version, {
            maxSlotsAllowed: 1
        }));
        assert.equal(foreign.status, 404, foreign.text);
        assert.deepEqual(row(), before);
    });

    it('restores the previous max when the edit is undone', async () => {
        insertRate(app.db, {
            id: 'r160-undo',
            owner: app.company.id,
            expiration: utcDay(40),
            maxSlotsAllowed: 2
        });
        const before = row('r160-undo');
        const saved = await patch(before.row_version, { maxSlotsAllowed: 8 }, 'r160-undo');
        assert.equal(saved.status, 200, saved.text);
        assert.equal(row('r160-undo').max_slots_allowed, 8);
        const undone = await readJson(await app.request(`/api/admin/data/operations/${saved.body.operationId}/undo`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ submissionId: 'r160-undo-slots', companyId: app.company.id })
        }));
        assert.equal(undone.status, 200, undone.text);
        const stored = row('r160-undo');
        assert.equal(stored.max_slots_allowed, 2);
        assert.equal(stored.row_version, before.row_version + 2);
    });

    it('keeps the current max when an older undo snapshot has no max slots column', async () => {
        insertRate(app.db, {
            id: 'r160-legacy-undo',
            owner: app.company.id,
            expiration: utcDay(40),
            maxSlotsAllowed: 4
        });
        const before = row('r160-legacy-undo');
        const saved = await patch(before.row_version, { maxSlotsAllowed: 9 }, 'r160-legacy-undo');
        assert.equal(saved.status, 200, saved.text);
        assert.equal(row('r160-legacy-undo').max_slots_allowed, 9);
        const item = app.db.prepare(`SELECT prior_json FROM data_operation_items WHERE operation_id = ?`).get(saved.body.operationId);
        const prior = JSON.parse(item.prior_json);
        delete prior.max_slots_allowed;
        app.db.prepare(`UPDATE data_operation_items SET prior_json = ? WHERE operation_id = ?`).run(
            JSON.stringify(prior),
            saved.body.operationId
        );
        const undone = await readJson(await app.request(`/api/admin/data/operations/${saved.body.operationId}/undo`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ submissionId: 'r160-legacy-undo', companyId: app.company.id })
        }));
        assert.equal(undone.status, 200, undone.text);
        assert.equal(row('r160-legacy-undo').max_slots_allowed, 9);
    });

    it('still lets a blank import cell draw a trigger value from 0 to 5', async () => {
        const headers = ['Origin Port', 'Destination Port/Via Port', 'Carrier', '20D Rate', 'Effective Date', 'Expiry Date', 'Max Slots Allowed'];
        const mapping = headers.map(header => ({
            source: header,
            target: {
                'Origin Port': 'originPort',
                'Destination Port/Via Port': 'destinationPort',
                Carrier: 'carrier',
                '20D Rate': 'rate20D',
                'Effective Date': 'rateEffectiveDate',
                'Expiry Date': 'rateExpirationDate',
                'Max Slots Allowed': 'maxSlotsAllowed'
            }[header]
        }));
        const csv = `${headers.join(',')}\nBlank Harbor,North Quay,Slot Line,100,2026-06-01,2026-06-30,\n`;
        const uploaded = await readJson(await app.request('/api/admin/imports/uploads', {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-import-filename': 'r160-blank.csv',
                'x-import-dataset': 'rates'
            },
            body: Buffer.from(csv)
        }));
        assert.equal(uploaded.status, 201, uploaded.text);
        const selected = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/sheet`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sheetName: 'CSV', companyId: app.company.id })
        }));
        assert.equal(selected.status, 200, selected.text);
        const committed = await readJson(await app.request(`/api/admin/imports/${uploaded.body.jobId}/commit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                companyId: app.company.id,
                sheetName: 'CSV',
                mapping,
                dateOrder: null,
                excludedRows: [],
                submissionId: 'r160-blank',
                acknowledgeAppend: true
            })
        }));
        assert.equal(committed.status, 200, committed.text);
        const stored = app.db.prepare(`SELECT max_slots_allowed AS slots FROM rates WHERE origin_port = 'Blank Harbor'`).get();
        assert.equal(typeof stored.slots, 'number');
        assert.equal(Number.isInteger(stored.slots), true);
        assert.equal(stored.slots >= 0 && stored.slots <= 5, true);
    });
});
