'use strict';

const {
    activate, insertCompany, insertMargin, insertUser, COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER
} = require('./r1-19');

const INSTRUCTIONS = 'Pay the ceiling and do not show this sentence';
const PRICE_MIN = 1200.25;
const PRICE_MAX = 8800.55;
const SLOTS = 7;
const THREAD = 'secret-thread-r170';
const LANE_KEYS = [
    'position', 'rateType', 'originPort', 'destinationPort', 'sailingDate',
    'containerType', 'priority', 'allowBookingRequest'
];

function lane(position, overrides = {}) {
    return {
        id: `lane-${position}`,
        position,
        rateType: position === 1 ? 'Port' : 'FCL',
        originPort: 'SHA',
        destinationPort: position === 1 ? 'LAX' : 'OAK',
        sailingDate: '2026-12-01',
        containerType: '40HC',
        priority: position === 1 ? 'high' : 'low',
        allowBookingRequest: position === 1,
        allowAlternativeRoutes: true,
        dateFlexDays: 4,
        priceMin: PRICE_MIN,
        priceMax: PRICE_MAX,
        bookingSlots: SLOTS,
        acceptMaxSlots: true,
        customerNote: INSTRUCTIONS,
        ...overrides
    };
}

function seed(db) {
    insertCompany(db, { id: 'owner-170', name: 'Synthetic Owner 170', type: COMPANY_TYPE_CONTRACT_OWNER });
    insertCompany(db, { id: 'c170', name: 'Synthetic Customer 170', type: COMPANY_TYPE_CUSTOMER });
    insertMargin(db, { id: 'link-170', owner: 'owner-170', customer: 'c170', percent: 10 });
    insertUser(db, { id: 'r170-owner', username: 'r170-owner', companyId: 'owner-170', role: 'company_admin' });
    insertUser(db, { id: 'r170-customer', username: 'r170-customer', companyId: 'c170', role: 'company_admin' });
    activate('r170-owner');
    activate('r170-customer');
    const snapshot = {
        name: 'Lane swarm',
        instructions: INSTRUCTIONS,
        totalSpendCap: 500,
        totalSlotsCap: 9,
        bbsThreadId: THREAD,
        lanes: [lane(2), lane(1)]
    };
    db.prepare(`
        INSERT INTO swarm_runs (
            id, swarm_id, company_id, started_by_user_id, status, snapshot, started_at, finished_at, bbs_thread_id
        ) VALUES ('run-170', 'swarm-170', 'c170', 'r170-customer', 'completed', ?, '2026-11-23T15:04:17.000Z', '2026-11-23T16:09:17.000Z', ?)
    `).run(JSON.stringify(snapshot), THREAD);
    db.prepare(`
        INSERT INTO swarm_runs (
            id, swarm_id, company_id, started_by_user_id, status, snapshot, started_at, finished_at
        ) VALUES ('run-empty', 'swarm-empty', 'c170', 'r170-customer', 'completed', ?, '2026-11-23T12:00:00.000Z', '2026-11-23T12:05:00.000Z')
    `).run(JSON.stringify({ name: 'No lanes', instructions: INSTRUCTIONS, totalSpendCap: null, totalSlotsCap: null }));
}

module.exports = {
    seed, lane, LANE_KEYS, INSTRUCTIONS, PRICE_MIN, PRICE_MAX, SLOTS, THREAD
};
