const { freezeClock } = require('./helpers/r1-12');
freezeClock();

process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { cookieHeader, insertCompany, insertUser, insertRate } = require('./helpers/r1-12');

// Captured from origin/main (d264f95) on 2026-10-13 with the clock frozen at
// 2026-10-13T12:00:00.000Z, before the predictive functions moved. The demo and
// app handlers must keep these response bytes.
const GOLDEN = {
    ownerSuccess: '{"rates":[{"id":"new-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1595,"rate40D":3045,"rate40HC":3190,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"newer","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"sha-nyc","rateType":"FAK","originPort":"SHA","destinationPort":"NYC","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1305,"rate40D":2320,"rate40HC":2465,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"nyc","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"cma-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"CMA","contractOwner":"Golden Owner","rate20D":1160,"rate40D":2175,"rate40HC":2248,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"cma","predictive":true,"ownerCompanyName":"Golden Owner"}]}',
    customerSuccess: '{"rates":[{"id":"new-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1755,"rate40D":3350,"rate40HC":3509,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"newer","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"sha-nyc","rateType":"FAK","originPort":"SHA","destinationPort":"NYC","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1436,"rate40D":2552,"rate40HC":2712,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"nyc","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"cma-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"CMA","contractOwner":"Golden Owner","rate20D":1276,"rate40D":2393,"rate40HC":2473,"rateEffectiveDate":"2027-07-13","rateExpirationDate":"N/A","notes1":"cma","predictive":true,"ownerCompanyName":"Golden Owner"}]}',
    demoSuccess: '{"data":[{"carrier":"MSC","originPort":"SHA","destinationPort":"LAX","arrival":"","departingAfter":"2027-07-13","rate20D":7250,"rate40D":7250,"rate40HC":7250},{"carrier":"MSC","originPort":"SHA","destinationPort":"NYC","arrival":"","departingAfter":"2027-07-13","rate20D":1305,"rate40D":2320,"rate40HC":2465}],"meta":{"total":2}}',
    ownerExactly91: '{"rates":[{"id":"new-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1265,"rate40D":2415,"rate40HC":2530,"rateEffectiveDate":"2027-01-12","rateExpirationDate":"N/A","notes1":"newer","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"sha-nyc","rateType":"FAK","originPort":"SHA","destinationPort":"NYC","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"MSC","contractOwner":"Golden Owner","rate20D":1035,"rate40D":1840,"rate40HC":1955,"rateEffectiveDate":"2027-01-12","rateExpirationDate":"N/A","notes1":"nyc","predictive":true,"ownerCompanyName":"Golden Owner"},{"id":"cma-sha-lax","rateType":"FAK","originPort":"SHA","destinationPort":"LAX","inlandDeliveryLocation":"Dallas","commodityType":"General","carrier":"CMA","contractOwner":"Golden Owner","rate20D":920,"rate40D":1725,"rate40HC":1782,"rateEffectiveDate":"2027-01-12","rateExpirationDate":"N/A","notes1":"cma","predictive":true,"ownerCompanyName":"Golden Owner"}]}',
    demoExactly91: '{"data":[{"carrier":"MSC","originPort":"SHA","destinationPort":"LAX","arrival":"","departingAfter":"2027-01-12","rate20D":5750,"rate40D":5750,"rate40HC":5750},{"carrier":"MSC","originPort":"SHA","destinationPort":"NYC","arrival":"","departingAfter":"2027-01-12","rate20D":1035,"rate40D":1840,"rate40HC":1955}],"meta":{"total":2}}',
    tooSoon: '{"error":"Departing after must be more than 90 days in the future."}',
    demoMissing: '{"error":"Carrier, originPort, and after query parameters are required."}'
};

describe('predictive golden responses', () => {
    let app;
    let customerCookie;

    before(async () => {
        app = await startApp({ companyName: 'Golden Owner', username: 'golden-owner' });
        const db = app.db;
        insertCompany(db, {
            id: 'golden-customer',
            name: 'Golden Customer',
            type: 'Freight Forwarder/Customer',
            typeId: 'freight_forwarder_customer'
        });
        insertCompany(db, {
            id: 'golden-other',
            name: 'Golden Other',
            type: 'Contract Owner',
            typeId: 'contract_owner',
            admin: 1
        });
        insertUser(db, { id: 'user-customer', username: 'golden-customer', companyId: 'golden-customer' });
        const { setPasswordByUsername } = require('../lib/accounts');
        assert.equal(setPasswordByUsername('golden-customer', 'sail-the-ocean').ok, true);
        const store = require('../lib/store');
        store.upsertCompanyMargin(app.company.id, 'golden-customer', { marginPercent: 0.1, marginNumber: 0 });
        const owner = app.company.id;
        const base = { inland: 'Dallas', contractOwner: 'Golden Owner' };
        insertRate(db, { ...base, id: 'old-sha-lax', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1000, d40: 1800, d40hc: 1900, expiration: '2026-01-01', owner, notes: 'older' });
        insertRate(db, { ...base, id: 'new-sha-lax', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 1100, d40: 2100, d40hc: 2200, expiration: '2026-12-01', owner, notes: 'newer' });
        insertRate(db, { ...base, id: 'sha-nyc', origin: 'SHA', destination: 'NYC', carrier: 'MSC', d20: 900, d40: 1600, d40hc: 1700, expiration: '2026-08-01', owner, notes: 'nyc' });
        insertRate(db, { ...base, id: 'cma-sha-lax', origin: 'SHA', destination: 'LAX', carrier: 'CMA', d20: 800, d40: 1500, d40hc: 1550, expiration: '2026-09-01', owner, notes: 'cma' });
        insertRate(db, { ...base, id: 'other-owner-rate', origin: 'SHA', destination: 'LAX', carrier: 'MSC', d20: 5000, d40: 5000, d40hc: 5000, expiration: '2027-01-01', owner: 'golden-other', contractOwner: 'Golden Other', notes: 'other' });
        const login = await fetch(`${app.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'golden-customer', password: 'sail-the-ocean' })
        });
        assert.equal(login.status, 200);
        customerCookie = cookieHeader(login);
    });

    after(async () => {
        if (app) await app.close();
    });

    async function body(path, headers) {
        const response = await fetch(`${app.baseUrl}${path}`, { headers });
        return { status: response.status, text: await response.text() };
    }

    it('keeps the owner, customer, and demo success bodies', async () => {
        const owner = await body('/api/rates/predictive?after=2027-07-13', { cookie: app.cookie });
        const customer = await body('/api/rates/predictive?after=2027-07-13', { cookie: customerCookie });
        const demo = await body('/api/v1/predictive-pricing?carrier=MSC&originPort=SHA&after=2027-07-13', { 'x-api-key': 'demo-key' });
        assert.equal(owner.status, 200);
        assert.equal(customer.status, 200);
        assert.equal(demo.status, 200);
        assert.equal(owner.text, GOLDEN.ownerSuccess);
        assert.equal(customer.text, GOLDEN.customerSuccess);
        assert.equal(demo.text, GOLDEN.demoSuccess);
    });

    it('keeps the 91-day bodies and rejects exactly 90 days', async () => {
        const owner91 = await body('/api/rates/predictive?after=2027-01-12', { cookie: app.cookie });
        const demo91 = await body('/api/v1/predictive-pricing?carrier=MSC&originPort=SHA&after=2027-01-12', { 'x-api-key': 'demo-key' });
        const owner90 = await body('/api/rates/predictive?after=2027-01-11', { cookie: app.cookie });
        const demo90 = await body('/api/v1/predictive-pricing?carrier=MSC&originPort=SHA&after=2027-01-11', { 'x-api-key': 'demo-key' });
        const bad = await body('/api/rates/predictive?after=not-a-date', { cookie: app.cookie });
        const demoBad = await body('/api/v1/predictive-pricing?carrier=MSC&originPort=SHA&after=not-a-date', { 'x-api-key': 'demo-key' });
        const missing = await body('/api/v1/predictive-pricing?carrier=MSC&after=2027-07-13', { 'x-api-key': 'demo-key' });
        assert.equal(owner91.status, 200);
        assert.equal(demo91.status, 200);
        assert.equal(owner91.text, GOLDEN.ownerExactly91);
        assert.equal(demo91.text, GOLDEN.demoExactly91);
        assert.equal(owner90.status, 400);
        assert.equal(demo90.status, 400);
        assert.equal(bad.status, 400);
        assert.equal(demoBad.status, 400);
        assert.equal(owner90.text, GOLDEN.tooSoon);
        assert.equal(demo90.text, GOLDEN.tooSoon);
        assert.equal(bad.text, GOLDEN.tooSoon);
        assert.equal(demoBad.text, GOLDEN.tooSoon);
        assert.equal(missing.status, 400);
        assert.equal(missing.text, GOLDEN.demoMissing);
    });
});
