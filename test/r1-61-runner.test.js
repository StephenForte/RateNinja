'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { runManagedAgents } = require('../lib/managed-agent-runner');
const { agent, env, fakeAdmin, fakeProviders, matches } = require('./helpers/r1-35');

it('summarizes the confirmed booking count when the cap changes after matching', async () => {
    const admin = fakeAdmin([agent('slots', { acceptMaxSlots: true, bookingSlots: 12 })], (call, row) => {
        if (call.step === 'matches') return Response.json(matches(call.destination, { maxSlotsAllowed: 3, slotsToBook: 3 }));
        if (call.step === 'booking-requests') {
            row.bookingRequestId = 'booking-slots';
            return Response.json({ booking: { id: row.bookingRequestId, slots: 2 } }, { status: 201 });
        }
    });
    const provider = fakeProviders();
    let now = Date.parse('2026-11-21T10:00:00Z');
    const code = await runManagedAgents({
        confirmed: true, env, clock: () => now, sleep: async ms => { now += ms; },
        stdout: { write() {} }, stderr: { write() {} },
        fetchImpl: async (url, options) => {
            const target = new URL(url);
            const body = options.body && JSON.parse(options.body);
            if (target.hostname === 'rateninja.invalid') return admin.reply(target, options.method, body, now);
            assert.ok(['cloudbbs.invalid', 'claude.invalid'].includes(target.hostname));
            return provider.reply(target, options.method, body);
        }
    });
    assert.equal(code, 0);
    const result = admin.states.get('slots');
    assert.equal(result.status, 'completed');
    assert.match(result.resultSummary, /^Requested 12 slots; rate allows 2; booked 2\./);
});
