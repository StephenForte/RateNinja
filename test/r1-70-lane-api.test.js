'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { startApp } = require('./helpers/app');
const { call, login } = require('./helpers/r1-19');
const { seed, LANE_KEYS, INSTRUCTIONS, PRICE_MIN, PRICE_MAX, THREAD } = require('./helpers/r1-70');

let app;
let customer;
let owner;

before(async () => {
    app = await startApp();
    seed(app.db);
    customer = await login(app.baseUrl, 'r170-customer');
    owner = await login(app.baseUrl, 'r170-owner');
});

after(async () => { await app?.close(); });

function keysOf(value) {
    return Object.keys(value).sort();
}

test('customer and admin run reads expose only the eight lane fields, in position order', async () => {
    const customerDetail = await call(app.baseUrl, customer, 'GET', '/api/swarm-runs/run-170');
    const adminDetail = await call(app.baseUrl, owner, 'GET', '/api/admin/swarm-runs/run-170');
    const customerList = await call(app.baseUrl, customer, 'GET', '/api/swarm-runs');
    const adminList = await call(app.baseUrl, owner, 'GET', '/api/admin/swarm-runs?companyId=c170');
    assert.equal(customerDetail.status, 200);
    assert.equal(adminDetail.status, 200);
    assert.equal(customerList.status, 200);
    assert.equal(adminList.status, 200);

    const expected = [
        {
            position: 1, rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX',
            sailingDate: '2026-12-01', containerType: '40HC', priority: 'high', allowBookingRequest: true
        },
        {
            position: 2, rateType: 'FCL', originPort: 'SHA', destinationPort: 'OAK',
            sailingDate: '2026-12-01', containerType: '40HC', priority: 'low', allowBookingRequest: false
        }
    ];
    for (const body of [customerDetail.json.run, adminDetail.json.run]) {
        assert.equal(body.laneCount, 2);
        assert.deepEqual(body.lanes, expected);
        for (const lane of body.lanes) assert.deepEqual(keysOf(lane), LANE_KEYS.slice().sort());
    }
    assert.deepEqual(adminDetail.json.run.lanes, customerDetail.json.run.lanes);
    assert.equal(Object.hasOwn(adminDetail.json.run, 'snapshot'), false);
    assert.equal(Object.hasOwn(adminDetail.json.run, 'bbsThreadId'), false);

    for (const list of [customerList.json.runs, adminList.json.runs]) {
        const run = list.find(item => item.id === 'run-170');
        const empty = list.find(item => item.id === 'run-empty');
        assert.equal(run.laneCount, 2);
        assert.equal(empty.laneCount, 0);
        assert.equal(Object.hasOwn(run, 'lanes'), false);
        assert.equal(Object.hasOwn(empty, 'lanes'), false);
    }
    const emptyDetail = await call(app.baseUrl, customer, 'GET', '/api/swarm-runs/run-empty');
    assert.deepEqual(emptyDetail.json.run.lanes, []);
    assert.equal(emptyDetail.json.run.laneCount, 0);

    const hidden = [INSTRUCTIONS, String(PRICE_MIN), String(PRICE_MAX), 'priceMin', 'priceMax', 'bookingSlots', 'acceptMaxSlots', 'dateFlexDays', 'allowAlternativeRoutes', 'customerNote', THREAD, 'bbs_thread_id'];
    for (const response of [customerDetail, adminDetail, customerList, adminList]) {
        for (const secret of hidden) {
            assert.equal(response.text.includes(secret), false, secret);
        }
    }
    assert.equal(customerDetail.text.includes('"bookingSlots"'), false);
});
