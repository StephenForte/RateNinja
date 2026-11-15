'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.RATE_NINJA_ADMIN_API_KEY = 'r125-admin-test-key-32chars-xxxxxx';
process.env.NODE_ENV = 'test';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const {
    ADMIN_ROUTES,
    SHORT_KEY,
    EQUAL_KEY,
    DEMO_KEY,
    applyAdminKey,
    applyDemoKey,
    adminGet,
    enableAdminKey
} = require('./helpers/r1-25');

describe('R1-25 admin API fail-closed', { concurrency: 1 }, () => {
    let app;

    before(async () => {
        app = await startApp({ companyName: 'R125 Fail Closed Co' });
        enableAdminKey();
    });

    after(async () => {
        if (app) await app.close();
    });

    beforeEach(() => {
        enableAdminKey();
    });

    async function assertDisabled(keyToSend) {
        for (const route of ADMIN_ROUTES) {
            const result = await adminGet(app.baseUrl, route, { key: keyToSend });
            assert.equal(result.status, 503, route);
            assert.deepEqual(result.body, { error: 'admin_api_disabled' });
            assert.equal(result.body.data, undefined);
            assert.equal(JSON.stringify(result.body).includes('"data"'), false);
        }
    }

    it('returns 503 with no data when the admin key is unset', async () => {
        applyAdminKey(undefined);
        await assertDisabled(undefined);
        await assertDisabled('any-header-value-xxxxxxxxxxxxxxx');
    });

    it('returns 503 with no data when the admin key is 31 characters', async () => {
        applyAdminKey(SHORT_KEY);
        assert.equal(SHORT_KEY.length, 31);
        await assertDisabled(SHORT_KEY);
        await assertDisabled(undefined);
    });

    it('returns 503 with no data when the admin key equals RATE_NINJA_API_KEY', async () => {
        applyDemoKey(EQUAL_KEY);
        applyAdminKey(EQUAL_KEY);
        await assertDisabled(EQUAL_KEY);
        await assertDisabled(DEMO_KEY);
    });
});
