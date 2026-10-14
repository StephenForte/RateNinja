'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { FIELDS, PAGE_SIZES, CONFIG_VERSION } = require('../lib/view-fields');
const { MAX_GROUP_FIELDS, MAX_SORT_RULES } = require('../lib/limits');

const PASSWORD = 'sail-the-ocean';

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

async function login(baseUrl, username) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { cookie: cookieHeader(response), csrf: body.csrfToken };
}

async function call(baseUrl, session, method, urlPath, body) {
    const headers = { cookie: session.cookie };
    if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
    let payload;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const response = await fetch(new URL(urlPath, baseUrl), { method, headers, body: payload });
    const text = await response.text();
    let json = null;
    if (text) json = JSON.parse(text);
    return { status: response.status, json };
}

function viewBody(overrides = {}) {
    return {
        columnOrder: FIELDS.map(field => field.id),
        hiddenColumns: [],
        groupBy: [],
        sort: [{ field: 'rateEffectiveDate', direction: 'desc' }],
        pageSize: 20,
        ...overrides
    };
}

function criteria(overrides = {}) {
    return {
        search: '',
        carrier: '',
        originPort: '',
        destinationPort: '',
        contractOwner: '',
        ...overrides
    };
}

describe('r1-05 saved preference API', { concurrency: 1 }, () => {
    let app;
    let member;
    let admin;

    before(async () => {
        app = await startApp({ username: 'r105-owner', role: 'admin' });
        const { setPasswordByUsername } = require('../lib/accounts');
        const companyId = app.company.id;
        function insertUser(id, username, systemAdmin) {
            app.db.prepare(`
                INSERT INTO users (
                    id, username, display_name, company_id, company_reference, company_record_id,
                    admin_screen, company_role, is_system_admin, disabled, session_epoch, rate_view
                ) VALUES (?, ?, ?, ?, ?, ?, 0, 'member', ?, 0, 0, ?)
            `).run(id, username, username, companyId, companyId, companyId, systemAdmin ? 1 : 0, companyId);
            const set = setPasswordByUsername(username, PASSWORD);
            if (!set.ok) throw new Error(set.error || 'Could not set the test password.');
        }
        insertUser('r105-member', 'r105-member', false);
        insertUser('r105-sysadmin', 'r105-sysadmin', true);
        member = await login(app.baseUrl, 'r105-member');
        admin = await login(app.baseUrl, 'r105-sysadmin');
    });

    after(async () => {
        if (app) await app.close();
    });

    it('serves the field allowlist from the shared limits', async () => {
        const { status, json } = await call(app.baseUrl, { cookie: app.cookie, csrf: app.csrf }, 'GET', '/api/preferences/fields');
        assert.equal(status, 200);
        assert.equal(json.fields.length, 14);
        assert.deepEqual(json.fields.map(field => field.id), FIELDS.map(field => field.id));
        assert.deepEqual(json.pageSizes, PAGE_SIZES.slice());
        assert.equal(json.maxGroupFields, MAX_GROUP_FIELDS);
        assert.equal(json.maxSortRules, MAX_SORT_RULES);
        assert.equal(json.configVersion, CONFIG_VERSION);
        const anonymous = await app.request('/api/preferences/fields', { cookie: false });
        assert.equal(anonymous.status, 401);
    });

    it('rejects a date, predictive, or page key in query criteria', async () => {
        for (const extra of [
            { rateEffectiveDate: '2026-01-01' },
            { predictive: true },
            { predictiveAfter: '2027-01-01' },
            { page: 2 }
        ]) {
            const { status, json } = await call(app.baseUrl, { cookie: app.cookie, csrf: app.csrf }, 'POST', '/api/preferences/queries', {
                name: 'Bad criteria',
                criteria: criteria(extra)
            });
            assert.equal(status, 400, JSON.stringify(extra));
            assert.equal(typeof json.error, 'string');
        }
    });

    it('rejects a third group field, a fourth sort rule, and an unknown column', async () => {
        const session = { cookie: app.cookie, csrf: app.csrf };
        const cases = [
            viewBody({ groupBy: ['carrier', 'originPort', 'destinationPort'] }),
            viewBody({
                sort: [
                    { field: 'carrier', direction: 'asc' },
                    { field: 'originPort', direction: 'desc' },
                    { field: 'destinationPort', direction: 'asc' },
                    { field: 'rate20D', direction: 'desc' }
                ]
            }),
            viewBody({ hiddenColumns: ['notAColumn'] }),
            viewBody({ groupBy: ['retiredField'] }),
            viewBody({ sort: [{ field: 'rate20D' }] })
        ];
        for (const view of cases) {
            const { status, json } = await call(app.baseUrl, session, 'POST', '/api/preferences/views', {
                name: 'Bad view',
                view
            });
            assert.equal(status, 400, JSON.stringify(json));
        }
    });

    it('replaces the previous default when a second default is set', async () => {
        const session = { cookie: app.cookie, csrf: app.csrf };
        const first = await call(app.baseUrl, session, 'POST', '/api/preferences/views', {
            name: 'First default',
            view: viewBody(),
            isDefault: true
        });
        assert.equal(first.status, 201);
        assert.equal(first.json.view.isDefault, true);
        const second = await call(app.baseUrl, session, 'POST', '/api/preferences/views', {
            name: 'Second default',
            view: viewBody({ pageSize: 50 }),
            isDefault: true
        });
        assert.equal(second.status, 201);
        const listed = await call(app.baseUrl, session, 'GET', '/api/preferences/views');
        const defaults = listed.json.views.filter(view => view.isDefault);
        assert.equal(defaults.length, 1);
        assert.equal(defaults[0].id, second.json.view.id);
        assert.equal(defaults[0].view.pageSize, 50);
        const cleared = await call(app.baseUrl, session, 'PUT', '/api/preferences/default-view', { id: null });
        assert.equal(cleared.status, 200);
        assert.equal(cleared.json.view, null);
        const after = await call(app.baseUrl, session, 'GET', '/api/preferences/views');
        assert.equal(after.json.views.some(view => view.isDefault), false);
    });

    it('drops a stale field on read and flags needsAttention', async () => {
        const session = { cookie: app.cookie, csrf: app.csrf };
        const created = await call(app.baseUrl, session, 'POST', '/api/preferences/views', {
            name: 'Stale later',
            view: viewBody({ hiddenColumns: ['notes1'], groupBy: ['carrier'] })
        });
        assert.equal(created.status, 201);
        assert.equal(created.json.view.needsAttention, false);
        const id = created.json.view.id;
        const stored = JSON.parse(app.db.prepare('SELECT payload FROM saved_views WHERE id = ?').get(id).payload);
        stored.hiddenColumns.push('retiredField');
        stored.groupBy.push('retiredField');
        stored.columnOrder.push('retiredField');
        app.db.prepare('UPDATE saved_views SET payload = ? WHERE id = ?').run(JSON.stringify(stored), id);
        const read = await call(app.baseUrl, session, 'GET', `/api/preferences/views/${id}`);
        assert.equal(read.status, 200);
        assert.equal(read.json.view.needsAttention, true);
        assert.equal(read.json.view.view.hiddenColumns.includes('retiredField'), false);
        assert.equal(read.json.view.view.groupBy.includes('retiredField'), false);
        assert.equal(read.json.view.view.columnOrder.includes('retiredField'), false);
        assert.equal(read.json.view.view.hiddenColumns.includes('notes1'), true);
        assert.deepEqual(read.json.view.view.groupBy, ['carrier']);
        const raw = JSON.parse(app.db.prepare('SELECT payload FROM saved_views WHERE id = ?').get(id).payload);
        assert.equal(raw.hiddenColumns.includes('retiredField'), true);
    });

    it('hides another user\'s query and view, including from a system admin', async () => {
        const owner = { cookie: app.cookie, csrf: app.csrf };
        const query = await call(app.baseUrl, owner, 'POST', '/api/preferences/queries', {
            name: 'Owner query',
            criteria: criteria({ carrier: 'MSC', search: 'shanghai' })
        });
        assert.equal(query.status, 201);
        const view = await call(app.baseUrl, owner, 'POST', '/api/preferences/views', {
            name: 'Owner view',
            view: viewBody({ groupBy: ['originPort'] })
        });
        assert.equal(view.status, 201);
        const queryId = query.json.query.id;
        const viewId = view.json.view.id;

        for (const outsider of [member, admin]) {
            const queries = await call(app.baseUrl, outsider, 'GET', '/api/preferences/queries');
            const views = await call(app.baseUrl, outsider, 'GET', '/api/preferences/views');
            assert.equal(queries.status, 200);
            assert.equal(views.status, 200);
            assert.equal(queries.json.queries.some(item => item.id === queryId || item.name === 'Owner query'), false);
            assert.equal(views.json.views.some(item => item.id === viewId || item.name === 'Owner view'), false);
            assert.equal((await call(app.baseUrl, outsider, 'GET', `/api/preferences/queries/${queryId}`)).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'PATCH', `/api/preferences/queries/${queryId}`, { name: 'Stolen' })).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'DELETE', `/api/preferences/queries/${queryId}`)).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'GET', `/api/preferences/views/${viewId}`)).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'PATCH', `/api/preferences/views/${viewId}`, { name: 'Stolen view' })).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'DELETE', `/api/preferences/views/${viewId}`)).status, 404);
            assert.equal((await call(app.baseUrl, outsider, 'PUT', '/api/preferences/default-view', { id: viewId })).status, 404);
        }

        const still = await call(app.baseUrl, owner, 'GET', `/api/preferences/queries/${queryId}`);
        assert.equal(still.status, 200);
        assert.equal(still.json.query.name, 'Owner query');
        assert.equal(still.json.query.criteria.carrier, 'MSC');
        const renamed = await call(app.baseUrl, owner, 'PATCH', `/api/preferences/queries/${queryId}`, { name: 'Owner query renamed' });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.json.query.criteria.search, 'shanghai');
        const removed = await call(app.baseUrl, owner, 'DELETE', `/api/preferences/views/${viewId}`);
        assert.equal(removed.status, 204);
        assert.equal((await call(app.baseUrl, owner, 'GET', `/api/preferences/views/${viewId}`)).status, 404);
    });
});
