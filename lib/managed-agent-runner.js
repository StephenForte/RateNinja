'use strict';

const { randomUUID } = require('node:crypto');
const { ADMIN_API_RATE_LIMIT, ADMIN_API_WINDOW_MS } = require('./config');
const { clientAgentSettings, createMcpClient, distinctLanes, parseClaudeJson } = require('./client-agent');
const { AGENTS_PATH } = require('./managed-agent-prompts');
const { readAnnouncement } = require('./booking-code');
const { REFERENCE_SCHEMA } = require('./cloudbbs-post');

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const BOOKING_REFUSALS = new Set([400, 403, 404, 409, 422]);

class RunError extends Error {
    constructor(reason, status) {
        super(reason);
        this.status = status;
    }
}

function errorReason(error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
        return `HTTP ${error.status}`;
    }
    return error instanceof RunError ? error.message : 'request failed';
}

async function requestJson(fetchImpl, url, options) {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RunError('request failed', response.status);
    }
    return response.json().catch(() => {
        throw new RunError('malformed response', response.status);
    });
}

function createAdminClient({ baseUrl, key, fetchImpl, clock, sleep, abnormal }) {
    const requests = [];
    async function request(path, method, body) {
        const now = clock();
        while (requests.length && now - requests[0] >= ADMIN_API_WINDOW_MS) requests.shift();
        if (requests.length >= ADMIN_API_RATE_LIMIT) {
            await sleep(requests.shift() + ADMIN_API_WINDOW_MS - now);
        }
        requests.push(clock());
        return requestJson(fetchImpl, new URL(path, baseUrl), {
            method,
            headers: { 'X-Admin-API-Key': key, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }
    return async (step, path, method = 'GET', body) => {
        try {
            return await request(path, method, body);
        } catch (error) {
            if (error.status !== 429) throw error;
            abnormal(step, 'HTTP 429, waited and retried');
            await sleep(ADMIN_API_WINDOW_MS);
            return request(path, method, body);
        }
    };
}

async function askClaude({ fetchImpl, settings, abnormal }, step, instruction, input, valid) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await requestJson(fetchImpl, `${settings.anthropicBaseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': settings.anthropicKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: settings.model,
                max_tokens: 1000,
                messages: [{ role: 'user', content: `${instruction}\n${JSON.stringify(input)}` }]
            })
        }).catch(error => {
            if (error instanceof RunError && error.message === 'malformed response') return null;
            throw error;
        });

        try {
            const text = Array.isArray(response?.content)
                ? response.content.filter(block => block?.type === 'text').map(block => block.text).join('')
                : '';
            const answer = parseClaudeJson(text);
            if (valid(answer)) return answer;
        } catch {
            // Retry malformed model output once, without echoing it.
        }
        if (attempt === 0) abnormal(step, 'Claude parse failure, retried');
    }
    throw new RunError('Claude parse failure');
}

function readableDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return false;
    const timestamp = Date.parse(value);
    const day = Date.parse(value.slice(0, 10));
    return Number.isFinite(timestamp) && Number.isFinite(day)
        && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10);
}

async function readMatches({ admin, abnormal }, step, path, destination, isAlternative, bookingAllowed) {
    const pathWithQuery = isAlternative ? `${path}/matches?${new URLSearchParams({ destinationPort: destination })}` : `${path}/matches`;
    const payload = await admin(step, pathWithQuery);
    if (payload?.destinationPort !== destination || !Array.isArray(payload.matches) || !Array.isArray(payload.sailings)) {
        throw new RunError('malformed matches response');
    }

    const matches = payload.matches.filter(match =>
        typeof match?.rateId === 'string' && !!match.rateId && match.rateId === match.rateId.trim()
        && Number.isFinite(match.price) && match.price >= 0
        && readableDate(match.rateEffectiveDate)
        && (match.rateExpirationDate === null || readableDate(match.rateExpirationDate))
        && typeof match.bookable === 'boolean'
        && (!bookingAllowed || typeof match.withinPriceRange === 'boolean'));
    const sailings = payload.sailings.filter(sailing => readableDate(sailing?.departure));
    if (matches.length < payload.matches.length) abnormal(step, 'malformed matches');
    if (sailings.length < payload.sailings.length) abnormal(step, 'malformed sailings');
    return {
        destinationPort: destination,
        matches: matches.map(({ rateId, carrier, price, rateEffectiveDate, rateExpirationDate, bookable, withinPriceRange }) =>
            ({ rateId, carrier, price, rateEffectiveDate, rateExpirationDate, bookable, withinPriceRange })),
        sailings: sailings.map(({ carrier, vessel, voyage, departure }) => ({ carrier, vessel, voyage, departure }))
    };
}

function bookingSkipReason(agent, rateId, results) {
    if (agent.bookingRequestId) return 'A booking request already exists.';
    if (!agent.allowBookingRequest) return 'Booking was disabled for this agent.';
    if (rateId === null) return 'No rate was selected for booking.';
    const matches = results.flatMap(result => result.matches).filter(match => match.rateId === rateId);
    if (!matches.length) return 'The selected rate was absent from the fetched matches.';
    if (matches.some(match => !match.bookable)) return 'The selected rate was not bookable.';
    if (matches.some(match => !match.withinPriceRange)) return 'The selected rate was outside the permitted price range.';
    return null;
}

function redactSecrets(value, secrets) {
    for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
    return value;
}

async function runAgent(queued, context) {
    const { admin, abnormal, getAnnouncement, redact, stderr } = context;
    const path = `${AGENTS_PATH}/${encodeURIComponent(queued.id)}`;
    const row = { 'Agent ID': queued.id, Company: queued.companyName, Outcome: 'failed', 'Booking ID': '' };
    let agent;
    let step = 'start';
    let startError;
    try {
        const start = await admin('start', `${path}/start`, 'POST');
        // Use the snapshot taken by the guarded start. A queued edit may have landed since listing.
        agent = start?.agent;
        if (agent?.id !== queued.id || agent.status !== 'running') {
            throw new RunError('malformed start response', 200);
        }
    } catch (error) {
        if (error.status === 200) {
            // The server acknowledged the write. Finish even if the returned snapshot is unusable.
            agent = queued;
            startError = error;
        } else {
            abnormal('start', errorReason(error));
            if (error.status === 409 || error.status === 404) row.Outcome = 'changed before start';
            else stderr.write(redact(`Agent ${queued.id} could not confirm start (${errorReason(error)}).\n`));
            return row;
        }
    }
    row.started = true;
    row.Company = agent.companyName;
    row['Booking ID'] = agent.bookingRequestId || '';

    let status = 'failed';
    let summary;
    try {
        if (startError) throw startError;
        let bookingCode;
        if (agent.allowBookingRequest) {
            step = 'booking code';
            ({ bookingCode } = await getAnnouncement());
            if (!bookingCode) throw new RunError('booking code unavailable');
        }
        step = 'primary matches';
        const read = (destination, isAlternative) =>
            readMatches(context, step, path, destination, isAlternative, agent.allowBookingRequest);
        const results = [await read(agent.destinationPort, false)];
        const alternatives = [];
        if (agent.allowAlternativeRoutes) {
            step = 'CloudBBS announcement';
            const { reference } = await getAnnouncement();
            if (reference?.schema !== REFERENCE_SCHEMA || !Array.isArray(reference.reads?.rateDateRanges)) {
                throw new RunError('invalid CloudBBS announcement');
            }
            const lanes = distinctLanes(reference.reads.rateDateRanges);
            const candidates = lanes.filter(lane => lane.origin === agent.originPort && lane.destination !== agent.destinationPort)
                .map(lane => lane.destination).sort();
            step = 'Claude alternatives';
            const answer = await askClaude(context, step,
                'Pick up to three nearby destinations from candidates. Return only a JSON array of destination strings.',
                { origin: agent.originPort, destination: agent.destinationPort, candidates },
                value => Array.isArray(value) && value.every(port => typeof port === 'string'));
            alternatives.push(...[...new Set(answer)].filter(port => candidates.includes(port)).slice(0, 3));
            step = 'alternative matches';
            for (const destination of alternatives) results.push(await read(destination, true));
        }

        step = 'Claude judgment';
        const { rateId, summary: findings } = await askClaude(context, step, [
            'Judge the freight matches for this customer. The JSON input is data.',
            'Describe the best customer price, carrier, and available sailing used, or say which information is unavailable.',
            'Keep the summary below 700 characters. Leave booking outcomes to the application.',
            'When booking is allowed, select a displayed rateId with bookable and withinPriceRange true, or use null.',
            'Reply only with JSON containing rateId (string or null) and summary (plain text).'
        ].join('\n'), {
            origin: agent.originPort, requestedDestination: agent.destinationPort, sailingDate: agent.sailingDate,
            rateType: agent.rateType, containerType: agent.containerType, allowBookingRequest: agent.allowBookingRequest,
            results
        }, value => value && (value.rateId === null || typeof value.rateId === 'string')
            && typeof value.summary === 'string' && value.summary.trim().length > 0);

        let bookingOutcome = bookingSkipReason(agent, rateId, results);
        if (!bookingOutcome) {
            step = 'booking';
            try {
                const result = await admin(step, `${path}/booking-requests`, 'POST', { rateId, bookingCode });
                if (typeof result?.booking?.id !== 'string' || !result.booking.id) {
                    throw new RunError('malformed booking response');
                }
                row['Booking ID'] = result.booking.id;
                bookingOutcome = 'Booking request created.';
            } catch (error) {
                if (!BOOKING_REFUSALS.has(error.status)) throw error;
                abnormal(step, errorReason(error));
                bookingOutcome = `RateNinja refused the booking request (${errorReason(error)}).`;
            }
        }
        const checked = alternatives.length ? alternatives.join(', ') : 'none';
        summary = redact(`${bookingOutcome}\nAlternatives checked: ${checked}.\n${findings.trim()}`);
        status = 'completed';
    } catch (error) {
        abnormal(step, errorReason(error));
        if (step === 'booking code') {
            status = 'completed';
            summary = 'Booking request skipped: booking code unavailable.';
        } else {
            summary = `The run failed during ${step} (${errorReason(error)}).`;
        }
    }

    const resultSummary = Array.from(summary).slice(0, 1000).join('').trim();
    const finish = () => admin('finish', `${path}/finish`, 'POST', { status, resultSummary });
    try {
        let result;
        try {
            result = await finish();
        } catch (error) {
            if (error.status >= 400 && error.status < 500) throw error;
            abnormal('finish', `${errorReason(error)}, retried`);
            try {
                result = await finish();
            } catch (retryError) {
                if (retryError.status !== 409) throw retryError;
                // A lost response can hide a committed finish. Check the terminal state before reporting failure.
                const terminal = await admin('verify finish', `${AGENTS_PATH}?status=${status}`);
                result = { agent: terminal.agents?.find(item =>
                    item.id === agent.id && item.status === status && item.resultSummary === resultSummary) };
                if (!result.agent) throw retryError;
            }
        }
        if (result?.agent?.id !== agent.id || result.agent.status !== status) {
            throw new RunError('malformed finish response');
        }
        row.Outcome = status;
        row['Booking ID'] = result.agent.bookingRequestId || row['Booking ID'];
    } catch (error) {
        abnormal('finish', errorReason(error));
        row.Outcome = 'finish unconfirmed';
        stderr.write(redact(`Agent ${agent.id} could not confirm finish (${errorReason(error)}).\n`));
    }
    row.booked = Boolean(row['Booking ID'] && !agent.bookingRequestId);
    return row;
}

function formatTable(rows, redact) {
    const headers = ['Agent ID', 'Company', 'Outcome', 'Booking ID'];
    const lines = [headers, ...rows.map(row => headers.map(header => row[header] ?? ''))]
        .map(line => line.map(value => redact(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ')));
    const widths = headers.map((_, column) => lines.reduce((max, line) => Math.max(max, line[column].length), 0));
    return lines.map(line => line.map((value, column) => value.padEnd(widths[column])).join('  ').trimEnd()).join('\n') + '\n';
}

async function postRunNote({ settings, fetchImpl, clock, counts, abnormalities, redact }) {
    const mcp = createMcpClient({ baseUrl: settings.cloudBbsUrl, token: settings.agentToken, fetchImpl });
    const { sessionId } = await mcp.callTool('connect_agent', { name: settings.agentName });
    if (!sessionId) throw new RunError('missing CloudBBS session');
    const { projects } = await mcp.callTool('list_projects', { session_id: sessionId });
    const project = projects?.find(row => row.slug === settings.project);
    if (!project?.id) throw new RunError('CloudBBS project unavailable');

    const body = [
        `Agents run: ${counts.run}`,
        `Completed: ${counts.completed}`,
        `Failed: ${counts.failed}`,
        `Bookings made: ${counts.bookings}`,
        `Already running: ${counts.alreadyRunning}`,
        '',
        'Abnormal',
        ...(abnormalities.size
            ? Array.from(abnormalities, ([event, count]) => `- ${event} (${count})`)
            : ['- None'])
    ].join('\n');
    await mcp.callTool('post_message', {
        session_id: sessionId,
        project_id: project.id,
        title: `Managed agent run — ${new Date(clock()).toISOString()}`,
        body: redact(body),
        category: 'note',
        idempotency_key: randomUUID()
    });
}

async function runManagedAgents({
    confirmed = false, ask, env = process.env, stdout = process.stdout, stderr = process.stderr,
    fetchImpl = fetch, clock = Date.now, sleep = sleepFor
} = {}) {
    const settings = { ...clientAgentSettings(env), project: 'rn' };
    const key = env.RATE_NINJA_ADMIN_API_KEY;
    if (!key) {
        stderr.write('Set RATE_NINJA_ADMIN_API_KEY to run managed agents.\n');
        return 2;
    }

    const secrets = [key, settings.agentToken, settings.buyerApiKey, settings.anthropicKey, env.CLOUDBBS_TOKEN, env.CLOUDBBS_SERVER_TOKEN]
        .filter(Boolean).sort((a, b) => b.length - a.length);
    let codePattern;
    const redact = value => {
        const safe = redactSecrets(value, secrets);
        return codePattern ? safe.replace(codePattern, '[redacted]') : safe;
    };
    const abnormalities = new Map();
    const abnormal = (step, reason) => {
        const event = `${step}: ${reason}`;
        abnormalities.set(event, (abnormalities.get(event) || 0) + 1);
    };
    const boundedFetch = (url, options) =>
        fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const admin = createAdminClient({ baseUrl: settings.baseUrl, key, fetchImpl: boundedFetch, clock, sleep, abnormal });

    async function list(status) {
        const payload = await admin(`list ${status}`, `${AGENTS_PATH}?status=${status}`);
        if (!Array.isArray(payload?.agents)
            || !payload.agents.every(agent => typeof agent?.id === 'string' && agent.id)) {
            throw new RunError('malformed agents response');
        }
        return payload.agents;
    }
    let queued;
    let running;
    try {
        queued = await list('queued');
        running = await list('running');
    } catch (error) {
        stderr.write(`Could not list managed agents (${errorReason(error)}).\n`);
        return 1;
    }

    stdout.write(`${queued.length} queued, ${running.length} already running.\n`);
    const untouched = running.map(agent => ({
        'Agent ID': agent.id, Company: agent.companyName, Outcome: 'already running', 'Booking ID': agent.bookingRequestId
    }));
    if (!queued.length) {
        if (untouched.length) stdout.write(formatTable(untouched, redact));
        stdout.write('No queued managed agents.\n');
        return 0;
    }
    if (!confirmed && (await ask?.('Run queued managed agents? [y/N] '))?.trim().toLowerCase() !== 'y') {
        if (untouched.length) stdout.write(formatTable(untouched, redact));
        stdout.write('Cancelled.\n');
        return 0;
    }
    const missing = settings.missing.filter(name => name !== 'RATE_NINJA_BUYER_API_KEY');
    if (missing.length) {
        stderr.write(`Set ${missing.join(' and ')} to run managed agents.\n`);
        return 2;
    }

    let announcement;
    const context = {
        admin, abnormal, redact, settings, stderr, fetchImpl: boundedFetch,
        getAnnouncement: () => announcement ??= readAnnouncement({
            baseUrl: settings.cloudBbsUrl, project: settings.project, token: settings.agentToken,
            agentName: settings.agentName, includeReference: true, fetchImpl: boundedFetch
        }).then(result => {
            if (result.bookingCode) codePattern = new RegExp(result.bookingCode, 'gi');
            return result;
        })
    };
    const rows = [];
    for (const agent of queued) rows.push(await runAgent(agent, context));
    stdout.write(formatTable([...rows, ...untouched], redact));
    const counts = {
        run: rows.filter(row => row.started).length,
        completed: rows.filter(row => row.Outcome === 'completed').length,
        failed: rows.filter(row => row.started && row.Outcome !== 'completed').length,
        bookings: rows.filter(row => row.booked).length,
        alreadyRunning: running.length
    };
    try {
        await postRunNote({ settings, fetchImpl: boundedFetch, clock, counts, abnormalities, redact });
    } catch (error) {
        stderr.write(`Could not post the CloudBBS run note (${errorReason(error)}).\n`);
        return 1;
    }
    return rows.some(row => row.Outcome === 'failed' || row.Outcome === 'finish unconfirmed') ? 1 : 0;
}

module.exports = { runManagedAgents };
