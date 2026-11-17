'use strict';
process.env.NODE_ENV = 'test';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp } = require('./helpers/app');
const { insertCompany, insertUser, insertMargin, activate, login, call,
    COMPANY_TYPE_CUSTOMER: CUSTOMER } = require('./helpers/r1-19');
const { createKey } = require('./helpers/r1-31');
const PATH = '/api/account/api-keys';

describe('R1-31 per-buyer key lifecycle', () => {
    let app, a, b, ka, kb;
    const logs = [];
    let originalLog, originalError;
    async function partner(key, path = '/profile') {
        const response = await fetch(app.baseUrl + '/api/partner/v1/me' + path, { headers: { 'X-Buyer-API-Key': key } });
        return { status: response.status, json: await response.json() };
    }
    before(async () => {
        app = await startApp();
        for (const id of ['a', 'b']) {
            insertCompany(app.db, { id: 'company-' + id, name: 'Synthetic ' + id, type: CUSTOMER });
            insertUser(app.db, { id: 'user-' + id, username: 'buyer-' + id, companyId: 'company-' + id });
            activate('buyer-' + id);
        }
        a = await login(app.baseUrl, 'buyer-a');
        b = await login(app.baseUrl, 'buyer-b');
        insertMargin(app.db, { id: 'link-a', owner: app.company.id, customer: 'company-a', percent: 0.1 });
        app.db.prepare(`INSERT INTO sailings (id, owner_company_id, carrier, departure_port, departure)
            VALUES ('a-sailing', ?, 'MSC', 'SHA', '2027-01-02')`).run(app.company.id);
        originalLog = console.log; originalError = console.error;
        console.log = (...args) => { logs.push(args.join(' ')); };
        console.error = (...args) => { logs.push(args.join(' ')); };
        ka = await createKey(app.baseUrl, a, '<label A>');
        kb = await createKey(app.baseUrl, b, 'Buyer B');
    });
    after(async () => {
        console.log = originalLog; console.error = originalError;
        if (app) await app.close();
    });

    it('resolves two buyers independently, uses live sailing visibility and records last use', async () => {
        assert.equal(app.db.prepare('SELECT last_used_at FROM buyer_api_keys WHERE id=?').get(ka.apiKey.id).last_used_at, null);
        for (const [key, user] of [[ka, 'user-a'], [kb, 'user-b']]) {
            const profile = await partner(key.key);
            assert.equal(profile.status, 200);
            assert.equal(profile.json.sub, user);
            assert.ok(app.db.prepare('SELECT last_used_at FROM buyer_api_keys WHERE id=?').get(key.apiKey.id).last_used_at);
        }
        assert.deepEqual((await partner(ka.key, '/sailings')).json.data.map(s => s.id), ['a-sailing']);
        assert.deepEqual((await partner(kb.key, '/sailings')).json.data, []);
    });

    it('discloses the key once and stores only hashes; lists and audit carry no key or hash', async () => {
        assert.match(ka.key, /^rnb_[A-Za-z0-9_-]{43}$/);
        assert.equal(JSON.stringify(ka).split(ka.key).length - 1, 1);
        const stored = app.db.prepare('SELECT * FROM buyer_api_keys WHERE id=?').get(ka.apiKey.id);
        assert.equal(stored.key_hash, crypto.createHash('sha256').update(ka.key).digest('hex'));
        assert.equal(stored.key_prefix, ka.key.slice(4, 12));
        assert.equal(JSON.stringify(stored).includes(ka.key), false);
        for (const [session, key] of [[a, ka], [b, kb]]) {
            const list = await call(app.baseUrl, session, 'GET', PATH);
            assert.equal(list.status, 200);
            assert.deepEqual(list.json.keys.map(row => row.id), [key.apiKey.id]);
            assert.equal(list.text.includes(key.key), false);
            assert.equal(list.text.includes(stored.key_hash), false);
            assert.equal(list.text.includes('key_hash'), false);
        }
        const audit = app.db.prepare("SELECT * FROM audit_events WHERE event_type LIKE 'buyer_api_key_%'").all();
        assert.equal(audit.length, 2);
        for (const row of audit) assert.deepEqual(Object.keys(JSON.parse(row.detail)).sort(), ['keyId', 'prefix']);
        for (const key of [ka.key, kb.key]) {
            assert.equal(JSON.stringify(audit).includes(key), false);
            assert.equal(logs.join('\n').includes(key), false);
        }
    });

    it('enforces ownership on listing and revocation, including idempotent revoke', async () => {
        assert.equal((await call(app.baseUrl, a, 'DELETE', PATH + '/' + kb.apiKey.id)).status, 404);
        assert.equal((await partner(kb.key)).status, 200);
        assert.equal((await call(app.baseUrl, a, 'GET', PATH)).text.includes(kb.apiKey.id), false);
        const doomed = await createKey(app.baseUrl, a, 'Revoke me');
        for (let i = 0; i < 2; i++) assert.equal((await call(app.baseUrl, a, 'DELETE', PATH + '/' + doomed.apiKey.id)).status, 200);
        const invalid = await partner(doomed.key);
        assert.equal(invalid.status, 401); assert.equal(invalid.json.error, 'invalid_token');
        assert.equal(invalid.json.data, undefined);
        const events = app.db.prepare("SELECT detail FROM audit_events WHERE event_type='buyer_api_key_revoked'").all();
        assert.equal(events.length, 1);
        assert.deepEqual(JSON.parse(events[0].detail), { keyId: doomed.apiKey.id, prefix: doomed.apiKey.key_prefix });
        assert.equal(JSON.stringify(events).includes(doomed.key), false);
        const listed = await call(app.baseUrl, a, 'GET', PATH);
        assert.ok(listed.json.keys.find(key => key.id === doomed.apiKey.id).revoked_at);
    });

    it('requires a customer session and CSRF for create and revoke', async () => {
        for (const [method, path, body] of [['POST', PATH, { label: 'No CSRF' }], ['DELETE', PATH + '/' + ka.apiKey.id, undefined]]) {
            assert.equal((await call(app.baseUrl, a, method, path, body, { csrf: false })).status, 403);
            assert.equal((await call(app.baseUrl, null, method, path, body)).status, 401);
        }
        for (const method of ['GET', 'POST', 'DELETE']) {
            assert.equal((await call(app.baseUrl, app, method, method === 'DELETE' ? PATH + '/' + ka.apiKey.id : PATH, method === 'POST' ? { label: 'Owner' } : undefined)).status, 403);
        }
        assert.equal((await partner(ka.key)).status, 200);
    });

    it('validates labels and does not echo secret-looking invalid input', async () => {
        for (const label of [undefined, null, '', '  ', 17, 'x'.repeat(81)]) {
            assert.equal((await call(app.baseUrl, a, 'POST', PATH, { label })).status, 400);
        }
        const accepted = await createKey(app.baseUrl, a, 'x'.repeat(80));
        assert.equal(accepted.apiKey.label.length, 80);
        await call(app.baseUrl, a, 'DELETE', PATH + '/' + accepted.apiKey.id);
    });

    it('allows at most five active keys under concurrent creates and releases a slot on revoke', async () => {
        const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call(app.baseUrl, b, 'POST', PATH, { label: 'Concurrent ' + i })));
        assert.deepEqual(results.map(r => r.status).sort(), [201, 201, 201, 201, 409]);
        assert.equal(results.find(r => r.status === 409).json.error, 'active_key_limit');
        await call(app.baseUrl, b, 'DELETE', PATH + '/' + results.find(r => r.status === 201).json.apiKey.id);
        await createKey(app.baseUrl, b, 'Replacement');
    });

    it('denies demoted or disabled owners immediately without advancing last-used', async () => {
        const before = app.db.prepare('SELECT last_used_at FROM buyer_api_keys WHERE id=?').get(ka.apiKey.id).last_used_at;
        app.db.prepare("UPDATE companies SET company_type='Contract Owner', company_type_id='contract_owner' WHERE id='company-a'").run();
        try {
            const response = await partner(ka.key);
            assert.equal(response.status, 403); assert.equal(response.json.data, undefined);
            assert.equal((await call(app.baseUrl, a, 'POST', PATH, { label: 'Demoted' })).status, 403);
        } finally { app.db.prepare("UPDATE companies SET company_type=?, company_type_id='freight_forwarder_customer' WHERE id='company-a'").run(CUSTOMER); }
        app.db.prepare("UPDATE users SET disabled=1 WHERE id='user-a'").run();
        try { assert.equal((await partner(ka.key)).status, 403); }
        finally { app.db.prepare("UPDATE users SET disabled=0 WHERE id='user-a'").run(); }
        assert.equal(app.db.prepare('SELECT last_used_at FROM buyer_api_keys WHERE id=?').get(ka.apiKey.id).last_used_at, before);
    });

    it('shows the API keys section only to signed-in customer users', async () => {
        const { sectionById } = await import('../public/js/registry.js');
        const section = sectionById('api-keys');
        assert.equal(section.path, '/profile/api-keys');
        for (const companyType of [CUSTOMER, 'Contract Owner', '', 'Unsupported']) {
            assert.equal(section.allow({ signedIn: true, companyType }), companyType === CUSTOMER);
        }
        assert.equal(section.allow({ signedIn: false, companyType: CUSTOMER }), false);
    });
});
