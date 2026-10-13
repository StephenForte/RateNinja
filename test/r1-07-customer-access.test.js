'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { customerPrice } = require('../lib/pricing');
const { calculatePredictiveRate, predictiveWindow } = require('../lib/predictive');
const {
    PASSWORD,
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    insertRate,
    insertSailing,
    insertMargin,
    marginRow
} = require('./helpers/r1-07');

const AFTER = utcDay(120);
const SAILING = '/api/sailings?carrier=MSC&originPort=SHA&after=2020-01-01';

function ids(payload, key) {
    return (payload[key] || []).map(row => row.id);
}

describe('r1-07 customer authorization and live pricing', { concurrency: 1 }, () => {
    let app;
    let actor;
    let setPasswordByUsername;

    before(async () => {
        app = await startApp({ role: 'member', username: 'r107-unused', companyName: 'Unused Co' });
        ({ setPasswordByUsername } = require('../lib/accounts'));
        const { db } = app;
        insertCompany(db, { id: 'owner-a', name: 'Harbor Lines', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'owner-b', name: 'Owner B', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(db, { id: 'cust-priced', name: 'Priced Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-zero', name: 'Zero Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-none', name: 'Unlinked Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-fraction', name: 'Fraction Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-whole', name: 'Whole Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-legacy-one', name: 'Legacy One', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-shared', name: 'Shared Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-revoke', name: 'Revoke Customer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(db, { id: 'cust-only-a', name: 'Only A Customer', type: COMPANY_TYPE_CUSTOMER });
        const people = [
            ['owner-admin', 'owner-a', 'company_admin', false],
            ['owner-b-admin', 'owner-b', 'company_admin', false],
            ['customer-admin', 'cust-none', 'company_admin', false],
            ['system-admin', 'owner-a', 'company_admin', true],
            ['user-priced', 'cust-priced', 'member', false],
            ['user-zero', 'cust-zero', 'member', false],
            ['user-none', 'cust-none', 'member', false],
            ['user-fraction', 'cust-fraction', 'member', false],
            ['user-whole', 'cust-whole', 'member', false],
            ['user-one', 'cust-legacy-one', 'member', false],
            ['user-shared', 'cust-shared', 'member', false],
            ['user-revoke', 'cust-revoke', 'member', false]
        ];
        for (const [id, companyId, role, systemAdmin] of people) {
            insertUser(db, { id, username: id, companyId, role, systemAdmin, displayName: id });
            assert.equal(setPasswordByUsername(id, PASSWORD).ok, true);
        }
        insertRate(db, { id: 'rate-a', owner: 'owner-a', rate20: 1000, rate40: 2000, rate40hc: 2100 });
        insertRate(db, { id: 'rate-cma', owner: 'owner-a', carrier: 'CMA', origin: 'NINGBO', destination: 'NYC', rate20: 800 });
        insertRate(db, { id: 'rate-b', owner: 'owner-b', rate20: 5000 });
        insertSailing(db, { id: 'sailing-a', owner: 'owner-a' });
        insertSailing(db, { id: 'sailing-b', owner: 'owner-b' });
        insertMargin(db, { id: 'margin-zero', owner: 'owner-a', customer: 'cust-zero', percent: 0, number: 0 });
        insertMargin(db, { id: 'margin-fraction', owner: 'owner-a', customer: 'cust-fraction', percent: 0.1, number: 0 });
        insertMargin(db, { id: 'margin-whole', owner: 'owner-a', customer: 'cust-whole', percent: 10, number: 0 });
        insertMargin(db, { id: 'margin-one', owner: 'owner-a', customer: 'cust-legacy-one', percent: 1, number: 0 });
        insertMargin(db, { id: 'margin-shared-a', owner: 'owner-a', customer: 'cust-shared', percent: 0.1, number: 0 });
        insertMargin(db, { id: 'margin-shared-b', owner: 'owner-b', customer: 'cust-shared', percent: 0.25, number: 0 });
        insertMargin(db, { id: 'margin-revoke', owner: 'owner-a', customer: 'cust-revoke', percent: 0.1, number: 25 });
        insertMargin(db, { id: 'margin-only-a', owner: 'owner-a', customer: 'cust-only-a', percent: 0.1, number: 5 });
        actor = {};
        for (const id of ['owner-admin', 'owner-b-admin', 'customer-admin', 'system-admin', 'user-priced', 'user-zero', 'user-none', 'user-fraction', 'user-whole', 'user-one', 'user-shared', 'user-revoke']) {
            actor[id] = await login(app.baseUrl, id, PASSWORD);
        }
    });

    after(async () => {
        if (app) await app.close();
    });

    it('prices $1,000 at 10% plus $25 as $1,125 in the preview and in customer browsing', async () => {
        const before = app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count;
        const authorized = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-priced/authorize', {
            marginPercent: 10,
            marginNumber: 25,
            companyId: 'owner-a'
        });
        assert.equal(authorized.status, 200, JSON.stringify(authorized.json));
        assert.equal(authorized.json.customer.marginPercent, 10);
        assert.equal(authorized.json.customer.marginNumber, 25);
        assert.equal(authorized.json.customer.status, 'active');
        const stored = marginRow(app.db, 'owner-a', 'cust-priced');
        assert.equal(stored.margin_percent, 0.1);
        assert.equal(stored.margin_number, 25);
        assert.equal(stored.status, 'active');
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count, before + 1);

        const preview = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-priced/preview', {
            companyId: 'owner-a',
            carrier: 'MSC',
            origin: 'SHA',
            destination: 'LAX'
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.json));
        assert.equal(preview.json.proposed, false);
        assert.equal(typeof preview.json.refreshedAt, 'string');
        assert.ok(Number.isFinite(Date.parse(preview.json.refreshedAt)));
        const sample = preview.json.rates.find(rate => rate.id === 'rate-a');
        assert.ok(sample);
        assert.equal(sample.base20D, 1000);
        assert.equal(sample.appliedMargin20D, 125);
        assert.equal(sample.customerPrice20D, 1125);
        assert.equal(sample.rate20D, 1125);
        assert.equal(sample.customerPrice40D, 2225);
        assert.equal(sample.customerPrice40HC, 2335);
        assert.equal(preview.json.rates.every(rate => rate.ownerCompanyId === 'owner-a'), true);
        assert.equal(preview.json.rates.some(rate => rate.id === 'rate-b'), false);
        assert.equal(preview.json.rates.some(rate => rate.id === 'rate-cma'), false);

        const customer = await call(app.baseUrl, actor['user-priced'], 'GET', '/api/rates?carrier=MSC&origin=SHA&destination=LAX&search=MSC');
        assert.equal(customer.status, 200);
        const seen = customer.json.rates.find(rate => rate.id === 'rate-a');
        assert.equal(seen.rate20D, sample.customerPrice20D);
        assert.equal(seen.rate40D, sample.customerPrice40D);
        assert.equal(seen.rate40HC, sample.customerPrice40HC);
        assert.equal(customer.json.rates.some(rate => rate.id === 'rate-b'), false);
    });

    it('distinguishes a zero-margin customer from an unauthorized customer', async () => {
        const zero = await call(app.baseUrl, actor['user-zero'], 'GET', '/api/rates');
        const none = await call(app.baseUrl, actor['user-none'], 'GET', '/api/rates');
        assert.equal(zero.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1000);
        assert.equal(none.json.rates.some(rate => rate.id === 'rate-a' || rate.id === 'rate-cma'), false);
        const zeroSailings = await call(app.baseUrl, actor['user-zero'], 'GET', SAILING);
        const noneSailings = await call(app.baseUrl, actor['user-none'], 'GET', SAILING);
        assert.equal(ids(zeroSailings.json, 'sailings').includes('sailing-a'), true);
        assert.equal(ids(noneSailings.json, 'sailings').includes('sailing-a'), false);
        const listed = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers');
        const zeroRow = listed.json.customers.find(customer => customer.id === 'cust-zero');
        assert.equal(zeroRow.status, 'active');
        assert.equal(zeroRow.marginPercent, 0);
        assert.equal(listed.json.customers.some(customer => customer.id === 'cust-none'), false);
    });

    it('prices a legacy fraction and a legacy whole percent the same, and shows both as a whole percent', async () => {
        const listed = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers');
        const fraction = listed.json.customers.find(customer => customer.id === 'cust-fraction');
        const whole = listed.json.customers.find(customer => customer.id === 'cust-whole');
        const legacyOne = listed.json.customers.find(customer => customer.id === 'cust-legacy-one');
        assert.equal(fraction.marginPercent, 10);
        assert.equal(whole.marginPercent, 10);
        assert.equal(legacyOne.marginPercent, 100);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-fraction').margin_percent, 0.1);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-whole').margin_percent, 10);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-legacy-one').margin_percent, 1);
        const fractionRates = await call(app.baseUrl, actor['user-fraction'], 'GET', '/api/rates');
        const wholeRates = await call(app.baseUrl, actor['user-whole'], 'GET', '/api/rates');
        const oneRates = await call(app.baseUrl, actor['user-one'], 'GET', '/api/rates');
        assert.equal(fractionRates.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1100);
        assert.equal(wholeRates.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1100);
        assert.equal(oneRates.json.rates.find(rate => rate.id === 'rate-a').rate20D, 2000);
        const fractionPreview = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-fraction/preview', {});
        const wholePreview = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-whole/preview', {});
        assert.equal(fractionPreview.json.rates.find(rate => rate.id === 'rate-a').customerPrice20D, 1100);
        assert.equal(wholePreview.json.rates.find(rate => rate.id === 'rate-a').customerPrice20D, 1100);
        assert.equal(fractionPreview.json.proposed, false);
        assert.equal(wholePreview.json.proposed, false);
    });

    it('uses the same price for predictive browsing as customerPrice', async () => {
        const window = predictiveWindow(AFTER);
        assert.equal(window.ok, true);
        const expected = customerPrice(
            calculatePredictiveRate(1000, window.fullThirtyDayPeriods),
            { marginPercent: 0.1, marginNumber: 0 }
        );
        const predictive = await call(app.baseUrl, actor['user-fraction'], 'GET', `/api/rates/predictive?after=${AFTER}`);
        assert.equal(predictive.status, 200, JSON.stringify(predictive.json));
        assert.equal(predictive.json.rates.find(rate => rate.id === 'rate-a').rate20D, expected);
    });

    it('drops this owner from the customer\'s next rates, predictive rates, and sailings on revoke, then restores the margin', async () => {
        const before = marginRow(app.db, 'owner-a', 'cust-revoke');
        const seen = await call(app.baseUrl, actor['user-revoke'], 'GET', '/api/rates');
        assert.equal(seen.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1125);
        const revoked = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-revoke/revoke', { companyId: 'owner-a' });
        assert.equal(revoked.status, 200);
        assert.equal(revoked.json.customer.status, 'revoked');
        assert.equal(revoked.json.customer.marginPercent, 10);
        assert.equal(revoked.json.customer.marginNumber, 25);
        const rates = await call(app.baseUrl, actor['user-revoke'], 'GET', '/api/rates');
        const predictive = await call(app.baseUrl, actor['user-revoke'], 'GET', `/api/rates/predictive?after=${AFTER}`);
        const sailings = await call(app.baseUrl, actor['user-revoke'], 'GET', SAILING);
        assert.equal(rates.json.rates.some(rate => rate.id === 'rate-a' || rate.id === 'rate-cma'), false);
        assert.equal(predictive.json.rates.some(rate => rate.id === 'rate-a' || rate.id === 'rate-cma'), false);
        assert.equal(ids(sailings.json, 'sailings').includes('sailing-a'), false);
        const kept = marginRow(app.db, 'owner-a', 'cust-revoke');
        assert.equal(kept.margin_percent, before.margin_percent);
        assert.equal(kept.margin_number, before.margin_number);
        assert.equal(kept.status, 'revoked');
        const restored = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-revoke/authorize', {});
        assert.equal(restored.status, 200);
        assert.equal(restored.json.customer.status, 'active');
        assert.equal(restored.json.customer.marginPercent, 10);
        assert.equal(restored.json.customer.marginNumber, 25);
        const again = await call(app.baseUrl, actor['user-revoke'], 'GET', '/api/rates');
        const againPredictive = await call(app.baseUrl, actor['user-revoke'], 'GET', `/api/rates/predictive?after=${AFTER}`);
        const againSailings = await call(app.baseUrl, actor['user-revoke'], 'GET', SAILING);
        assert.equal(again.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1125);
        assert.equal(againPredictive.json.rates.some(rate => rate.id === 'rate-a'), true);
        assert.equal(ids(againSailings.json, 'sailings').includes('sailing-a'), true);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-revoke').margin_percent, 0.1);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-revoke').margin_number, 25);
    });

    it('returns 404 and creates no link when margins are edited for an unlinked customer', async () => {
        const before = app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count;
        const missing = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/customers/cust-none/margins', {
            marginPercent: 10,
            marginNumber: 25
        });
        assert.equal(missing.status, 404);
        assert.equal(marginRow(app.db, 'owner-a', 'cust-none'), undefined);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count, before);
        const stillNone = await call(app.baseUrl, actor['user-none'], 'GET', '/api/rates');
        assert.equal(stillNone.json.rates.some(rate => rate.id === 'rate-a'), false);
    });

    it('does not authorize a customer when only the margin is saved', async () => {
        const revoked = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-only-a/revoke', {});
        assert.equal(revoked.status, 200);
        const saved = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/customers/cust-only-a/margins', {
            marginPercent: 5,
            marginNumber: 1
        });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.customer.status, 'revoked');
        assert.equal(saved.json.customer.marginPercent, 5);
        const row = marginRow(app.db, 'owner-a', 'cust-only-a');
        assert.equal(row.status, 'revoked');
        assert.equal(row.margin_percent, 0.05);
        assert.equal(row.margin_number, 1);
    });

    it('returns only id and name from lookup, and never an owner company', async () => {
        const found = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers/lookup?q=Harbor');
        assert.equal(found.status, 200);
        assert.deepEqual(Object.keys(found.json), ['companies']);
        assert.equal(found.json.companies.length, 0);
        const customers = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers/lookup?q=Customer');
        assert.equal(customers.status, 200);
        assert.ok(customers.json.companies.length > 1);
        for (const company of customers.json.companies) {
            assert.deepEqual(Object.keys(company).sort(), ['id', 'name']);
            assert.equal(JSON.stringify(company).includes('user'), false);
            assert.equal(JSON.stringify(company).includes('margin'), false);
        }
        const names = customers.json.companies.map(company => company.name);
        assert.equal(names.includes('Harbor Lines'), false);
        assert.equal(names.includes('Owner B'), false);
        assert.equal(names.includes('Priced Customer'), true);
        const owners = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers/lookup?q=Owner%20B');
        assert.deepEqual(owners.json.companies, []);
        const blank = await call(app.baseUrl, actor['owner-admin'], 'GET', '/api/admin/customers/lookup?q=');
        assert.equal(blank.status, 400);
    });

    it('refuses to authorize the owner, another owner, or a missing company', async () => {
        const before = app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count;
        for (const id of ['owner-a', 'owner-b', 'missing-company']) {
            const refused = await call(app.baseUrl, actor['owner-admin'], 'POST', `/api/admin/customers/${id}/authorize`, {
                companyType: 'Freight Forwarder/Customer',
                ownerCompanyId: 'owner-a',
                marginPercent: 10,
                marginNumber: 0
            });
            assert.equal(refused.status, 404, id);
            assert.equal(marginRow(app.db, 'owner-a', id), undefined);
        }
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count, before);
    });

    it('previews only this owner\'s rates, labels unsaved margins as proposed, and does not save them', async () => {
        const before = marginRow(app.db, 'owner-a', 'cust-fraction');
        const proposed = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-fraction/preview', {
            marginPercent: 20,
            marginNumber: 0,
            search: 'LAX'
        });
        assert.equal(proposed.status, 200);
        assert.equal(proposed.json.proposed, true);
        assert.equal(proposed.json.rates.every(rate => rate.proposed === true), true);
        assert.equal(proposed.json.rates.every(rate => rate.ownerCompanyId === 'owner-a'), true);
        assert.equal(proposed.json.rates.some(rate => rate.id === 'rate-b'), false);
        const sample = proposed.json.rates.find(rate => rate.id === 'rate-a');
        assert.equal(sample.customerPrice20D, 1200);
        assert.equal(sample.proposed, true);
        assert.deepEqual(marginRow(app.db, 'owner-a', 'cust-fraction'), before);
        const browsing = await call(app.baseUrl, actor['user-fraction'], 'GET', '/api/rates?search=LAX');
        assert.equal(browsing.json.rates.find(rate => rate.id === 'rate-a').rate20D, 1100);
        const shared = await call(app.baseUrl, actor['user-shared'], 'GET', '/api/rates');
        assert.equal(shared.json.rates.some(rate => rate.id === 'rate-b'), true);
        const preview = await call(app.baseUrl, actor['owner-admin'], 'POST', '/api/admin/customers/cust-shared/preview', {});
        assert.equal(preview.json.rates.some(rate => rate.id === 'rate-b'), false);
        assert.equal(preview.json.rates.find(rate => rate.id === 'rate-a').customerPrice20D, 1100);
        assert.equal(preview.json.rates.find(rate => rate.id === 'rate-a').customerPrice20D, shared.json.rates.find(rate => rate.id === 'rate-a').rate20D);
    });

    it('refuses a customer company admin on every customer-administration route', async () => {
        const routes = [
            ['GET', '/api/admin/customers'],
            ['GET', '/api/admin/customers/lookup?q=Customer'],
            ['POST', '/api/admin/customers/cust-priced/authorize', {}],
            ['POST', '/api/admin/customers/cust-priced/revoke', {}],
            ['PATCH', '/api/admin/customers/cust-priced/margins', { marginPercent: 1, marginNumber: 0 }],
            ['POST', '/api/admin/customers/cust-priced/preview', {}]
        ];
        for (const [method, path, body] of routes) {
            const denied = await call(app.baseUrl, actor['customer-admin'], method, path, body);
            assert.equal(denied.status, 403, `${method} ${path}`);
        }
        assert.equal(marginRow(app.db, 'owner-a', 'cust-priced').margin_percent, 0.1);
    });

    it('rejects a company-context mismatch and leaves the link unchanged', async () => {
        const before = marginRow(app.db, 'owner-a', 'cust-priced');
        const mismatch = await call(app.baseUrl, actor['owner-admin'], 'PATCH', '/api/admin/customers/cust-priced/margins', {
            companyId: 'owner-b',
            marginPercent: 40,
            marginNumber: 9
        });
        assert.equal(mismatch.status, 409);
        assert.equal(mismatch.json.code, 'company_context_mismatch');
        assert.deepEqual(marginRow(app.db, 'owner-a', 'cust-priced'), before);
    });

    it('keeps owner B and a system admin in owner B\'s context off owner A\'s links', async () => {
        const before = marginRow(app.db, 'owner-a', 'cust-only-a');
        const listed = await call(app.baseUrl, actor['owner-b-admin'], 'GET', '/api/admin/customers');
        assert.equal(listed.status, 200);
        assert.equal(listed.json.customers.some(customer => customer.id === 'cust-only-a'), false);
        const preview = await call(app.baseUrl, actor['owner-b-admin'], 'POST', '/api/admin/customers/cust-only-a/preview', {});
        assert.equal(preview.status, 404);
        const revoked = await call(app.baseUrl, actor['owner-b-admin'], 'POST', '/api/admin/customers/cust-only-a/revoke', {});
        assert.equal(revoked.status, 404);
        const margins = await call(app.baseUrl, actor['owner-b-admin'], 'PATCH', '/api/admin/customers/cust-only-a/margins', {
            marginPercent: 30,
            marginNumber: 4
        });
        assert.equal(margins.status, 404);
        const authorizeOwn = await call(app.baseUrl, actor['owner-b-admin'], 'POST', '/api/admin/customers/cust-only-a/authorize', {
            ownerCompanyId: 'owner-a',
            marginPercent: 12,
            marginNumber: 0
        });
        assert.equal(authorizeOwn.status, 200, JSON.stringify(authorizeOwn.json));
        assert.equal(marginRow(app.db, 'owner-b', 'cust-only-a').owner_company_id, 'owner-b');
        assert.deepEqual(marginRow(app.db, 'owner-a', 'cust-only-a'), before);

        const selected = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-b' });
        assert.equal(selected.status, 200);
        const asB = await call(app.baseUrl, actor['system-admin'], 'GET', '/api/admin/customers');
        const ownLink = asB.json.customers.find(customer => customer.id === 'cust-only-a');
        assert.equal(ownLink.marginPercent, 12);
        assert.equal(ownLink.status, 'active');
        const previewB = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/customers/cust-only-a/preview', { companyId: 'owner-b' });
        assert.equal(previewB.status, 200, JSON.stringify(previewB.json));
        assert.equal(previewB.json.rates.some(rate => rate.id === 'rate-a' || rate.ownerCompanyId === 'owner-a'), false);
        assert.equal(previewB.json.rates.some(rate => rate.id === 'rate-b'), true);
        const hidden = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/customers/cust-fraction/preview', { companyId: 'owner-b' });
        assert.equal(hidden.status, 404);
        const wrongOwner = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/customers/cust-only-a/authorize', {
            companyId: 'owner-a',
            marginPercent: 12,
            marginNumber: 0
        });
        assert.equal(wrongOwner.status, 409);
        assert.equal(wrongOwner.json.code, 'company_context_mismatch');
        const authorizeB = await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/customers/cust-only-a/revoke', {
            companyId: 'owner-b'
        });
        assert.equal(authorizeB.status, 200);
        assert.equal(marginRow(app.db, 'owner-b', 'cust-only-a').status, 'revoked');
        assert.deepEqual(marginRow(app.db, 'owner-a', 'cust-only-a'), before);
        await call(app.baseUrl, actor['system-admin'], 'POST', '/api/admin/context', { companyId: 'owner-a' });
    });

    it('fails closed when a system admin has no company context', async () => {
        const fresh = await login(app.baseUrl, 'system-admin', PASSWORD);
        const required = await call(app.baseUrl, fresh, 'GET', '/api/admin/customers');
        assert.equal(required.status, 409);
        assert.equal(required.json.code, 'company_context_required');
        const lookup = await call(app.baseUrl, fresh, 'GET', '/api/admin/customers/lookup?q=Customer');
        assert.equal(lookup.status, 409);
    });
});
