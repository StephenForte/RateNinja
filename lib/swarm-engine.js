'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { db, transaction } = require('./db');
const { createMcpClient, POST_BODY_CAP } = require('./client-agent');
const { DEFAULT_CLOUDBBS_PROJECT } = require('./cloudbbs-post');
const { searchLane, redirectLane, bookingTerms, book } = require('./swarm-guards');
const {
    SWARM_MASTER_TURN_LIMIT, SWARM_AGENT_TURN_LIMIT, SWARM_RUN_TIME_LIMIT_MS, SWARM_CONCURRENT_SEARCH_LIMIT
} = require('./limits');

const prompts = Object.fromEntries(['master', 'search', 'booking'].map(role =>
    [role, readFileSync(join(__dirname, '..', 'prompts', `swarm-${role}.md`), 'utf8')]));
const integer = { type: 'integer' };
const string = { type: 'string' };
const refusal = reason => ({ reason });
const searchTools = [
    tool('read_matches', 'Read the customer-priced matches and sailings for this lane.'),
    tool('report', 'Report a chosen rate from read_matches, or null, with a short reason.',
        { rateId: { type: ['string', 'null'] }, reason: string })
];
const bookingTools = [
    tool('book', 'Attempt the assigned booking once. The server computes price and slots.'),
    tool('report', 'Report the booking result with a short explanation.', { reason: string })
];
const masterTools = [
    tool('spawn_search', 'Search the saved lane at this one-based position. Search each lane once.',
        { lanePosition: integer }),
    tool('redirect_search', 'After an unsuccessful first search, try one alternative destination or one YYYY-MM-DD sailing date.',
        { lanePosition: integer, destinationPort: string, sailingDate: string }, ['lanePosition']),
    tool('spawn_booking', 'Try to book a rate reported by a search agent for this lane.',
        { lanePosition: integer, rateId: string }),
    tool('read_state', 'Read the current run reports, notes and totals.'),
    tool('write_state', 'Append a plan or decision note to the run thread.', { note: string }),
    tool('finish', 'Complete the run with a short summary.', { summary: string })
];

class RunStop extends Error {}

function tool(name, description, properties = {}, required = Object.keys(properties)) {
    return { name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

function validInput(definition, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const { properties, required } = definition.input_schema;
    return required.every(key => Object.hasOwn(input, key)) && Object.entries(input).every(([key, value]) => {
        if (!Object.hasOwn(properties, key)) return false;
        const { type } = properties[key];
        if (type === 'integer') return Number.isSafeInteger(value);
        if (Array.isArray(type)) return value === null || typeof value === 'string';
        return typeof value === type;
    });
}

function addAgent(runId, role, lane, attempt, startedAt) {
    const id = randomUUID();
    db.prepare(`
        INSERT INTO swarm_run_agents (
            id, run_id, role, lane_position, attempt, status, origin_port, destination_port, sailing_date, started_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(id, runId, role, lane?.position ?? null, attempt, lane?.originPort ?? null,
        lane?.destinationPort ?? null, lane?.sailingDate ?? null, startedAt);
    return id;
}

function completeAgent(id, finishedAt, report, match, lane) {
    db.prepare(`
        UPDATE swarm_run_agents SET status = 'completed', finished_at = ?, report = ?,
            rate_id = COALESCE(?, rate_id), price = COALESCE(?, price), slots = COALESCE(?, slots)
        WHERE id = ? AND status = 'running'
    `).run(finishedAt, report, match?.rateId ?? null, match?.price ?? null,
        match?.bookable && match.withinPriceRange ? match.slotsToBook ?? lane.bookingSlots : null, id);
}

function splitPost(kind, content) {
    // Reserve space for the part label. The shared client cap is below the
    // CloudBBS service cap and leaves space for escaping in the JSON-RPC body.
    const budget = POST_BODY_CAP - Buffer.byteLength(kind) - 40;
    const parts = [];
    let start = 0;
    let end = 0;
    let bytes = 0;
    for (const character of content) {
        const length = Buffer.byteLength(character);
        if (bytes + length > budget) {
            parts.push(content.slice(start, end));
            start = end;
            bytes = 0;
        }
        end += character.length;
        bytes += length;
    }
    parts.push(content.slice(start));
    return parts;
}

function createThread(runId, settings, credentials, fetchImpl, check) {
    const mcp = createMcpClient({ baseUrl: settings.cloudBbsUrl, token: credentials.bbsToken, fetchImpl });
    let sessionId;
    let threadId;
    let sequence = 0;
    let writes = Promise.resolve();

    async function publish(kind, parts, root) {
        try {
            check();
            if (root) {
                if (credentials.bbsProject === DEFAULT_CLOUDBBS_PROJECT) throw new RunStop('cloudbbs');
                ({ sessionId } = await mcp.callTool('connect_agent', { name: 'rateninja-swarm' }));
                check();
                if (!sessionId) throw new RunStop('cloudbbs');
                const { projects } = await mcp.callTool('list_projects', { session_id: sessionId });
                check();
                const project = projects?.find(row => row.slug === credentials.bbsProject && row.visibility === 'private');
                if (!project?.id) throw new RunStop('cloudbbs');
                const result = await mcp.callTool('post_message', {
                    project_id: project.id,
                    title: `Swarm run ${runId}`,
                    session_id: sessionId,
                    body: body(0),
                    idempotency_key: `swarm-${runId}-${sequence++}`
                });
                if (typeof result?.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(result.id)) {
                    throw new RunStop('cloudbbs');
                }
                threadId = result.id;
                db.prepare('UPDATE swarm_runs SET bbs_thread_id = ? WHERE id = ?').run(threadId, runId);
            }
            for (let index = root ? 1 : 0; index < parts.length; index += 1) {
                check();
                const result = await mcp.callTool('reply_message', {
                    root_id: threadId,
                    session_id: sessionId,
                    body: body(index),
                    idempotency_key: `swarm-${runId}-${sequence++}`
                });
                if (!result?.id) throw new RunStop('cloudbbs');
            }
            check();
        } catch (error) {
            check();
            throw error instanceof RunStop ? error : new RunStop('cloudbbs');
        }

        function body(index) {
            const label = parts.length > 1 ? ` (part ${index + 1} of ${parts.length})` : '';
            return `${kind}${label}\n${parts[index]}`;
        }
    }

    return (kind, parts, root = false) => {
        writes = writes.then(() => publish(kind, parts, root));
        return writes;
    };
}

async function toolLoop({ role, input, tools, dispatch, ask, check }) {
    const messages = [{ role: 'user', content: JSON.stringify(input) }];
    const definitions = new Map(tools.map(definition => [definition.name, definition]));
    const limit = role === 'master' ? SWARM_MASTER_TURN_LIMIT : SWARM_AGENT_TURN_LIMIT;
    for (let turn = 0; turn < limit; turn += 1) {
        check();
        const response = await ask(role, tools, messages);
        check();
        const calls = response?.content?.filter(block => block?.type === 'tool_use');
        if (response?.stop_reason !== 'tool_use' || !calls?.length
            || calls.some(call => typeof call.id !== 'string')
            || new Set(calls.map(call => call.id)).size !== calls.length) {
            throw new RunStop('claude_tool_use');
        }

        const results = [];
        for (let index = 0; index < calls.length;) {
            check();
            const call = calls[index];
            if (call.name === 'spawn_search' && role === 'master') {
                // Batch adjacent search calls. Side effects from other tools
                // retain their position in the model's tool-use message.
                const batch = [];
                while (index < calls.length && calls[index].name === 'spawn_search'
                    && batch.length < SWARM_CONCURRENT_SEARCH_LIMIT) batch.push(calls[index++]);
                const settled = await Promise.allSettled(batch.map(execute));
                const failure = settled.find(result => result.status === 'rejected');
                if (failure) throw failure.reason;
                results.push(...settled.map(result => result.value));
                continue;
            }
            const result = await execute(call);
            if (Object.hasOwn(result, 'final')) return result.final;
            results.push(result);
            index += 1;
        }
        messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: results });
    }
    throw new RunStop(role === 'master' ? 'master_turn_limit' : 'sub_agent_turn_limit');

    async function execute(call) {
        const definition = definitions.get(call.name);
        const result = definition && validInput(definition, call.input)
            ? await dispatch(call.name, call.input)
            : refusal(definition ? 'invalid_input' : 'unknown_tool');
        if (Object.hasOwn(result, 'final')) return result;
        return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
            ...(result.reason ? { is_error: true } : {})
        };
    }
}

async function performRun(run, { settings, credentials, redact, fetchImpl, clock, settle }) {
    const snapshot = JSON.parse(run.snapshot);
    const timestamp = () => new Date(clock()).toISOString();
    const deadline = Date.parse(run.started_at) + SWARM_RUN_TIME_LIMIT_MS;
    const timeout = AbortSignal.timeout(Math.max(1, deadline - clock()));
    // An injected clock may advance independently of the request abort timer.
    function check() {
        const current = db.prepare('SELECT status, cancel_requested FROM swarm_runs WHERE id = ?').get(run.id);
        if (!current || current.status !== 'running' || current.cancel_requested) throw new RunStop('cancelled');
        if (clock() >= deadline || timeout.aborted) throw new RunStop('run_time_limit');
    }
    const boundedFetch = (url, options) => fetchImpl(url, { ...options, signal: timeout, redirect: 'error' });
    const publish = createThread(run.id, settings, credentials, boundedFetch, check);
    const snapshotParts = splitPost('Snapshot', run.snapshot);
    const notes = [];
    const reportParts = new Map();
    const hadEligibleRate = new Map();

    async function ask(role, tools, messages) {
        let payload;
        try {
            const response = await boundedFetch(`${settings.anthropicBaseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': settings.anthropicKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({ model: settings.model, max_tokens: 1000, system: prompts[role],
                    tools, tool_choice: { type: 'any' }, messages })
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new RunStop('claude');
            }
            payload = await response.json();
        } catch {
            check();
            throw new RunStop('claude');
        }
        const usage = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        db.prepare(`
            UPDATE swarm_runs SET master_turns = master_turns + ?, input_tokens = input_tokens + ?,
                output_tokens = output_tokens + ? WHERE id = ? AND status = 'running'
        `).run(Number(role === 'master'), usage(payload?.usage?.input_tokens), usage(payload?.usage?.output_tokens), run.id);
        return payload;
    }

    function searchAttempt(position, attempt) {
        return db.prepare(`
            SELECT * FROM swarm_run_agents WHERE run_id = ? AND role = 'search' AND lane_position = ? AND attempt = ?
        `).get(run.id, position, attempt);
    }

    async function search(lane, attempt) {
        const id = addAgent(run.id, 'search', lane, attempt, timestamp());
        const results = searchLane(run, lane);
        let read = false;
        const { match, report } = await toolLoop({
            role: 'search', input: lane, tools: searchTools, ask, check,
            dispatch(name, input) {
                if (name === 'read_matches') {
                    read = true;
                    return results;
                }
                if (!read) return refusal('read_matches_required');
                const match = results.matches.find(row => row.rateId === input.rateId);
                if (input.rateId !== null && !match) return refusal('rate_not_found');
                return { final: { match, report: redact(input.reason) } };
            }
        });
        if (attempt === 1) {
            hadEligibleRate.set(lane.position, results.matches.some(match => match.bookable && match.withinPriceRange));
        }
        completeAgent(id, timestamp(), report, match, lane);
        const result = { lanePosition: lane.position, attempt, rateId: match?.rateId ?? null,
            price: match?.price ?? null, bookable: Boolean(match?.bookable && match.withinPriceRange),
            sailingDate: lane.sailingDate, report };
        const parts = splitPost('Search report', JSON.stringify(result));
        await publish('Search report', parts);
        reportParts.set(id, parts);
        return result;
    }

    async function booking(lane, rateId) {
        const terms = bookingTerms(run, snapshot, lane, rateId);
        if (terms.reason) return terms;
        if (db.prepare(`
            SELECT 1 FROM swarm_run_agents WHERE run_id = ? AND lane_position = ? AND role = 'booking'
        `).get(run.id, lane.position)) return refusal('booking_agent_already_started');
        const id = addAgent(run.id, 'booking', terms.chosenLane, 1, timestamp());
        let result;
        const report = await toolLoop({
            role: 'booking', input: { lanePosition: lane.position, rateId }, tools: bookingTools, ask, check,
            async dispatch(name, input) {
                if (name === 'book') {
                    if (result) return refusal('booking_already_attempted');
                    check();
                    result = book(run, snapshot, lane, rateId, id);
                    const body = JSON.stringify({ lanePosition: lane.position, rateId, ...result });
                    await publish('Booking result', splitPost('Booking result', body));
                    return result;
                }
                if (!result) return refusal('booking_attempt_required');
                const outcome = result.bookingRequestId ?? result.reason;
                return { final: `${outcome}: ${redact(input.reason)}` };
            }
        });
        completeAgent(id, timestamp(), report);
        const parts = splitPost('Booking report', JSON.stringify({ lanePosition: lane.position, report }));
        await publish('Booking report', parts);
        reportParts.set(id, parts);
        return { ...result, report };
    }

    async function dispatch(name, input) {
        if (name === 'read_state') {
            const totals = db.prepare(`
                SELECT spend_booked AS spendBooked, slots_booked AS slotsBooked FROM swarm_runs WHERE id = ?
            `).get(run.id);
            const agents = db.prepare(`
                SELECT id, role, lane_position AS lanePosition, attempt, status, destination_port AS destinationPort,
                    sailing_date AS sailingDate, rate_id AS rateId, price, slots, booking_request_id AS bookingRequestId,
                    report FROM swarm_run_agents WHERE run_id = ? AND role <> 'master' ORDER BY started_at, rowid
            `).all(run.id);
            for (const agent of agents) {
                const parts = reportParts.get(agent.id);
                if (parts) agent.report = JSON.parse(parts.join('')).report;
            }
            return { snapshot: JSON.parse(snapshotParts.join('')), ...totals, agents,
                notes: notes.map(parts => JSON.parse(parts.join(''))) };
        }
        if (name === 'write_state') {
            const parts = splitPost('Master note', JSON.stringify(redact(input.note)));
            await publish('Master note', parts);
            notes.push(parts);
            return { saved: true };
        }
        if (name === 'finish') {
            if (snapshot.lanes.some(lane => searchAttempt(lane.position, 1)?.status !== 'completed')) {
                return refusal('searches_incomplete');
            }
            return { final: redact(input.summary) };
        }

        const lane = snapshot.lanes.find(lane => lane.position === input.lanePosition);
        if (!lane) return refusal('lane_not_found');
        const first = searchAttempt(lane.position, 1);
        if (name === 'spawn_search') {
            if (first) return refusal('search_already_started');
            return search(lane, 1);
        }
        if (name === 'redirect_search') {
            if (searchAttempt(lane.position, 2)) return refusal('redirect_already_started');
            const redirected = redirectLane(run, lane, first, hadEligibleRate.get(lane.position), input, clock());
            return redirected.reason ? redirected : search(redirected.lane, 2);
        }
        return booking(lane, input.rateId);
    }

    try {
        check();
        const masterId = addAgent(run.id, 'master', null, 1, timestamp());
        await publish('Snapshot', snapshotParts, true);
        const summary = await toolLoop({ role: 'master', input: snapshot, tools: masterTools, dispatch, ask, check });
        check();
        transaction(() => completeAgent(masterId, timestamp(), summary));
        settle(run, 'completed', timestamp(), summary);
    } catch (error) {
        const reason = error instanceof RunStop ? error.message : 'internal_error';
        const cancelled = reason === 'cancelled';
        settle(run, cancelled ? 'cancelled' : 'failed', timestamp(), null, cancelled ? null : reason);
    }
}

module.exports = { performRun };
