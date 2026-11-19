'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { runManagedAgents } = require('../lib/managed-agent-runner');
const { CODE } = require('./helpers/r1-37');
const {
    ADMIN_KEY, CLOUD_TOKEN, CLAUDE_KEY, ORIGIN, DESTINATION, ALTERNATIVES, PRICE, RATE_ID, CARRIER,
    COMPANY, CREATOR, PAYLOAD, env, agent, matches, fakeAdmin, fakeProviders
} = require('./helpers/r1-35');

function fixture(agents, { adminReply, providers } = {}) {
    const admin = fakeAdmin(agents, adminReply);
    const provider = fakeProviders(providers);
    const calls = [];
    const waits = [];
    let now = Date.parse('2026-11-18T10:00:00Z');
    let stdout = '';
    let stderr = '';

    async function run(overrides) {
        const code = await runManagedAgents({
            confirmed: true, env, clock: () => now, sleep: async ms => { waits.push(ms); now += ms; },
            stdout: { write: text => { stdout += text; } },
            stderr: { write: text => { stderr += text; } },
            fetchImpl: async (url, options) => {
                const target = new URL(url);
                const body = options.body && JSON.parse(options.body);
                assert.equal(options.redirect, 'error');
                calls.push({ path: target.pathname, method: options.method, tool: body?.params?.name });
                if (target.host === 'rateninja.invalid') {
                    assert.equal(options.headers['X-Admin-API-Key'], ADMIN_KEY);
                    return admin.reply(target, options.method, body, now);
                }
                if (target.host === 'cloudbbs.invalid') {
                    assert.equal(options.headers.Authorization, 'Bearer ' + CLOUD_TOKEN);
                } else {
                    assert.equal(target.host, 'claude.invalid');
                    assert.equal(options.headers['x-api-key'], CLAUDE_KEY);
                }
                return provider.reply(target, options.method, body);
            },
            ...overrides
        });
        return { code, stdout, stderr };
    }
    return { run, admin, provider, calls, waits };
}

const validReply = { rateId: RATE_ID, summary: 'Found the synthetic fare.' };

it('continues after a match failure, checks only permitted alternatives, and posts safe counts after all finishes', async () => {
    const test = fixture([
        agent('one'), agent('two', { allowAlternativeRoutes: true }),
        agent('three', { allowBookingRequest: false }), agent('stuck', { status: 'running' })
    ], {
        adminReply(call) {
            if (call.id === 'one' && call.step === 'matches') {
                return Response.json({ error: ADMIN_KEY + COMPANY }, { status: 502 });
            }
            if (call.id === 'two' && call.destination === DESTINATION && call.step === 'matches') {
                const result = matches(DESTINATION, { price: null });
                result.matches.push({ ...result.matches[0], rateId: 'malformed-date-id', price: PRICE, rateEffectiveDate: 'unreadable' });
                result.sailings.push({ departure: 'unreadable' });
                return Response.json(result);
            }
        },
        providers: { judge: () => ({ rateId: RATE_ID, summary: [PAYLOAD, ADMIN_KEY, CLOUD_TOKEN, CLAUDE_KEY].join(' ') }) }
    });
    const result = await test.run();
    assert.equal(result.code, 1);
    const writes = test.admin.calls.filter(call => call.method === 'POST');
    assert.deepEqual(writes.map(({ id, step }) => [id, step]), [
        ['one', 'start'], ['one', 'finish'], ['two', 'start'], ['two', 'booking-requests'], ['two', 'finish'],
        ['three', 'start'], ['three', 'finish']
    ]);
    assert.equal(test.admin.states.get('one').status, 'failed');
    assert.match(test.admin.states.get('one').resultSummary, /primary matches.*HTTP 502/);
    assert.equal(test.admin.states.get('two').status, 'completed');
    assert.ok(test.admin.states.get('two').resultSummary.includes(PAYLOAD));
    assert.ok(test.admin.states.get('two').resultSummary.includes(ALTERNATIVES[2]));
    assert.equal(test.admin.states.get('three').status, 'completed');
    assert.match(test.admin.states.get('three').resultSummary, /Booking was disabled/);
    assert.equal(test.admin.states.get('stuck').status, 'running');
    const chosen = test.admin.calls.filter(call => call.id === 'two' && call.step === 'matches').map(call => call.destination);
    assert.deepEqual(chosen, [DESTINATION, ...ALTERNATIVES.slice(0, 3)]);
    const claude = test.provider.calls.filter(call => call.provider === 'claude');
    assert.deepEqual(claude.map(call => call.name), ['alternatives', 'judge', 'judge']);
    assert.equal(claude[0].model, 'synthetic-claude');
    assert.deepEqual(claude[0].input.candidates, ALTERNATIVES.slice().sort());
    assert.deepEqual(claude[1].input.results[0].matches, []);
    assert.equal(claude[1].input.results[1].matches[0].price, PRICE);
    assert.equal(claude[1].input.companyName, undefined);
    assert.equal(claude[1].input.creatorName, undefined);
    assert.match(result.stdout, /stuck.*already running/);
    assert.match(result.stdout, /two.*completed.*booking-two/);
    assert.equal(test.calls.at(-1).tool, 'post_message');
    assert.equal(test.provider.posts.length, 1);
    const note = test.provider.posts[0];
    assert.equal(note.title, 'Managed agent run — 2026-11-18T10:00:00.000Z');
    assert.equal(note.project_id, 'test-rn');
    assert.match(note.body, /Agents run: 3\nCompleted: 2\nFailed: 1\nBookings made: 1\nAlready running: 1/);
    assert.match(note.body, /Abnormal[\s\S]*primary matches: HTTP 502[\s\S]*malformed matches[\s\S]*malformed sailings/);
    for (const secret of [ADMIN_KEY, CLOUD_TOKEN, CLAUDE_KEY]) {
        for (const output of [result.stdout, result.stderr, note.body, test.admin.states.get('two').resultSummary]) {
            assert.ok(!output.includes(secret));
        }
    }
    for (const privateValue of [COMPANY, CREATOR, ORIGIN, DESTINATION, ...ALTERNATIVES, String(PRICE), RATE_ID, CARRIER, PAYLOAD]) {
        assert.ok(!note.body.includes(privateValue));
    }
});

it('requires the chosen rate to be present, bookable and in range and records a refusal as completed', async t => {
    const cases = [
        ['disabled', { allowBookingRequest: false }, {}, RATE_ID, null, /disabled/],
        ['no choice', {}, {}, null, null, /No rate was selected/],
        ['unknown rate', {}, {}, 'another-agents-rate', null, /absent from the fetched/],
        ['not bookable', {}, { bookable: false }, RATE_ID, null, /not bookable/],
        ['out of range', {}, { withinPriceRange: false }, RATE_ID, null, /outside the permitted/],
        ['refusal 400', {}, {}, RATE_ID, 400, /refused.*HTTP 400/],
        ['refusal 409', {}, {}, RATE_ID, 409, /refused.*HTTP 409/]
    ];
    for (const [name, config, match, rateId, refusal, summary] of cases) {
        await t.test(name, async () => {
            const test = fixture([agent('a', config)], {
                adminReply(call) {
                    if (call.step === 'matches') return Response.json(matches(call.destination, match));
                    if (call.step === 'booking-requests' && refusal) return Response.json({ error: 'refused' }, { status: refusal });
                },
                providers: { judge: () => ({ ...validReply, rateId }) }
            });
            assert.equal((await test.run()).code, 0);
            const bookings = test.admin.calls.filter(call => call.step === 'booking-requests');
            assert.deepEqual(bookings.map(call => call.body), refusal ? [{ rateId: RATE_ID, bookingCode: CODE }] : []);
            assert.equal(test.admin.states.get('a').status, 'completed');
            assert.match(test.admin.states.get('a').resultSummary, summary);
            if (refusal) assert.ok(test.provider.posts[0].body.includes('booking: HTTP ' + refusal));
        });
    }
});

it('retries invalid Claude JSON once and finishes failed with the step named', async t => {
    await t.test('both replies invalid', async () => {
        const test = fixture([agent('one', { allowAlternativeRoutes: true })], {
            providers: { alternatives: () => 'bad JSON' }
        });
        assert.equal((await test.run()).code, 1);
        assert.deepEqual(test.provider.calls.filter(call => call.provider === 'claude').map(call => call.name),
            ['alternatives', 'alternatives']);
        assert.equal(test.admin.states.get('one').status, 'failed');
        assert.match(test.admin.states.get('one').resultSummary, /Claude alternatives.*Claude parse failure/);
        assert.match(test.provider.posts[0].body, /Claude parse failure, retried/);
    });
    await t.test('second reply valid', async () => {
        let judgments = 0;
        const test = fixture([agent('one')], {
            providers: { judge: () => ++judgments === 1 ? { summary: 'Missing rateId' } : validReply }
        });
        assert.equal((await test.run()).code, 0);
        assert.equal(judgments, 2);
        assert.equal(test.admin.states.get('one').status, 'completed');
    });
});

it('paces 25 full agents under the quota and waits a full window before retrying a 429', async () => {
    let attempts = 0;
    const test = fixture(Array.from({ length: 25 }, (_, i) => agent('agent-' + i, { allowAlternativeRoutes: true })), {
        adminReply(call) {
            if (call.id === 'agent-0' && call.step === 'start' && ++attempts === 1) {
                return Response.json({}, { status: 429 });
            }
        }
    });
    assert.equal((await test.run()).code, 0);
    assert.equal(test.admin.calls.length, 178);
    for (const { time } of test.admin.calls) {
        assert.ok(test.admin.calls.filter(call => time - call.time >= 0 && time - call.time < 60_000).length <= 60);
    }
    const starts = test.admin.calls.filter(call => call.id === 'agent-0' && call.step === 'start');
    assert.deepEqual(starts.map(call => call.time - starts[0].time), [0, 60_000]);
    assert.equal(test.waits[0], 60_000);
    assert.ok([...test.admin.states.values()].every(row => row.status === 'completed'));
    assert.match(test.provider.posts[0].body, /start: HTTP 429, waited and retried/);
});

it('attempts a 429 retry once and skips changed agents without touching them', async () => {
    const test = fixture([agent('busy'), agent('changed'), agent('later')], {
        adminReply(call, row) {
            if (call.step !== 'start') return;
            if (call.id === 'busy') return Response.json({}, { status: 429 });
            if (call.id === 'changed') {
                row.status = 'running';
                return Response.json({ error: 'not_queued' }, { status: 409 });
            }
        }
    });
    const result = await test.run();
    assert.equal(result.code, 1);
    assert.deepEqual(test.admin.calls.filter(call => call.id === 'busy').map(call => call.step), ['start', 'start']);
    assert.deepEqual(test.admin.calls.filter(call => call.id === 'changed').map(call => call.step), ['start']);
    assert.match(result.stdout, /changed.*changed before start/);
    assert.equal(test.admin.states.get('later').status, 'completed');
});

it('finishes an acknowledged malformed start and verifies a finish whose response was lost', async () => {
    const test = fixture([agent('malformed'), agent('lost')], {
        adminReply(call, row) {
            if (call.step === 'start' && call.id === 'malformed') {
                row.status = 'running';
                return new Response('invalid JSON');
            }
            if (call.step === 'finish' && call.id === 'lost') {
                if (row.status !== 'running') return Response.json({ error: 'not_running' }, { status: 409 });
                Object.assign(row, call.body);
                throw new Error('Connection closed after commit.');
            }
        }
    });
    const result = await test.run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /lost.*completed/);
    assert.equal(test.admin.states.get('malformed').status, 'failed');
    assert.match(test.admin.states.get('malformed').resultSummary, /during start/);
    assert.equal(test.admin.states.get('lost').status, 'completed');
    assert.match(test.provider.posts[0].body, /finish: request failed, retried/);
});

it('requires one confirmation, leaves running agents alone, and skips an empty run note', async () => {
    const cancelled = fixture([agent('one')]);
    let prompts = 0;
    assert.equal((await cancelled.run({ confirmed: false, ask: async () => { prompts += 1; return 'n'; } })).code, 0);
    assert.equal(prompts, 1);
    assert.equal(cancelled.calls.length, 2);
    assert.ok(cancelled.calls.every(call => call.method === 'GET'));
    const approved = fixture([agent('one')]);
    assert.equal((await approved.run({ ask: () => assert.fail('unexpected prompt') })).code, 0);
    assert.equal(approved.admin.states.get('one').status, 'completed');
    const empty = fixture([agent('stuck', { status: 'running' })]);
    const outcome = await empty.run({ confirmed: false, ask: () => assert.fail('unexpected prompt') });
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout, /stuck.*already running/);
    assert.equal(empty.calls.length, 2);
});

it('reports a failed CloudBBS post on stderr after leaving agents finished', async () => {
    const test = fixture([agent('one')], { providers: { postStatus: 503 } });
    const result = await test.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not post the CloudBBS run note \(HTTP 503\)/);
    assert.ok(!result.stderr.includes(CLOUD_TOKEN));
    assert.equal(test.provider.posts.length, 1);
    assert.equal(test.admin.states.get('one').status, 'completed');
});
