'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { utcDay } = require('./helpers/r1-19');
const { applyAdminKey } = require('./helpers/r1-25');
const { ADMIN_KEY, ROOT, seedSampleWorld } = require('./helpers/r1-42');

let app;
let world;
let managedAgents;

before(async () => {
    app = await startApp();
    world = seedSampleWorld(app.db);
    managedAgents = require('../lib/managed-agents');
    applyAdminKey(ADMIN_KEY);
});
after(async () => { await app?.close(); });

it('preserves the baseline seeded preview and chooses the new pair from qualifying customer prices', () => {
    // Captured on ab0ad65 with seedSampleWorld and this seed. Only the synthetic
    // date origin is relative to the run date.
    const baseline = [
        {
            sampleKind: 'lowball', rateType: 'Port to Port', originPort: 'SIN', destinationPort: 'NYC',
            sailingDate: utcDay(20), containerType: '40D', allowAlternativeRoutes: false,
            allowBookingRequest: true, priceMin: 0, priceMax: 3396, bookingSlots: 2
        },
        {
            sampleKind: 'regular', rateType: 'Port to Port', originPort: 'SHA', destinationPort: 'OAK',
            sailingDate: utcDay(9), containerType: '40D', allowAlternativeRoutes: false,
            allowBookingRequest: true, priceMin: 0, priceMax: 10467, bookingSlots: 3
        },
        {
            sampleKind: 'no_booking', rateType: 'Port to Port', originPort: 'SIN', destinationPort: 'NYC',
            sailingDate: utcDay(7), containerType: '40HC', allowAlternativeRoutes: true,
            allowBookingRequest: false, priceMin: null, priceMax: null, bookingSlots: null
        }
    ];
    app.db.exec(`
        UPDATE rates SET max_slots_allowed = 0 WHERE id LIKE 'sample-%';
        UPDATE rates SET max_slots_allowed = 3 WHERE id = 'sample-sha-oak-low';
    `);
    const userId = world.users.alan.id;
    const seed = 'r1-61-baseline';
    const preview = managedAgents.previewSampleAgents(userId, { seed });
    assert.equal(preview.agents.length, 5);
    assert.equal(JSON.stringify(preview.agents.slice(0, 3)), JSON.stringify(baseline));

    const pair = preview.agents.slice(3);
    const common = {
        rateType: 'Port to Port', originPort: 'SHA', destinationPort: 'OAK', sailingDate: pair[0].sailingDate,
        containerType: '40D', allowAlternativeRoutes: false, allowBookingRequest: true,
        priceMin: 0, priceMax: 10467, bookingSlots: 12
    };
    assert.deepEqual(pair, [
        { sampleKind: 'slots_over_skip', ...common, acceptMaxSlots: false },
        { sampleKind: 'slots_over_accept', ...common, acceptMaxSlots: true }
    ]);
    const { agents } = managedAgents.createSampleAgents(userId, { seed });
    assert.equal(agents.length, 5);
    const [skip, accept] = agents.slice(3).map(agent => managedAgents.matchesForAdmin(agent.id, null).matches);
    assert.equal(skip.length, 2);
    assert.ok(skip.every(match => !match.bookable));
    const capped = accept.find(match => match.rateId === 'sample-sha-oak-low');
    assert.deepEqual([capped.maxSlotsAllowed, capped.bookable, capped.slotsToBook], [3, true, 3]);
});

it('returns 422 and queues nothing when the only matching rate has a zero maximum', async () => {
    app.db.prepare('UPDATE rates SET max_slots_allowed = 0 WHERE id = ?').run('sample-edge');
    const userId = world.users.edge.id;
    const headers = { 'x-admin-api-key': ADMIN_KEY, 'content-type': 'application/json' };
    for (const [path, method, body] of [
        ['/samples?userId=' + userId, 'GET', undefined],
        ['/samples', 'POST', JSON.stringify({ userId })]
    ]) {
        const response = await app.request(ROOT + path, { method, body, headers, cookie: false, csrf: false });
        assert.equal(response.status, 422);
        assert.match((await response.json()).error, /maximum of 1 to 11 slots/);
    }
    const count = app.db.prepare('SELECT count(*) AS n FROM managed_agents WHERE created_by_user_id = ?').get(userId);
    assert.equal(count.n, 0);
});

it('excludes sample lanes where a matching rate can take all 12 slots', async () => {
    app.db.exec(`
        UPDATE rates SET max_slots_allowed = 0 WHERE id LIKE 'sample-%';
        UPDATE rates SET max_slots_allowed = 3 WHERE id IN ('sample-sha-oak-low', 'sample-sha-lax-low');
        UPDATE rates SET max_slots_allowed = NULL WHERE id = 'sample-sha-oak-high';
    `);
    const userId = world.users.testBuyer.id;
    const seed = 'r1-61-baseline';
    const preview = managedAgents.previewSampleAgents(userId, { seed });
    assert.deepEqual(preview.agents.slice(3).map(agent => agent.destinationPort), ['LAX', 'LAX']);

    app.db.exec("UPDATE rates SET max_slots_allowed = 0 WHERE id = 'sample-sha-lax-low'");
    const setMixedMax = app.db.prepare("UPDATE rates SET max_slots_allowed = ? WHERE id = 'sample-sha-oak-high'");
    for (const max of [null, 12]) {
        setMixedMax.run(max);
        assert.throws(() => managedAgents.previewSampleAgents(userId, { seed }), { status: 422 });
        const response = await app.request(ROOT + '/samples', {
            method: 'POST', body: JSON.stringify({ userId, seed }),
            headers: { 'x-admin-api-key': ADMIN_KEY, 'content-type': 'application/json' },
            cookie: false, csrf: false
        });
        assert.equal(response.status, 422);
        assert.equal(app.db.prepare('SELECT count(*) AS n FROM managed_agents WHERE created_by_user_id = ?').get(userId).n, 0);
    }

    app.db.prepare(`
        UPDATE rates SET rate_effective_date = ?, rate_expiration_date = ?
        WHERE id = 'sample-sha-oak-high'
    `).run(utcDay(1), utcDay(19));
    for (const [draw, day] of [[0, 0], [0.999, 20]]) {
        const { agents } = managedAgents.previewSampleAgents(userId, { random: () => draw });
        assert.deepEqual(agents.slice(3).map(agent => [agent.destinationPort, agent.sailingDate]), [
            ['OAK', utcDay(day)], ['OAK', utcDay(day)]
        ]);
    }
});
