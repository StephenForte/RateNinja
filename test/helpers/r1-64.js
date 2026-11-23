'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout } = require('node:timers/promises');
const { TOKEN_A } = require('./r1-62');

const KEY = 'synthetic-anthropic-key-r164-?';
const PROJECT = 'buyer.private';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';
const env = {
    ANTHROPIC_API_KEY: KEY,
    CLIENT_AGENT_ANTHROPIC_URL: 'https://claude.invalid',
    CLIENT_AGENT_MODEL: 'synthetic-model',
    CLOUDBBS_URL: 'https://bbs.invalid',
    CLOUDBBS_TOKEN: 'unused-global-token',
    CLOUDBBS_AGENT_TOKEN: 'unused-global-agent-token',
    CLOUDBBS_SERVER_TOKEN: 'unused-global-server-token'
};

const tool = (name, input = {}) => ({ name, input });
const spawn = lanePosition => tool('spawn_search', { lanePosition });
const buy = (lanePosition, rateId = 'managed-rate-1') => tool('spawn_booking', { lanePosition, rateId });
const finish = (summary = 'Synthetic finished') => tool('finish', { summary });

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function parseResults(message) {
    if (typeof message.content === 'string') return [];
    return message.content.map(({ content }) => JSON.parse(content));
}

function model(turns, options = {}) {
    const seen = { writes: [], calls: [], master: [], searchLanes: [], bookingLanes: [], requests: 0, peak: {}, error: null };
    const inflight = { master: 0, search: 0, booking: 0 };
    let threadStarted = false;
    let turn = 0;
    let callId = 0;
    const fetchImpl = async (input, init) => {
        try {
            const url = new URL(input);
            const body = JSON.parse(init.body);
            assert.equal(init.redirect, 'error');
            assert.ok(init.signal);
            if (url.origin === env.CLOUDBBS_URL) {
                assert.equal(url.pathname, '/api/mcp');
                assert.equal(init.headers.Authorization, `Bearer ${TOKEN_A}`);
                const { name, arguments: args } = body.params;
                seen.calls.push(name);
                let data;
                if (name === 'connect_agent') data = { sessionId: 'synthetic-session' };
                else if (name === 'list_projects') {
                    data = { projects: [
                        { id: 'shared', slug: 'rn', visibility: 'public' },
                        { id: 'other-company', slug: 'other.private', visibility: 'private' },
                        { id: PROJECT_ID, slug: PROJECT, visibility: options.visibility ?? 'private' }
                    ] };
                } else {
                    assert.ok(['post_message', 'reply_message'].includes(name));
                    assert.equal(args.session_id, 'synthetic-session');
                    assert.ok(Buffer.byteLength(args.body) <= 16384);
                    if (name === 'post_message') {
                        assert.equal(threadStarted, false);
                        assert.equal(args.project_id, PROJECT_ID);
                        threadStarted = true;
                    } else {
                        assert.equal(threadStarted, true);
                        assert.equal(args.root_id, THREAD_ID);
                    }
                    seen.writes.push(args);
                    const failed = await options.failPost?.(args, seen.writes.length);
                    if (failed) return Response.json({ error: { message: failed } }, { status: 502 });
                    data = { id: name === 'post_message' ? THREAD_ID : randomUUID() };
                }
                return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: data } });
            }

            assert.equal(url.href, `${env.CLIENT_AGENT_ANTHROPIC_URL}/v1/messages`);
            assert.equal(init.headers['x-api-key'], KEY);
            assert.equal(init.headers['anthropic-version'], '2023-06-01');
            assert.equal(body.model, env.CLIENT_AGENT_MODEL);
            const role = body.tools.length === 6 ? 'master' : body.tools[0].name === 'read_matches' ? 'search' : 'booking';
            assert.match(body.system, { master: /Coordinate/, search: /Search this run/, booking: /single assigned/ }[role]);
            assert.deepEqual(body.tools.map(item => item.name), {
                master: ['spawn_search', 'redirect_search', 'spawn_booking', 'read_state', 'write_state', 'finish'],
                search: ['read_matches', 'report'],
                booking: ['book', 'report']
            }[role]);
            const initial = JSON.parse(body.messages[0].content);
            const last = body.messages.at(-1);
            const results = parseResults(last);
            if (results.length) {
                const calls = body.messages.at(-2).content.filter(block => block.type === 'tool_use');
                assert.deepEqual(last.content.map(block => block.tool_use_id), calls.map(block => block.id));
            }
            seen.requests += 1;
            inflight[role] += 1;
            seen.peak[role] = Math.max(seen.peak[role] ?? 0, inflight[role]);
            let calls;
            try {
                if (role === 'master') {
                    seen.master.push({ initial, results });
                    const next = turns[turn++] ?? options.masterFallback;
                    calls = typeof next === 'function' ? await next({ initial, results }) : next;
                } else if (role === 'search' && results.length === 0) {
                    seen.searchLanes.push(initial);
                    await options.searchPause?.(initial);
                    calls = [tool('read_matches')];
                } else if (role === 'search') {
                    calls = options.searchReport?.(initial, results[0])
                        ?? [tool('report', { rateId: results[0].matches[0]?.rateId ?? null, reason: 'Synthetic match' })];
                } else if (results.length === 0) {
                    seen.bookingLanes.push(initial.lanePosition);
                    await options.bookingPause?.(initial);
                    calls = [tool('book')];
                } else {
                    calls = options.bookingReport?.(initial, results) ?? [tool('report', { reason: 'Synthetic result' })];
                }
            } finally {
                inflight[role] -= 1;
            }
            assert.ok(Array.isArray(calls) && calls.length, `Unscripted ${role} turn`);
            return Response.json({
                stop_reason: 'tool_use',
                usage: { input_tokens: 5, output_tokens: 3 },
                content: calls.map(call => ({ ...call, type: 'tool_use', id: `toolu_${++callId}` }))
            });
        } catch (error) {
            seen.error ??= error;
            throw error;
        }
    };
    return { fetchImpl, seen };
}

async function waitFor(get, predicate) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const result = await get();
        if (predicate(result)) return result;
        await setTimeout(5);
    }
    assert.fail('Run did not reach the expected state');
}

module.exports = { KEY, PROJECT, PROJECT_ID, THREAD_ID, env, tool, spawn, buy, finish, deferred, model, waitFor };
