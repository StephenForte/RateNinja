'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { runManagedAgents } = require('../lib/managed-agent-runner');
const { agent, env, fakeAdmin, fakeProviders, RATE_ID } = require('./helpers/r1-35');
const { CODE } = require('./helpers/r1-37');

async function run(bookingCode) {
    const admin = fakeAdmin([agent('one'), agent('two', { allowAlternativeRoutes: true })]);
    const providers = fakeProviders({ bookingCode, judge: () => ({ rateId: RATE_ID, summary: 'Fare found.' }) });
    let output = '';
    const writer = { write: text => { output += text; } };
    const code = await runManagedAgents({
        env, confirmed: true, stdout: writer, stderr: writer,
        fetchImpl: async (url, options) => {
            const target = new URL(url);
            const body = options.body && JSON.parse(options.body);
            return target.hostname === 'rateninja.invalid'
                ? admin.reply(target, options.method, body)
                : providers.reply(target, options.method, body);
        }
    });
    assert.equal(code, 0, output);
    assert.equal(providers.calls.filter(call => call.name === 'check_board' && !call.args.continuation).length, 1);
    const trips = admin.calls.filter(call => call.step === 'booking-requests');
    return { trips, agents: [...admin.states.values()], output, providers };
}

it('sends the announcement code with each booking based on one announcement read', async () => {
    const result = await run(CODE);
    assert.deepEqual(result.trips.map(trip => trip.body), [
        { rateId: RATE_ID, bookingCode: CODE }, { rateId: RATE_ID, bookingCode: CODE }
    ]);
    for (const value of [result.output, ...result.agents.map(item => item.resultSummary),
        JSON.stringify(result.providers.posts), JSON.stringify(result.providers.calls.filter(call => call.provider === 'claude'))]) {
        assert.equal(value.includes(CODE), false);
    }
});

it('finishes booking agents as completed with a summary when the announcement has no code', async () => {
    const result = await run(null);
    assert.deepEqual(result.trips, []);
    for (const item of result.agents) {
        assert.equal(item.status, 'completed');
        assert.match(item.resultSummary, /booking code unavailable/);
    }
});
