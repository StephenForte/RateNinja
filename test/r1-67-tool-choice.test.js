'use strict';

const assert = require('node:assert/strict');
const { before, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { seedManagedAgents, BUYER } = require('./helpers/r1-33');
const { TOKEN_A, bookingLane, swarmBody } = require('./helpers/r1-62');
const { KEY, PROJECT, env, tool, spawn, buy, finish, model, waitFor } = require('./helpers/r1-64');
const { SWARM_MASTER_TURN_LIMIT } = require('../lib/limits');

const textReply = [{ type: 'text', text: 'Synthetic prose reply.' }];
const reminder = /a tool call is required/i;
let app;
let actor;
let runs;
let swarm;

before(async () => {
    app = await startApp();
    const { loadActor } = require('../lib/permissions');
    const { systemAdmin, creator } = seedManagedAgents(app.db);
    require('../lib/swarm-settings').updateCompany(loadActor(systemAdmin), BUYER, {
        enabled: true, bbsProject: PROJECT, bbsToken: TOKEN_A
    });
    actor = loadActor(creator);
    swarm = require('../lib/swarms').create(actor, swarmBody({
        totalSpendCap: 5000,
        totalSlotsCap: 2,
        lanes: [bookingLane({ priceMax: 2500 })]
    }));
    runs = require('../lib/swarm-runs');
});

after(async () => { await app?.close(); });

async function execute(turns, options, { fetchError } = {}) {
    const fake = model(turns, options);
    let now = Date.now();
    let requests = 0;
    const started = runs.start(actor, swarm.id, {
        env,
        clock: () => now,
        sleep: async ms => { now += ms; },
        fetchImpl(url, init) {
            if (new URL(url).origin === env.CLIENT_AGENT_ANTHROPIC_URL) {
                requests += 1;
                if (fetchError) throw fetchError;
            }
            return fake.fetchImpl(url, init);
        }
    });
    const run = await waitFor(() => runs.get(actor, started.id), row => row.status !== 'running');
    if (fake.seen.error) throw fake.seen.error;
    return { run, requests, seen: fake.seen };
}

const reply = (content = textReply, stop_reason = 'end_turn') => Response.json({ content, stop_reason });
const providerError = (status, type = 'invalid_request_error', message = 'Synthetic provider error') =>
    Response.json({ type: 'error', error: { type, message } }, { status });

it('completes master, search and booking with auto on a provider that rejects forced tools', async () => {
    const choices = [];
    const { run, requests, seen } = await execute([[spawn(1)], [buy(1)], [finish()]], {
        claudeResponse(role, { tool_choice }) { choices.push({ role, tool_choice }); }
    });
    assert.equal(run.status, 'completed',
        `run=${run.status}, reason=${run.failureReason}, requests=${requests}, rejected=${seen.rejectedToolChoices.join(',')}`);
    assert.equal(run.slotsBooked, 2);
    assert.deepEqual(choices.map(({ role }) => role), ['master', 'search', 'search', 'master', 'booking', 'booking', 'master']);
    assert.equal(choices.length, requests);
    for (const { tool_choice } of choices) assert.deepEqual(tool_choice, { type: 'auto' });
});

it('replays the text reply with a tool reminder and resets the allowance after a tool call', async () => {
    let attempt = 0;
    const { run } = await execute([[spawn(1)], [finish()]], {
        claudeResponse(role, { messages }) {
            if (role !== 'master') return;
            attempt += 1;
            if (attempt === 1) return reply();
            if (attempt === 3) return reply(textReply, 'tool_use');
            assert.deepEqual(messages.at(-2), { role: 'assistant', content: textReply });
            assert.equal(messages.at(-1).role, 'user');
            assert.match(messages.at(-1).content, reminder);
        }
    });
    assert.equal(run.status, 'completed', run.failureReason);
    assert.equal(attempt, 4);
    assert.equal(run.masterTurns, 4);
});

it('stops after a second consecutive response without a tool call', async () => {
    const { run, requests } = await execute([], { claudeResponse: () => reply() });
    assert.equal(run.failureReason, 'claude_tool_use');
    assert.equal(requests, 2);
    assert.equal(run.masterTurns, 2);
});

it('continues after an empty reply using the reminder', async () => {
    let attempt = 0;
    const { run } = await execute([[spawn(1)], [finish()]], {
        claudeResponse(role, { messages }) {
            if (role !== 'master') return;
            attempt += 1;
            if (attempt === 1) return reply([]);
            if (attempt === 2) {
                assert.equal(messages.length, 2);
                assert.equal(messages[1].role, 'user');
                assert.match(messages[1].content, reminder);
            }
        }
    });
    assert.equal(run.status, 'completed', run.failureReason);
    assert.equal(run.masterTurns, 3);
});

it('proposes a fresh call without dispatching tool blocks on a non-tool stop', async () => {
    const partial = { type: 'tool_use', id: 'toolu_partial', name: 'spawn_search', input: { lanePosition: 1 } };
    let first = true;
    const { run, seen } = await execute([[spawn(1)], [finish()]], {
        claudeResponse(role, { messages }) {
            if (role !== 'master') return;
            if (first) {
                first = false;
                return reply([partial]);
            }
            if (messages.length !== 3) return;
            assert.deepEqual(messages.at(-2), { role: 'assistant', content: [partial] });
            const [result, prompt] = messages.at(-1).content;
            assert.equal(result.tool_use_id, partial.id);
            assert.equal(result.is_error, true);
            assert.match(prompt.text, reminder);
        }
    });
    assert.equal(run.status, 'completed', run.failureReason);
    assert.equal(seen.searchLanes.length, 1);
});

it('fails immediately on missing, empty or duplicate tool-use IDs', async () => {
    const call = { type: 'tool_use', name: 'read_state', input: {} };
    const identified = { ...call, id: 'toolu_duplicate' };
    for (const content of [[call], [{ ...call, id: '' }], [identified, identified]]) {
        const { run, requests } = await execute([], { claudeResponse: () => reply(content, 'tool_use') });
        assert.equal(run.failureReason, 'claude_tool_use');
        assert.equal(requests, 1);
    }
});

it('counts the reminder turn against the existing turn limit', async () => {
    const { run, requests } = await execute([], {
        masterFallback: [tool('read_state')],
        claudeResponse(_role, { messages }) {
            if (messages.length === 1) return reply();
        }
    });
    assert.equal(run.failureReason, 'master_turn_limit');
    assert.equal(run.masterTurns, SWARM_MASTER_TURN_LIMIT);
    assert.equal(requests, SWARM_MASTER_TURN_LIMIT);
});

it('logs one bounded redacted diagnostic and stores only the HTTP status on a 400', async t => {
    const log = t.mock.method(console, 'error', () => {});
    const { run, requests } = await execute([], {
        claudeResponse(_role, body) {
            return providerError(400, 'invalid_request_error',
                `Synthetic rejection: ${KEY} ${TOKEN_A} ${PROJECT}\n${body.system}${JSON.stringify(body)}${'x'.repeat(600)}`);
        }
    });
    assert.equal(requests, 1);
    assert.equal(run.failureReason, 'claude_http_400');
    assert.equal(log.mock.callCount(), 1);
    const line = log.mock.calls[0].arguments.join(' ');
    for (const piece of [run.id, '400', 'invalid_request_error', 'Synthetic rejection', '[redacted]']) {
        assert.ok(line.includes(piece), piece);
    }
    for (const privateText of [KEY, TOKEN_A, PROJECT, 'Coordinate', 'max_tokens']) {
        assert.equal(line.includes(privateText), false);
    }
    assert.doesNotMatch(line, /[\r\n]/);
    assert.equal(line.length, 500);
});

it('logs only the final HTTP failure after the existing three attempts', async t => {
    const log = t.mock.method(console, 'error', () => {});
    let attempts = 0;
    const { run, requests } = await execute([], {
        claudeResponse() {
            attempts += 1;
            if (attempts === 1) return providerError(503, 'overloaded_error', 'Earlier failure');
            return providerError(429, 'rate_limit_error', `Attempt ${attempts}`);
        }
    });
    assert.equal(requests, 3);
    assert.equal(run.failureReason, 'claude_http_429');
    assert.equal(log.mock.callCount(), 1);
    assert.match(log.mock.calls[0].arguments.join(' '), /429.*rate_limit_error.*Attempt 3/);
});

it('keeps network failures and unreadable response bodies under claude', async t => {
    const log = t.mock.method(console, 'error', () => {});
    const thrown = await execute([], {}, { fetchError: new Error('Synthetic network error') });
    const unreadable = await execute([], { claudeResponse: () => new Response('invalid JSON', { status: 400 }) });
    for (const { run, requests } of [thrown, unreadable]) {
        assert.equal(run.failureReason, 'claude');
        assert.equal(requests, 1);
    }
    assert.equal(log.mock.callCount(), 0);
});
