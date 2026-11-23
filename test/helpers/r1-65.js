'use strict';

const base = require('./r1-63');

function swarm(overrides = {}) {
    return {
        id: 'swarm-1',
        name: 'North',
        instructions: '',
        canEdit: true,
        totalSpendCap: 40,
        totalSlotsCap: 3,
        updatedAt: '2026-11-23T00:00:00.000Z',
        lanes: [base.lane()],
        ...overrides
    };
}

function runRecord(overrides = {}) {
    return {
        id: 'run-1',
        swarmId: 'swarm-1',
        swarmName: 'North',
        status: 'completed',
        startedByUserId: 'user-1',
        startedAt: '2026-11-23T01:00:00.000Z',
        finishedAt: '2026-11-23T01:05:00.000Z',
        summary: 'Finished the lanes.',
        failureReason: null,
        totalSpendCap: 40,
        totalSlotsCap: 3,
        spendBooked: 12,
        slotsBooked: 1,
        masterTurns: 4,
        inputTokens: 111,
        outputTokens: 222,
        cancelRequested: false,
        agents: [],
        ...overrides
    };
}

module.exports = { ...base, swarm, runRecord };
