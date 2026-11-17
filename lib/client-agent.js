'use strict';

const { Console } = require('node:console');
const { extractJsonBlock, DEFAULT_CLOUDBBS_URL, DEFAULT_CLOUDBBS_PROJECT } = require('./cloudbbs-post');

const DEFAULT_BASE_URL = 'https://rate-ninja.onrender.com';
const DEFAULT_AGENT_NAME = 'rateninja-client-agent';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TITLE_PREFIX = 'Client agent searches';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const POST_BODY_CAP = 16384;
const VERDICTS = new Set(['good', 'fair', 'poor']);
const HOSTILE_SAFE_STEPS = Object.freeze(['profile', 'cloudbbs-read', 'query', 'judge']);

function normalizeBaseUrl(value, fallback) {
    if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\/$/, '');
    }
    return fallback;
}

function clientAgentSettings(env = process.env) {
    const missing = [];
    const buyerApiKey = typeof env.RATE_NINJA_BUYER_API_KEY === 'string' ? env.RATE_NINJA_BUYER_API_KEY : '';
    const agentToken = typeof env.CLOUDBBS_AGENT_TOKEN === 'string' ? env.CLOUDBBS_AGENT_TOKEN : '';
    const anthropicKey = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '';
    if (!buyerApiKey) missing.push('RATE_NINJA_BUYER_API_KEY');
    if (!agentToken) missing.push('CLOUDBBS_AGENT_TOKEN');
    if (!anthropicKey) missing.push('ANTHROPIC_API_KEY');
    return {
        missing,
        buyerApiKey,
        agentToken,
        anthropicKey,
        baseUrl: normalizeBaseUrl(env.RATE_NINJA_BASE_URL, DEFAULT_BASE_URL),
        cloudBbsUrl: normalizeBaseUrl(env.CLOUDBBS_URL, DEFAULT_CLOUDBBS_URL),
        project: (typeof env.CLOUDBBS_PROJECT === 'string' && env.CLOUDBBS_PROJECT.trim())
            ? env.CLOUDBBS_PROJECT.trim()
            : DEFAULT_CLOUDBBS_PROJECT,
        agentName: (typeof env.CLOUDBBS_AGENT_NAME === 'string' && env.CLOUDBBS_AGENT_NAME.trim())
            ? env.CLOUDBBS_AGENT_NAME.trim()
            : DEFAULT_AGENT_NAME,
        model: (typeof env.CLIENT_AGENT_MODEL === 'string' && env.CLIENT_AGENT_MODEL.trim())
            ? env.CLIENT_AGENT_MODEL.trim()
            : DEFAULT_MODEL,
        anthropicBaseUrl: normalizeBaseUrl(env.CLIENT_AGENT_ANTHROPIC_URL, 'https://api.anthropic.com')
    };
}

function distinctLanes(rateDateRanges) {
    const seen = new Set();
    const lanes = [];
    for (const row of rateDateRanges || []) {
        const origin = row && row.originPort;
        const destination = row && row.destinationPort;
        if (typeof origin !== 'string' || !origin || typeof destination !== 'string' || !destination) {
            continue;
        }
        const key = `${origin}\0${destination}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lanes.push({ origin, destination });
    }
    return lanes;
}

function pickLanes(rateDateRanges, count = 10, random = Math.random) {
    const lanes = distinctLanes(rateDateRanges);
    const shuffled = lanes.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }
    const n = Math.max(0, Math.min(Number(count) || 0, shuffled.length));
    return shuffled.slice(0, n);
}

function utcDateString(now) {
    const d = now instanceof Date ? now : new Date(now);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function weekOfTitle(now) {
    return `${TITLE_PREFIX} — week of ${utcDateString(now)}`;
}

function chooseWeeklyThread(threads, { now = new Date(), agentId } = {}) {
    const own = (threads || [])
        .filter(thread => (
            thread
            && thread.authorAgentId === agentId
            && typeof thread.title === 'string'
            && thread.title.startsWith(TITLE_PREFIX)
        ))
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const newest = own[0];
    if (!newest) {
        return { action: 'new', title: weekOfTitle(now) };
    }
    const ageMs = now.getTime() - new Date(newest.createdAt).getTime();
    if (ageMs < SEVEN_DAYS_MS) {
        return { action: 'reply', rootId: newest.id, title: newest.title };
    }
    return { action: 'new', title: weekOfTitle(now) };
}

function lowestPricesByContainer(rates) {
    const result = {};
    for (const field of ['rate20D', 'rate40D', 'rate40HC']) {
        let lowest = null;
        for (const rate of rates || []) {
            const value = rate && rate[field];
            if (typeof value === 'number' && Number.isFinite(value)) {
                if (lowest == null || value < lowest) lowest = value;
            }
        }
        if (lowest != null) result[field] = lowest;
    }
    return result;
}

function nextSailingDate(sailings, { todayUtc = utcDateString(new Date()) } = {}) {
    let next = null;
    for (const sailing of sailings || []) {
        const date = sailing && (sailing.departureDate || sailing.etd || sailing.sailingDate);
        if (typeof date !== 'string' || !date) continue;
        const day = date.slice(0, 10);
        if (day <= todayUtc) continue;
        if (next == null || day < next) next = day;
    }
    return next;
}

function laneKey(origin, destination) {
    return `${origin}\0${destination}`;
}

function validateVerdicts(raw, expectedLanes) {
    let list = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.verdicts)) {
        list = raw.verdicts;
    }
    if (!Array.isArray(list)) {
        const err = new Error('Claude reply is not a JSON array of verdicts');
        err.code = 'invalid_verdicts';
        throw err;
    }
    if (list.length !== expectedLanes.length) {
        const err = new Error(`Claude returned ${list.length} verdicts; expected ${expectedLanes.length}`);
        err.code = 'invalid_verdicts';
        throw err;
    }
    const byKey = new Map();
    for (const item of list) {
        if (!item || typeof item !== 'object') {
            const err = new Error('Claude verdict entry is not an object');
            err.code = 'invalid_verdicts';
            throw err;
        }
        const origin = item.origin;
        const destination = item.destination;
        const verdict = item.verdict;
        const reason = item.reason;
        if (typeof origin !== 'string' || typeof destination !== 'string') {
            const err = new Error('Claude verdict missing origin/destination');
            err.code = 'invalid_verdicts';
            throw err;
        }
        if (!VERDICTS.has(verdict)) {
            const err = new Error(`Unknown verdict: ${String(verdict)}`);
            err.code = 'invalid_verdicts';
            throw err;
        }
        if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
            const err = new Error('Claude reason must be a non-empty string of at most 200 characters');
            err.code = 'invalid_verdicts';
            throw err;
        }
        const key = laneKey(origin, destination);
        if (byKey.has(key)) {
            const err = new Error('Claude returned duplicate lane verdicts');
            err.code = 'invalid_verdicts';
            throw err;
        }
        byKey.set(key, { origin, destination, verdict, reason });
    }
    const ordered = [];
    for (const lane of expectedLanes) {
        const found = byKey.get(laneKey(lane.origin, lane.destination));
        if (!found) {
            const err = new Error(`Claude omitted lane ${lane.origin} → ${lane.destination}`);
            err.code = 'invalid_verdicts';
            throw err;
        }
        ordered.push(found);
    }
    return ordered;
}

function parseClaudeJson(text) {
    if (typeof text !== 'string' || !text.trim()) {
        const err = new Error('Claude reply was empty');
        err.code = 'invalid_verdicts';
        throw err;
    }
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const fenced = /```(?:json)?\n([\s\S]*?)\n```/.exec(trimmed);
        if (fenced) {
            try {
                return JSON.parse(fenced[1]);
            } catch {
                // fall through
            }
        }
        const start = trimmed.search(/[\[{]/);
        const endObj = trimmed.lastIndexOf('}');
        const endArr = trimmed.lastIndexOf(']');
        const end = Math.max(endObj, endArr);
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch {
                // fall through
            }
        }
        const err = new Error('Claude reply was not JSON');
        err.code = 'invalid_verdicts';
        throw err;
    }
}

function buildSummaryMessage({
    runAt,
    companyName,
    lanes,
    bookingCode = null
}) {
    const lines = [
        `# Client agent search`,
        ``,
        `Run (UTC): ${runAt}`,
        `Buyer company: ${companyName || '(unknown)'}`,
    ];
    if (bookingCode) {
        lines.push(`Announcement booking code: ${bookingCode}`);
    }
    lines.push('', '| Origin | Destination | Rates | Lowest 20D | Lowest 40D | Lowest 40HC | Next sailing | Verdict | Reason |', '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
    for (const lane of lanes) {
        const prices = lane.lowestPrices || {};
        lines.push(
            `| ${lane.origin} | ${lane.destination} | ${lane.rateCount} | ${prices.rate20D ?? '—'} | ${prices.rate40D ?? '—'} | ${prices.rate40HC ?? '—'} | ${lane.nextSailing || '—'} | ${lane.verdict} | ${lane.reason.replace(/\|/g, '/')} |`
        );
    }
    const body = `${lines.join('\n')}\n`;
    if (Buffer.byteLength(body, 'utf8') > POST_BODY_CAP) {
        const err = new Error(`Summary body is over ${POST_BODY_CAP} bytes`);
        err.code = 'summary_too_large';
        throw err;
    }
    return body;
}

function formatDisplayRows(lanes) {
    return lanes.map(lane => ({
        origin: lane.origin,
        destination: lane.destination,
        rates: lane.rateCount,
        lowest20D: lane.lowestPrices?.rate20D ?? '—',
        lowest40D: lane.lowestPrices?.rate40D ?? '—',
        lowest40HC: lane.lowestPrices?.rate40HC ?? '—',
        nextSailing: lane.nextSailing || '—',
        verdict: lane.verdict,
        reason: lane.reason
    }));
}

function stepError(step, status, code, message) {
    const err = new Error(message || code || 'failed');
    err.step = step;
    err.status = status;
    err.code = code || 'failed';
    return err;
}

function formatStepFailure(error) {
    const step = error && error.step ? error.step : 'unknown';
    const status = error && error.status != null ? error.status : '-';
    const code = error && error.code ? error.code : 'failed';
    return `step ${step}: ${status} ${code}`;
}

async function partnerGet(baseUrl, buyerApiKey, path, { query = {}, fetchImpl = fetch, step = 'query' } = {}) {
    const url = new URL(path, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
        if (value == null || value === '') continue;
        url.searchParams.set(key, String(value));
    }
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { 'X-Buyer-API-Key': buyerApiKey }
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        throw stepError(step, '-', 'network_failure', message);
    }
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = { error: text || 'invalid_response' };
    }
    return { status: response.status, ok: response.ok, body, text };
}

function createMcpClient({ baseUrl, token, fetchImpl = fetch }) {
    let nextId = 1;
    const writes = [];
    async function callTool(name, args) {
        const id = nextId;
        nextId += 1;
        const requestBody = {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args || {} }
        };
        let response;
        try {
            response = await fetchImpl(`${baseUrl}/api/mcp`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify(requestBody)
            });
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            throw stepError('cloudbbs-read', '-', 'network_failure', message);
        }
        const text = await response.text();
        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            throw stepError('cloudbbs-read', response.status, 'invalid_mcp_response', 'CloudBBS MCP returned non-JSON');
        }
        if (!response.ok) {
            const code = payload?.error?.data?.code || payload?.error?.message || 'mcp_http_error';
            throw stepError('cloudbbs-read', response.status, code, String(code));
        }
        if (payload.error) {
            const code = payload.error.data?.code || payload.error.message || 'mcp_error';
            throw stepError('cloudbbs-read', response.status, code, String(code));
        }
        const result = payload.result || {};
        if (result.isError) {
            const code = result.structuredContent?.error?.code || 'mcp_tool_error';
            throw stepError('cloudbbs-read', response.status, code, String(code));
        }
        let data = result.structuredContent;
        if (data == null) {
            const textBlock = Array.isArray(result.content)
                ? result.content.filter(block => block && block.type === 'text').map(block => block.text).join('')
                : '';
            try {
                data = textBlock ? JSON.parse(textBlock) : {};
            } catch {
                data = { text: textBlock };
            }
        }
        if (name === 'post_message' || name === 'reply_message') {
            writes.push({ name, args, requestBody, data });
        }
        return data;
    }
    return { callTool, writes };
}

async function readFullAnnouncement(mcp, { sessionId, projectId, budgetBytes = 60000 }) {
    let continuation = undefined;
    let body = '';
    let bookingCode = null;
    let title = null;
    let safety = 0;
    while (safety < 64) {
        safety += 1;
        const args = {
            session_id: sessionId,
            project_id: projectId,
            budget_bytes: budgetBytes,
            format: 'json'
        };
        if (continuation) args.continuation = continuation;
        const board = await mcp.callTool('check_board', args);
        const announcements = board?.announcements?.projects || [];
        const chunk = announcements[0];
        if (!chunk) {
            if (!body) {
                throw stepError('cloudbbs-read', 200, 'missing_reference_block', 'No project announcement');
            }
            break;
        }
        title = chunk.title || title;
        const offset = Number(chunk.bodyOffset) || 0;
        const piece = typeof chunk.body === 'string' ? chunk.body : '';
        if (offset === body.length) {
            body += piece;
        } else if (offset < body.length && body.slice(offset, offset + piece.length) === piece) {
            // overlapping replay; ignore
        } else if (offset > body.length) {
            body = body.padEnd(offset, '\0') + piece;
        } else {
            body = body.slice(0, offset) + piece;
        }
        if (chunk.truncated && chunk.continuation) {
            continuation = chunk.continuation;
            continue;
        }
        break;
    }
    let reference;
    try {
        reference = extractJsonBlock(body);
    } catch {
        reference = null;
    }
    if (!reference || reference.schema !== 'rateninja.reference.v1') {
        throw stepError('cloudbbs-read', 200, 'missing_reference_block', 'Announcement JSON block missing or invalid');
    }
    bookingCode = typeof reference.bookingCode === 'string' ? reference.bookingCode : null;
    return { body, title, reference, bookingCode, boardMeta: null };
}

async function listImportantThreadTitles(mcp, { sessionId, projectId }) {
    const titles = [];
    const seen = new Set();
    for (const flag of ['urgent', 'pinned']) {
        const filters = { status: 'active' };
        filters[flag] = true;
        const listed = await mcp.callTool('list_messages', {
            session_id: sessionId,
            project_id: projectId,
            filters,
            sort: 'newest',
            limit: 50
        });
        for (const item of listed?.items || []) {
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);
            if (typeof item.title === 'string' && item.title) titles.push(item.title);
        }
    }
    return titles;
}

async function listOwnClientThreads(mcp, { sessionId, projectId, agentId }) {
    const listed = await mcp.callTool('list_messages', {
        session_id: sessionId,
        project_id: projectId,
        filters: {
            status: 'active',
            author_agent_id: agentId
        },
        sort: 'newest',
        limit: 50
    });
    return listed?.items || [];
}

async function queryLane(settings, lane, { todayUtc, fetchImpl }) {
    const ratesRes = await partnerGet(settings.baseUrl, settings.buyerApiKey, '/api/partner/v1/me/available-rates', {
        query: {
            originPort: lane.origin,
            destinationPort: lane.destination,
            page: 1,
            pageSize: 100
        },
        fetchImpl
    });
    if (!ratesRes.ok) {
        throw stepError(
            'query',
            ratesRes.status,
            ratesRes.body?.error || 'rates_failed',
            `rates ${lane.origin}→${lane.destination}`
        );
    }
    const sailingsRes = await partnerGet(settings.baseUrl, settings.buyerApiKey, '/api/partner/v1/me/sailings', {
        query: {
            originPort: lane.origin,
            after: todayUtc,
            page: 1,
            pageSize: 100
        },
        fetchImpl
    });
    if (!sailingsRes.ok) {
        throw stepError(
            'query',
            sailingsRes.status,
            sailingsRes.body?.error || 'sailings_failed',
            `sailings ${lane.origin}→${lane.destination}`
        );
    }
    const rates = Array.isArray(ratesRes.body?.data) ? ratesRes.body.data : [];
    const sailingsRaw = Array.isArray(sailingsRes.body?.data) ? sailingsRes.body.data : [];
    const sailings = sailingsRaw.filter(row => {
        const dest = row && (row.destinationPort || row.destination);
        if (dest == null || dest === '') return true;
        return String(dest).toLowerCase() === String(lane.destination).toLowerCase();
    });
    return {
        origin: lane.origin,
        destination: lane.destination,
        rateCount: rates.length,
        lowestPrices: lowestPricesByContainer(rates),
        nextSailing: nextSailingDate(sailings, { todayUtc }),
        rates,
        sailings
    };
}

function lanesForClaude(laneResults) {
    return laneResults.map(lane => ({
        origin: lane.origin,
        destination: lane.destination,
        rateCount: lane.rateCount,
        lowestPrices: lane.lowestPrices,
        nextSailing: lane.nextSailing
    }));
}

async function callClaudeJudge({
    apiKey,
    model,
    laneResults,
    anthropicBaseUrl = 'https://api.anthropic.com',
    fetchImpl = fetch
}) {
    const userContent = [
        'Score these ocean freight lane search results.',
        'Reply with ONLY a JSON array. One object per lane, same origin/destination values.',
        'Each object keys: origin, destination, verdict, reason.',
        'verdict must be exactly one of: good, fair, poor.',
        'reason must be one line of at most 200 characters.',
        'Do not include markdown fences or any other text.',
        '',
        JSON.stringify(lanesForClaude(laneResults))
    ].join('\n');
    const requestBody = {
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: userContent }]
    };
    let response;
    try {
        response = await fetchImpl(`${anthropicBaseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(requestBody)
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        throw stepError('judge', '-', 'network_failure', message);
    }
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        throw stepError('judge', response.status, 'invalid_claude_response', 'Claude returned non-JSON HTTP body');
    }
    if (!response.ok) {
        throw stepError('judge', response.status, payload?.error?.type || 'claude_unavailable', 'Claude request failed');
    }
    const replyText = Array.isArray(payload.content)
        ? payload.content.filter(block => block && block.type === 'text').map(block => block.text).join('')
        : '';
    let parsed;
    let verdicts;
    try {
        parsed = parseClaudeJson(replyText);
        verdicts = validateVerdicts(parsed, laneResults);
    } catch (error) {
        throw stepError('judge', response.status, error.code || 'invalid_verdicts', error.message);
    }
    return { verdicts, requestBody, replyText };
}

async function runClientAgent({
    confirmed = false,
    ask = null,
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = fetch,
    random = Math.random,
    now = () => new Date(),
    mcpFactory = createMcpClient,
    judgeFn = callClaudeJudge
} = {}) {
    const settings = clientAgentSettings(env);
    if (settings.missing.length) {
        const name = settings.missing[0];
        stderr.write(`Set ${name} in the environment or .env\n`);
        return 2;
    }

    const runAtDate = now();
    const runAt = runAtDate.toISOString();
    const todayUtc = utcDateString(runAtDate);
    const mcp = mcpFactory({
        baseUrl: settings.cloudBbsUrl,
        token: settings.agentToken,
        fetchImpl
    });

    let companyName = '';
    let bookingCode = null;
    let importantTitles = [];
    let laneResults = [];
    let verdicts = [];
    let judgeRequestBody = null;

    try {
        // Step 1 — RateNinja login
        const profileRes = await partnerGet(
            settings.baseUrl,
            settings.buyerApiKey,
            '/api/partner/v1/me/profile',
            { fetchImpl, step: 'profile' }
        );
        if (!profileRes.ok) {
            throw stepError(
                'profile',
                profileRes.status,
                profileRes.body?.error || 'profile_failed',
                'profile request failed'
            );
        }
        companyName = profileRes.body?.companyName || '';
        const who = profileRes.body?.name || profileRes.body?.sub || 'buyer';
        stdout.write(`Signed in as ${who} (${companyName || 'unknown company'})\n`);

        // Step 2 — CloudBBS read
        const connected = await mcp.callTool('connect_agent', { name: settings.agentName });
        const sessionId = connected.sessionId;
        const agentId = connected.agent?.id;
        if (!sessionId || !agentId) {
            throw stepError('cloudbbs-read', 200, 'connect_failed', 'connect_agent missing session');
        }
        const projects = await mcp.callTool('list_projects', { session_id: sessionId });
        const project = (projects.projects || []).find(row => row.slug === settings.project);
        if (!project) {
            throw stepError('cloudbbs-read', 200, 'project_not_found', `Project ${settings.project} not found`);
        }
        const announcement = await readFullAnnouncement(mcp, {
            sessionId,
            projectId: project.id
        });
        bookingCode = announcement.bookingCode;
        importantTitles = await listImportantThreadTitles(mcp, {
            sessionId,
            projectId: project.id
        });

        // Step 3 — Pick lanes
        const picked = pickLanes(announcement.reference?.reads?.rateDateRanges || [], 10, random);
        if (picked.length === 0) {
            throw stepError('cloudbbs-read', 200, 'missing_reference_block', 'No lanes in rateDateRanges');
        }

        // Step 4 — Query rates and sailings
        for (const lane of picked) {
            laneResults.push(await queryLane(settings, lane, { todayUtc, fetchImpl }));
        }

        // Step 5 — Judge
        const judged = await judgeFn({
            apiKey: settings.anthropicKey,
            model: settings.model,
            laneResults,
            anthropicBaseUrl: settings.anthropicBaseUrl,
            fetchImpl
        });
        verdicts = judged.verdicts;
        judgeRequestBody = judged.requestBody;

        // Merge verdicts onto lane results (validated reasons only)
        for (let i = 0; i < laneResults.length; i += 1) {
            laneResults[i] = {
                ...laneResults[i],
                verdict: verdicts[i].verdict,
                reason: verdicts[i].reason
            };
        }

        // Step 6 — Display
        stdout.write('\nLane results:\n');
        // Route through the injectable streams so tests and redirected output stay consistent.
        new Console(stdout, stderr).table(formatDisplayRows(laneResults));
        if (bookingCode) {
            stdout.write(`Announcement booking code: ${bookingCode}\n`);
        }
        if (importantTitles.length) {
            stdout.write('Urgent/pinned threads:\n');
            for (const title of importantTitles) {
                stdout.write(`- ${title}\n`);
            }
        } else {
            stdout.write('Urgent/pinned threads: none\n');
        }

        // Step 7 — Post (optional)
        let shouldPost = confirmed;
        if (!shouldPost && ask) {
            const prompt =
                `Post the summary to ${settings.cloudBbsUrl}/${settings.project}? [y/N] `;
            const answer = await ask(prompt);
            if (answer != null) {
                const trimmed = String(answer).trim().toLowerCase();
                shouldPost = trimmed === 'y' || trimmed === 'yes';
            }
        }
        if (!shouldPost) {
            stdout.write('Cancelled.\n');
            return 0;
        }

        const ownThreads = await listOwnClientThreads(mcp, {
            sessionId,
            projectId: project.id,
            agentId
        });
        const choice = chooseWeeklyThread(ownThreads, { now: runAtDate, agentId });
        const body = buildSummaryMessage({
            runAt,
            companyName,
            lanes: laneResults,
            bookingCode
        });
        const idempotencyKey = `client-agent-${runAt}`;
        if (choice.action === 'reply') {
            await mcp.callTool('reply_message', {
                session_id: sessionId,
                root_id: choice.rootId,
                body,
                idempotency_key: idempotencyKey
            });
            stdout.write(`Replied to thread ${choice.rootId}\n`);
        } else {
            await mcp.callTool('post_message', {
                session_id: sessionId,
                project_id: project.id,
                title: choice.title,
                body,
                category: 'note',
                urgent: false,
                pinned: false,
                idempotency_key: idempotencyKey
            });
            stdout.write(`Posted thread: ${choice.title}\n`);
        }
        return 0;
    } catch (error) {
        if (error && HOSTILE_SAFE_STEPS.includes(error.step)) {
            stderr.write(`${formatStepFailure(error)}\n`);
            return 1;
        }
        if (error && error.step) {
            stderr.write(`${formatStepFailure(error)}\n`);
            return 1;
        }
        const message = error && error.message ? error.message : String(error);
        stderr.write(`${message}\n`);
        return 1;
    } finally {
        void judgeRequestBody;
    }
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_AGENT_NAME,
    DEFAULT_MODEL,
    TITLE_PREFIX,
    SEVEN_DAYS_MS,
    POST_BODY_CAP,
    clientAgentSettings,
    distinctLanes,
    pickLanes,
    utcDateString,
    weekOfTitle,
    chooseWeeklyThread,
    lowestPricesByContainer,
    nextSailingDate,
    validateVerdicts,
    parseClaudeJson,
    buildSummaryMessage,
    formatDisplayRows,
    formatStepFailure,
    createMcpClient,
    callClaudeJudge,
    lanesForClaude,
    runClientAgent
};
