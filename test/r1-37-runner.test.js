'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { runManagedAgents } = require('../lib/managed-agent-runner');
const { agent, env, fakeAdmin, fakeProviders, RATE_ID } = require('./helpers/r1-35');
const { CODE } = require('./helpers/r1-37');

async function run(bookingCode, runnerEnv = env) {
    const admin = fakeAdmin([agent('one'), agent('two', { allowAlternativeRoutes: true })]);
    const providers = fakeProviders({ bookingCode, judge: () => ({ rateId: RATE_ID, summary: 'Fare found.' }) });
    let output = '';
    const writer = { write: text => { output += text; } };
    const code = await runManagedAgents({
        env: runnerEnv, confirmed: true, stdout: writer, stderr: writer,
        fetchImpl: async (url, options) => {
            options.signal.throwIfAborted();
            const target = new URL(url);
            const body = options.body && JSON.parse(options.body);
            return target.hostname === 'rateninja.invalid'
                ? admin.reply(target, options.method, body)
                : providers.reply(target, options.method, body);
        }
    });
    const trips = admin.calls.filter(call => call.step === 'booking-requests');
    return { code, trips, admin, agents: [...admin.states.values()], output, providers };
}

function verifyAnnouncementRead(result) {
    assert.equal(result.code, 0, result.output);
    assert.equal(result.providers.calls.filter(call => call.name === 'check_board' && !call.args.continuation).length, 1);
}

it('sends one announcement code to each booking with the runner timeout per page', async t => {
    t.mock.method(AbortSignal, 'timeout', ms => ms < 60_000
        ? AbortSignal.abort(new Error('Simulated slow CloudBBS read'))
        : new AbortController().signal);
    const result = await run(CODE);
    verifyAnnouncementRead(result);
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
    verifyAnnouncementRead(result);
    assert.deepEqual(result.trips, []);
    for (const item of result.agents) {
        assert.equal(item.status, 'completed');
        assert.match(item.resultSummary, /booking code unavailable/);
    }
});

it('requires the CLI agent token before changing the queue', async () => {
    const result = await run(CODE, { ...env, CLOUDBBS_AGENT_TOKEN: '' });
    assert.equal(result.code, 2);
    assert.match(result.output, /Set CLOUDBBS_AGENT_TOKEN/);
    assert.deepEqual(result.admin.calls.filter(call => call.method === 'POST'), []);
    assert.deepEqual(result.providers.calls, []);
    assert.deepEqual(result.agents.map(item => item.status), ['queued', 'queued']);
});
