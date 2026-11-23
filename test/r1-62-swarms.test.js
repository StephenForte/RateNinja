'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, before, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { activate, login, call, utcDay, insertCompany, COMPANY_TYPE_CUSTOMER } = require('./helpers/r1-19');
const { seedManagedAgents, BUYER, OTHER_BUYER } = require('./helpers/r1-33');
const { TOKEN_A, TOKEN_B, lane, bookingLane, swarmBody } = require('./helpers/r1-62');

const seenText = [];
const seenCipher = new Set();
let app;
let users;
let sessions;

function noteCipher() {
    for (const row of app.db.prepare('SELECT bbs_token_enc FROM company_swarm_settings').all()) {
        if (row.bbs_token_enc) seenCipher.add(row.bbs_token_enc);
    }
}

async function api(who, method, urlPath, body, options) {
    const result = await call(app.baseUrl, sessions[who], method, urlPath, body, options);
    seenText.push(result.text || '');
    noteCipher();
    return result;
}

function settingsRow(companyId) {
    return app.db.prepare('SELECT * FROM company_swarm_settings WHERE company_id = ?').get(companyId);
}

function swarmSnapshot(id) {
    return {
        swarm: app.db.prepare('SELECT * FROM swarms WHERE id = ?').get(id),
        lanes: app.db.prepare('SELECT * FROM swarm_lanes WHERE swarm_id = ? ORDER BY position').all(id)
    };
}

function swarmCount() {
    return app.db.prepare('SELECT COUNT(*) AS n FROM swarms').get().n;
}

function lastAudit(eventType) {
    const row = app.db.prepare(`
        SELECT detail FROM audit_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1
    `).get(eventType);
    return row ? JSON.parse(row.detail) : null;
}

describe('R1-62 swarm foundation', { concurrency: 1 }, () => {
    before(async () => {
        app = await startApp();
        users = seedManagedAgents(app.db);
        insertCompany(app.db, { id: 'synthetic-park', name: 'Synthetic Park', type: COMPANY_TYPE_CUSTOMER });
        sessions = {};
        for (const [role, username] of Object.entries(users)) {
            activate(username);
            sessions[role] = await login(app.baseUrl, username);
        }
    });

    after(async () => { await app?.close(); });

    it('lists the routes in the API page and the swarm note', () => {
        const page = fs.readFileSync(path.join(__dirname, '../public/api-docs.html'), 'utf8');
        const note = fs.readFileSync(path.join(__dirname, '../docs/managed-agent-swarm.md'), 'utf8');
        for (const route of [
            'GET /api/swarm/access',
            'GET /api/swarms',
            'POST /api/swarms',
            'GET /api/swarms/{id}',
            'PUT /api/swarms/{id}',
            'DELETE /api/swarms/{id}',
            'GET /api/admin/swarm/companies',
            'PUT /api/admin/swarm/companies/{companyId}'
        ]) {
            assert.equal(page.includes(route), true, route);
            assert.equal(note.includes(route), true, route);
        }
    });

    it('refuses admin routes to anyone except a system admin', async () => {
        const before = app.db.prepare('SELECT COUNT(*) AS n FROM company_swarm_settings').get().n;
        for (const who of ['creator', 'companyAdmin', 'member']) {
            const listed = await api(who, 'GET', '/api/admin/swarm/companies');
            const saved = await api(who, 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
                enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_A
            });
            assert.equal(listed.status, 403, who);
            assert.equal(saved.status, 403, who);
            assert.match(listed.json.error, /Administrator/);
        }
        assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM company_swarm_settings').get().n, before);
        const missing = await api('systemAdmin', 'GET', '/api/admin/swarm/companies');
        assert.equal(missing.status, 200, missing.text);
        const buyer = missing.json.companies.find(company => company.companyId === BUYER);
        const parked = missing.json.companies.find(company => company.companyId === 'synthetic-park');
        assert.ok(buyer);
        assert.deepEqual(
            { enabled: buyer.enabled, bbsProject: buyer.bbsProject, hasBbsToken: buyer.hasBbsToken, updatedAt: buyer.updatedAt },
            { enabled: false, bbsProject: null, hasBbsToken: false, updatedAt: null }
        );
        assert.equal(parked.enabled, false);
        assert.equal(missing.json.companies.some(company => company.companyId === 'managed-owner'), false);
        assert.equal(Object.hasOwn(buyer, 'bbsToken'), false);
    });

    it('rejects a contract owner, an unknown company, and an enable that cannot be completed', async () => {
        const owner = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/managed-owner', {
            enabled: true, bbsProject: 'owner.project', bbsToken: TOKEN_A
        });
        assert.equal(owner.status, 422);
        assert.equal(owner.json.code, 'customer_only');
        assert.equal(settingsRow('managed-owner'), undefined);

        const unknown = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/missing-company', {
            enabled: false, bbsProject: null
        });
        assert.equal(unknown.status, 404);

        const incomplete = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/synthetic-park', {
            enabled: true, bbsProject: 'park.project'
        });
        assert.equal(incomplete.status, 422);
        assert.equal(incomplete.json.code, 'swarm_settings_incomplete');
        assert.equal(settingsRow('synthetic-park'), undefined);

        const parked = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/synthetic-park', {
            enabled: false, bbsProject: '  park.project  ', bbsToken: TOKEN_B
        });
        assert.equal(parked.status, 200, parked.text);
        assert.equal(parked.json.company.bbsProject, 'park.project');
        assert.equal(parked.json.company.hasBbsToken, true);
        assert.equal(parked.json.company.enabled, false);
        const stored = settingsRow('synthetic-park');
        const failed = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/synthetic-park', {
            enabled: true, bbsProject: null
        });
        assert.equal(failed.status, 422);
        assert.equal(failed.json.code, 'swarm_settings_incomplete');
        assert.deepEqual(settingsRow('synthetic-park'), stored);
        const badName = await api('systemAdmin', 'PUT', '/api/admin/swarm/companies/synthetic-park', {
            enabled: false, bbsProject: 'Not A Project'
        });
        assert.equal(badName.status, 400);
        assert.deepEqual(settingsRow('synthetic-park'), stored);
    });

    it('keeps, replaces, and clears the credential without returning it', async () => {
        const created = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_A
        });
        assert.equal(created.status, 200, created.text);
        assert.equal(created.json.company.enabled, true);
        assert.equal(created.json.company.hasBbsToken, true);
        assert.deepEqual(Object.keys(created.json.company).sort(), [
            'bbsProject', 'companyId', 'enabled', 'hasBbsToken', 'name', 'updatedAt'
        ]);
        const first = settingsRow(BUYER).bbs_token_enc;
        assert.equal(typeof first, 'string');
        assert.equal(first.includes(TOKEN_A), false);
        const kept = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project'
        });
        assert.equal(kept.status, 200, kept.text);
        assert.equal(settingsRow(BUYER).bbs_token_enc, first);
        assert.equal(lastAudit('swarm_settings_updated').tokenChanged, false);
        assert.equal(lastAudit('swarm_settings_updated').bbsProject, 'buyer.project');

        const replaced = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_B
        });
        assert.equal(replaced.status, 200, replaced.text);
        assert.notEqual(settingsRow(BUYER).bbs_token_enc, first);
        assert.equal(lastAudit('swarm_settings_updated').tokenChanged, true);
        const { readBbsCredentials } = require('../lib/swarm-secrets');
        assert.equal(readBbsCredentials(BUYER).bbsToken, TOKEN_B);

        const cleared = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: false, bbsProject: 'buyer.project', bbsToken: null
        });
        assert.equal(cleared.status, 200, cleared.text);
        assert.equal(cleared.json.company.hasBbsToken, false);
        assert.equal(settingsRow(BUYER).bbs_token_enc, null);
        assert.equal(readBbsCredentials(BUYER), null);
        assert.equal(lastAudit('swarm_settings_updated').tokenChanged, true);

        const restored = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_A
        });
        assert.equal(restored.status, 200, restored.text);
        await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${OTHER_BUYER}`, {
            enabled: true, bbsProject: 'other.project', bbsToken: TOKEN_A
        });
        const csrf = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_A
        }, { csrf: false });
        assert.equal(csrf.status, 403);
    });

    it('reports access from the caller company and stores swarms under companies.id', async () => {
        assert.deepEqual((await api('creator', 'GET', '/api/swarm/access')).json, { enabled: true });
        assert.deepEqual((await api('owner', 'GET', '/api/swarm/access')).json, { enabled: false });
        assert.deepEqual((await api('companyless', 'GET', '/api/swarm/access')).json, { enabled: false });
        assert.deepEqual((await api('systemAdmin', 'GET', '/api/swarm/access')).json, { enabled: true });
        const created = await api('creator', 'POST', '/api/swarms', swarmBody({ name: '  Company lane  ' }));
        assert.equal(created.status, 201, created.text);
        assert.equal(created.json.swarm.companyId, BUYER);
        assert.equal(created.json.swarm.name, 'Company lane');
        assert.equal(created.json.swarm.canEdit, true);
        assert.equal(app.db.prepare('SELECT company_id FROM users WHERE id = ?').get(users.creator).company_id, '3.0');
        assert.equal(app.db.prepare('SELECT company_id FROM swarms WHERE id = ?').get(created.json.swarm.id).company_id, BUYER);
        const detail = lastAudit('swarm_created');
        assert.equal(detail.companyId, BUYER);
        assert.equal(detail.swarmId, created.json.swarm.id);
        assert.equal(JSON.stringify(detail).includes('Synthetic instructions'), false);
    });

    it('hides another company swarm behind the same 404 as a missing id', async () => {
        const owned = await api('creator', 'POST', '/api/swarms', swarmBody({ name: 'Buyer only' }));
        const foreign = await api('otherBuyer', 'POST', '/api/swarms', swarmBody({ name: 'Other only' }));
        assert.equal(owned.status, 201, owned.text);
        assert.equal(foreign.status, 201, foreign.text);
        const missing = await api('creator', 'GET', '/api/swarms/missing-swarm-id');
        for (const [who, id] of [['creator', foreign.json.swarm.id], ['otherBuyer', owned.json.swarm.id]]) {
            for (const method of ['GET', 'PUT', 'DELETE']) {
                const result = await api(who, method, `/api/swarms/${id}`, method === 'GET' ? undefined : swarmBody());
                assert.equal(result.status, 404, `${who} ${method}`);
                assert.deepEqual(result.json, missing.json);
            }
        }
        const listed = await api('creator', 'GET', '/api/swarms');
        assert.equal(listed.status, 200);
        assert.equal(listed.json.swarms.some(swarm => swarm.id === foreign.json.swarm.id), false);
        assert.equal(listed.json.swarms.some(swarm => swarm.id === owned.json.swarm.id), true);
        assert.deepEqual(swarmSnapshot(foreign.json.swarm.id).swarm.name, 'Other only');
    });

    it('blocks every swarm route while the company is disabled and leaves stored rows unchanged', async () => {
        const created = await api('otherBuyer', 'POST', '/api/swarms', swarmBody({ name: 'Parked swarm' }));
        assert.equal(created.status, 201, created.text);
        const id = created.json.swarm.id;
        const before = swarmSnapshot(id);
        const disabled = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${OTHER_BUYER}`, {
            enabled: false, bbsProject: 'other.project'
        });
        assert.equal(disabled.status, 200, disabled.text);
        assert.deepEqual((await api('otherBuyer', 'GET', '/api/swarm/access')).json, { enabled: false });
        const calls = [
            ['GET', '/api/swarms', undefined],
            ['POST', '/api/swarms', swarmBody({ name: 'Should not save' })],
            ['GET', `/api/swarms/${id}`, undefined],
            ['PUT', `/api/swarms/${id}`, swarmBody({ name: 'Should not change' })],
            ['DELETE', `/api/swarms/${id}`, undefined]
        ];
        for (const [method, urlPath, body] of calls) {
            const result = await api('otherBuyer', method, urlPath, body);
            assert.equal(result.status, 403);
            assert.equal(result.json.code, 'swarm_not_enabled');
        }
        assert.deepEqual(swarmSnapshot(id), before);
        assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM swarms WHERE name = 'Should not save'").get().n, 0);
        const enabled = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${OTHER_BUYER}`, {
            enabled: true, bbsProject: 'other.project'
        });
        assert.equal(enabled.status, 200, enabled.text);
    });

    it('lets the creator or a company admin edit, and a system admin who is only a member read', async () => {
        const created = await api('member', 'POST', '/api/swarms', swarmBody({ name: 'Member swarm' }));
        assert.equal(created.status, 201, created.text);
        const id = created.json.swarm.id;
        const listed = await api('creator', 'GET', '/api/swarms');
        const row = listed.json.swarms.find(swarm => swarm.id === id);
        assert.equal(row.canEdit, false);
        assert.equal((await api('companyAdmin', 'GET', `/api/swarms/${id}`)).json.swarm.canEdit, true);
        const forbidden = await api('creator', 'PUT', `/api/swarms/${id}`, swarmBody({ name: 'Taken over' }));
        assert.equal(forbidden.status, 403);
        const adminForbidden = await api('systemAdmin', 'DELETE', `/api/swarms/${id}`);
        assert.equal(adminForbidden.status, 403);
        const edited = await api('companyAdmin', 'PUT', `/api/swarms/${id}`, swarmBody({ name: 'Admin edit' }));
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.json.swarm.name, 'Admin edit');
        assert.equal(edited.json.swarm.createdByUserId, users.member);
        const removed = await api('member', 'DELETE', `/api/swarms/${id}`);
        assert.equal(removed.status, 204);
        assert.equal((await api('member', 'GET', `/api/swarms/${id}`)).status, 404);
        assert.equal(lastAudit('swarm_deleted').swarmId, id);
        assert.equal(JSON.stringify(lastAudit('swarm_updated')).includes('Admin edit'), false);
    });

    it('refuses a lane the managed-agent form would refuse, with the same message', async () => {
        const rows = [
            lane({ containerType: '20D' }),
            lane({ containerType: '40D' }),
            lane({ containerType: '40HC', sailingDate: utcDay(-3) })
        ];
        const agent = await api('creator', 'POST', '/api/managed-agents', rows);
        const swarm = await api('creator', 'POST', '/api/swarms', swarmBody({ lanes: rows }));
        assert.equal(agent.status, 400, agent.text);
        assert.equal(swarm.status, 400, swarm.text);
        assert.equal(swarm.json.error, agent.json.error);
        assert.equal(swarm.json.position, 3);
        assert.match(swarm.json.error, /^Row 3: /);
        const savedQuery = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: [lane({ savedQueryId: 'not-a-query' })]
        }));
        assert.equal(savedQuery.status, 400);
        assert.match(savedQuery.json.error, /saved query/i);
    });

    it('leaves the previous swarm intact when a later lane is invalid', async () => {
        const created = await api('creator', 'POST', '/api/swarms', swarmBody({
            name: 'Atomic',
            lanes: [lane({ containerType: '20D' }), lane({ containerType: '40D' })]
        }));
        assert.equal(created.status, 201, created.text);
        const id = created.json.swarm.id;
        const before = swarmSnapshot(id);
        const audits = app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'swarm_updated'").get().n;
        const result = await api('creator', 'PUT', `/api/swarms/${id}`, swarmBody({
            name: 'Broken replacement',
            instructions: 'this replacement must not be stored',
            lanes: [
                lane({ containerType: '20D' }),
                lane({ containerType: '40D' }),
                lane({ sailingDate: 'not-a-date' })
            ]
        }));
        assert.equal(result.status, 400, result.text);
        assert.equal(result.json.position, 3);
        assert.deepEqual(swarmSnapshot(id), before);
        assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'swarm_updated'").get().n, audits);
    });

    it('requires both caps exactly when a lane allows booking, and accepts 1 to 25 lanes', async () => {
        const before = swarmCount();
        const missingCaps = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: [bookingLane()], totalSpendCap: null, totalSlotsCap: null
        }));
        assert.equal(missingCaps.status, 400, missingCaps.text);
        const spendOnly = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: [bookingLane()], totalSpendCap: 10, totalSlotsCap: null
        }));
        assert.equal(spendOnly.status, 400);
        const open = await api('creator', 'POST', '/api/swarms', swarmBody({
            totalSpendCap: null, totalSlotsCap: null
        }));
        assert.equal(open.status, 201, open.text);
        assert.equal(open.json.swarm.totalSpendCap, null);
        assert.equal(open.json.swarm.totalSlotsCap, null);
        const booked = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: [bookingLane()], totalSpendCap: 10.5, totalSlotsCap: 10000
        }));
        assert.equal(booked.status, 201, booked.text);
        assert.equal(booked.json.swarm.totalSpendCap, 10.5);
        assert.equal(booked.json.swarm.totalSlotsCap, 10000);
        assert.equal(booked.json.swarm.lanes[0].allowBookingRequest, true);
        assert.equal(booked.json.swarm.lanes[0].acceptMaxSlots, true);
        const tooManySlots = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: [bookingLane()], totalSpendCap: 10, totalSlotsCap: 10001
        }));
        assert.equal(tooManySlots.status, 400);
        const optionalCaps = await api('creator', 'POST', '/api/swarms', swarmBody({
            totalSpendCap: 4, totalSlotsCap: 2
        }));
        assert.equal(optionalCaps.status, 201, optionalCaps.text);
        const none = await api('creator', 'POST', '/api/swarms', swarmBody({ lanes: [] }));
        const tooMany = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: Array.from({ length: 26 }, () => lane())
        }));
        assert.equal(none.status, 400);
        assert.equal(tooMany.status, 400);
        const full = await api('creator', 'POST', '/api/swarms', swarmBody({
            lanes: Array.from({ length: 25 }, () => lane())
        }));
        assert.equal(full.status, 201, full.text);
        assert.deepEqual(full.json.swarm.lanes.map(item => item.position), Array.from({ length: 25 }, (_, index) => index + 1));
        assert.equal(swarmCount(), before + 4);
    });

    it('returns instructions byte for byte as JSON', async () => {
        const instructions = '<p class="note">Alpha & Beta</p><script>alert("swarm")</script>';
        const response = await fetch(new URL('/api/swarms', app.baseUrl), {
            method: 'POST',
            headers: {
                cookie: sessions.creator.cookie,
                'x-csrf-token': sessions.creator.csrf,
                'content-type': 'application/json'
            },
            body: JSON.stringify(swarmBody({ instructions }))
        });
        const text = await response.text();
        seenText.push(text);
        noteCipher();
        assert.equal(response.status, 201);
        assert.match(response.headers.get('content-type'), /^application\/json/);
        assert.equal(JSON.parse(text).swarm.instructions, instructions);
        assert.equal(text.includes('<script>'), true);
        assert.equal(text.includes('&lt;script&gt;'), false);
        assert.equal(text.includes('\\u003c'), false);
        const exact = 'x'.repeat(20000);
        const accepted = await api('creator', 'POST', '/api/swarms', swarmBody({ instructions: exact }));
        assert.equal(accepted.status, 201, accepted.text);
        assert.equal(accepted.json.swarm.instructions, exact);
        const rejected = await api('creator', 'POST', '/api/swarms', swarmBody({ instructions: `${exact}y` }));
        assert.equal(rejected.status, 400);
    });

    it('treats a credential written under another session secret, or a broken ciphertext, as unset', async () => {
        const { config } = require('../lib/config');
        const { readBbsCredentials } = require('../lib/swarm-secrets');
        assert.equal(readBbsCredentials(BUYER).bbsProject, 'buyer.project');
        const saved = config.sessionSecret;
        config.sessionSecret = 'different-session-secret-value-which-is-long';
        try {
            assert.equal(readBbsCredentials(BUYER), null);
            const rotated = await login(app.baseUrl, 'managed-systemAdmin');
            const listed = await call(app.baseUrl, rotated, 'GET', '/api/admin/swarm/companies');
            seenText.push(listed.text || '');
            assert.equal(listed.status, 200, listed.text);
            assert.equal(listed.json.companies.find(company => company.companyId === BUYER).hasBbsToken, false);
        } finally {
            config.sessionSecret = saved;
        }
        const current = settingsRow(BUYER).bbs_token_enc;
        seenCipher.add(current);
        const broken = `${current.slice(0, 20)}${current[20] === 'a' ? 'b' : 'a'}${current.slice(21)}`;
        app.db.prepare('UPDATE company_swarm_settings SET bbs_token_enc = ? WHERE company_id = ?').run(broken, BUYER);
        seenCipher.add(broken);
        const afterBreak = await api('systemAdmin', 'GET', '/api/admin/swarm/companies');
        assert.equal(afterBreak.status, 200, afterBreak.text);
        assert.equal(afterBreak.json.companies.find(company => company.companyId === BUYER).hasBbsToken, false);
        assert.equal(readBbsCredentials(BUYER), null);
        const repaired = await api('systemAdmin', 'PUT', `/api/admin/swarm/companies/${BUYER}`, {
            enabled: true, bbsProject: 'buyer.project', bbsToken: TOKEN_A
        });
        assert.equal(repaired.status, 200, repaired.text);
        assert.equal(repaired.json.company.hasBbsToken, true);
    });

    it('never writes the credential or its ciphertext into a response or an audit row', () => {
        noteCipher();
        const audits = app.db.prepare('SELECT * FROM audit_events').all().map(row => JSON.stringify(row));
        const haystack = [...seenText, ...audits].join('\n');
        assert.ok(seenCipher.size >= 2);
        for (const secret of [TOKEN_A, TOKEN_B, ...seenCipher]) {
            assert.equal(haystack.includes(secret), false, secret.slice(0, 12));
        }
    });
});
