'use strict';

const { search } = require('./r1-33');

const TOKEN_A = 'test-bbs-token-r162-alpha';
const TOKEN_B = 'test-bbs-token-r162-bravo';

function lane(overrides = {}) {
    return {
        ...search(),
        acceptMaxSlots: false,
        priority: 'normal',
        dateFlexDays: 0,
        ...overrides
    };
}

function bookingLane(overrides = {}) {
    return lane({
        allowBookingRequest: true,
        priceMin: 0,
        priceMax: 1500,
        bookingSlots: 2,
        acceptMaxSlots: true,
        ...overrides
    });
}

function swarmBody(overrides = {}) {
    return {
        name: 'Synthetic swarm',
        instructions: 'Synthetic instructions',
        totalSpendCap: null,
        totalSlotsCap: null,
        lanes: [lane()],
        ...overrides
    };
}

module.exports = {
    TOKEN_A,
    TOKEN_B,
    lane,
    bookingLane,
    swarmBody
};
