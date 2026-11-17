'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildAnnouncement } = require('../../lib/cloudbbs-post');

const BUYER_KEY = 'r130-buyer-api-key-do-not-leak-xxxxxx';
const AGENT_TOKEN = 'r130-cloudbbs-agent-token-do-not-leak';
const ANNOUNCE_TOKEN = 'r130-cloudbbs-announce-token-leak';
const ANTHROPIC_KEY = 'r130-anthropic-key-do-not-leak-xxxx';
const HOSTILE_MARKER = 'HOSTILE_INJECT_R130_MARKER_XYZ';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';

function mulberry32(seed) {
    let t = seed >>> 0;
    return function random() {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function defaultRateDateRanges(count = 12) {
    const destinations = [
        'Boston', 'Charleston', 'Houston', 'LALB', 'Miami', 'New York',
        'Norfolk', 'Oakland', 'Savannah', 'Seattle', 'Tacoma', 'Vancouver'
    ];
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const destination = destinations[i % destinations.length];
        rows.push({
            originPort: i < 6 ? 'Hai Phong' : 'Ho Chi Minh',
            destinationPort: destination,
            rateEffectiveDate: '2026-10-26',
            rateExpirationDate: '2026-11-19',
            rateCount: 2 + i,
            ownerCompanyId: 'owner-1',
            ownerCompanyName: 'Kings'
        });
        rows.push({
            originPort: i < 6 ? 'Hai Phong' : 'Ho Chi Minh',
            destinationPort: destination,
            rateEffectiveDate: '2026-11-20',
            rateExpirationDate: '2026-12-14',
            rateCount: 2 + i,
            ownerCompanyId: 'owner-1',
            ownerCompanyName: 'Kings'
        });
    }
    return rows;
}

function buildAnnouncementBody({ rateDateRanges = defaultRateDateRanges(), bookingCode = 'ABC123XYZ' } = {}) {
    return buildAnnouncement({
        generatedAt: '2026-11-16T12:00:00.000Z',
        source: 'http://127.0.0.1:9',
        bookingCode,
        reads: {
            rateDateRanges,
            originPorts: [],
            destinationPorts: [],
            contractOwners: [],
            sailingDateRanges: [],
            predictiveDateRanges: []
        }
    }).body;
}

function jsonRpcResult(id, value) {
    return {
        jsonrpc: '2.0',
        id,
        result: {
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }]
        }
    };
}

function jsonRpcToolError(id, code) {
    return {
        jsonrpc: '2.0',
        id,
        result: {
            isError: true,
            structuredContent: { error: { code, message: code } },
            content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }]
        }
    };
}

function startFakeRateNinja({
    buyerKey = BUYER_KEY,
    profile = {
        sub: 'buyer-user',
        name: 'Test Buyer',
        companyId: 'buyer-co',
        companyName: 'Buyer Co',
        companyType: 'Freight Forwarder/Customer',
        active: true
    },
    profileStatus = 200,
    profileError = null,
    laneFail = null,
    rateRowsForLane = null,
    sailingsForOrigin = null
} = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const entry = {
            method: req.method,
            path: url.pathname,
            search: url.search,
            headers: {
                'x-buyer-api-key': req.headers['x-buyer-api-key'] || '',
                authorization: req.headers.authorization || ''
            }
        };
        requests.push(entry);

        const key = req.headers['x-buyer-api-key'] || '';
        if (key !== buyerKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_token' }));
            return;
        }

        if (url.pathname === '/api/partner/v1/me/profile') {
            if (profileStatus !== 200) {
                res.writeHead(profileStatus, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: profileError || 'profile_failed' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(profile));
            return;
        }

        if (url.pathname === '/api/partner/v1/me/available-rates') {
            const origin = url.searchParams.get('originPort') || '';
            const destination = url.searchParams.get('destinationPort') || '';
            if (
                laneFail
                && laneFail.kind === 'rates'
                && (
                    laneFail.any
                    || (laneFail.origin === origin && laneFail.destination === destination)
                )
            ) {
                res.writeHead(laneFail.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: laneFail.error || 'server_error' }));
                return;
            }
            const rows = rateRowsForLane
                ? rateRowsForLane({ origin, destination })
                : [{
                    id: `rate-${origin}-${destination}`,
                    carrier: 'MSC',
                    originPort: origin,
                    destinationPort: destination,
                    inlandDeliveryLocation: '',
                    commodityType: 'FAK',
                    contractOwner: 'Kings',
                    ownerCompanyName: 'Kings',
                    contractNumber: 'C1',
                    rate20D: 1000,
                    rate40D: 1500,
                    rate40HC: 1600,
                    rateEffectiveDate: '2026-10-26',
                    rateExpirationDate: '2026-12-14',
                    notes: '',
                    bookable: true
                }, {
                    id: `rate2-${origin}-${destination}`,
                    carrier: 'ONE',
                    originPort: origin,
                    destinationPort: destination,
                    inlandDeliveryLocation: '',
                    commodityType: 'FAK',
                    contractOwner: 'Kings',
                    ownerCompanyName: 'Kings',
                    contractNumber: 'C2',
                    rate20D: 900,
                    rate40D: 1400,
                    rate40HC: 1550,
                    rateEffectiveDate: '2026-10-26',
                    rateExpirationDate: '2026-12-14',
                    notes: '',
                    bookable: true
                }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: rows, meta: { total: rows.length, page: 1, pageSize: 100, returned: rows.length } }));
            return;
        }

        if (url.pathname === '/api/partner/v1/me/sailings') {
            const origin = url.searchParams.get('originPort') || '';
            if (laneFail && laneFail.kind === 'sailings' && laneFail.origin === origin) {
                res.writeHead(laneFail.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: laneFail.error || 'server_error' }));
                return;
            }
            // Real partner customer sailings: mapSailingRecord + arrivalPort (no departureDate/destinationPort).
            const rows = sailingsForOrigin
                ? sailingsForOrigin({ origin, after: url.searchParams.get('after') || '' })
                : [{
                    id: `sail-${origin}-1`,
                    departure: '2026-11-20',
                    arrival: '2026-12-10',
                    transitTime: 20,
                    vessel: 'Demo Vessel',
                    voyage: 'V1',
                    service: 'Demo',
                    ownerCompanyId: 'owner-1',
                    arrivalPort: 'LALB'
                }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: rows, meta: { total: rows.length, page: 1, pageSize: 100, returned: rows.length } }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                requests,
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close(error => (error ? closeReject(error) : closeResolve()));
                })
            });
        });
        server.on('error', reject);
    });
}

function startFakeCloudBbsMcp({
    token = AGENT_TOKEN,
    announcementBody = buildAnnouncementBody(),
    chunkBytes = 800,
    threads = [],
    agentId = AGENT_ID,
    projectId = PROJECT_ID,
    projectSlug = 'rn',
    onTool = null
} = {}) {
    const toolCalls = [];
    const writes = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try {
                parsed = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                parsed = null;
            }
            const auth = req.headers.authorization || '';
            if (auth !== `Bearer ${token}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32000, message: 'unauthenticated', data: { code: 'unauthenticated' } }
                }));
                return;
            }
            if (req.method !== 'POST' || req.url !== '/api/mcp') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not_found' }));
                return;
            }
            if (!parsed || parsed.method !== 'tools/call') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: parsed?.id ?? null,
                    error: { code: -32601, message: 'Method not found' }
                }));
                return;
            }

            const name = parsed.params?.name;
            const args = parsed.params?.arguments || {};
            const entry = { name, args, authorization: auth, rawBody };
            toolCalls.push(entry);
            if (onTool) onTool(entry);

            if (name === 'connect_agent') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(parsed.id, {
                    agent: { id: agentId, name: args.name || 'rateninja-client-agent' },
                    sessionId: SESSION_ID,
                    capabilities: { canCreateProjects: false },
                    defaults: []
                })));
                return;
            }
            if (name === 'list_projects') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(parsed.id, {
                    projects: [{ id: projectId, slug: projectSlug, name: 'RateNinja', status: 'active' }]
                })));
                return;
            }
            if (name === 'check_board') {
                const offset = args.continuation
                    ? Number(Buffer.from(String(args.continuation), 'base64url').toString('utf8')) || 0
                    : 0;
                const budget = Number(args.budget_bytes) || chunkBytes;
                const slice = announcementBody.slice(offset, offset + Math.min(budget, chunkBytes));
                const nextOffset = offset + slice.length;
                const truncated = nextOffset < announcementBody.length;
                const body = {
                    announcements: {
                        projects: [{
                            id: 'ann-1',
                            scope: 'project',
                            title: 'RateNinja reference data',
                            body: slice,
                            bodyOffset: offset,
                            bodyBytes: Buffer.byteLength(announcementBody, 'utf8'),
                            truncated,
                            continuation: truncated
                                ? Buffer.from(String(nextOffset), 'utf8').toString('base64url')
                                : null
                        }]
                    },
                    groups: {
                        urgent: { none: true, count: 0, threadIds: [] },
                        pinned: { none: true, count: 0, threadIds: [] }
                    },
                    items: []
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(parsed.id, body)));
                return;
            }
            if (name === 'list_messages') {
                let items = threads.slice();
                const filters = args.filters || {};
                if (filters.author_agent_id) {
                    items = items.filter(t => t.authorAgentId === filters.author_agent_id);
                }
                if (filters.urgent === true) {
                    items = items.filter(t => t.urgent);
                }
                if (filters.pinned === true) {
                    items = items.filter(t => t.pinned);
                }
                if (filters.status && filters.status !== 'all') {
                    items = items.filter(t => (t.status || 'active') === filters.status);
                }
                items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(parsed.id, {
                    items,
                    totalCount: items.length,
                    nextCursor: null
                })));
                return;
            }
            if (name === 'post_message' || name === 'reply_message') {
                writes.push({ name, args });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(parsed.id, {
                    id: name === 'post_message' ? '55555555-5555-4555-8555-555555555555' : '66666666-6666-4666-8666-666666666666',
                    title: args.title || null,
                    rootId: args.root_id || null
                })));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jsonRpcToolError(parsed.id, 'validation_failed')));
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                toolCalls,
                writes,
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close(error => (error ? closeReject(error) : closeResolve()));
                })
            });
        });
        server.on('error', reject);
    });
}

function startFakeClaude({
    apiKey = ANTHROPIC_KEY,
    replyFactory = null,
    rawText = null,
    status = 200
} = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try {
                body = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                body = null;
            }
            requests.push({
                method: req.method,
                url: req.url,
                headers: {
                    'x-api-key': req.headers['x-api-key'] || '',
                    authorization: req.headers.authorization || ''
                },
                body,
                rawBody
            });
            if (req.headers['x-api-key'] !== apiKey) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'authentication_error' } }));
                return;
            }
            if (status !== 200) {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'api_error' } }));
                return;
            }
            let text = rawText;
            if (text == null) {
                const user = body?.messages?.[0]?.content || '';
                let lanes = [];
                try {
                    const jsonStart = user.lastIndexOf('[');
                    lanes = JSON.parse(user.slice(jsonStart));
                } catch {
                    lanes = [];
                }
                if (replyFactory) {
                    text = replyFactory(lanes, body);
                } else {
                    text = JSON.stringify(lanes.map(lane => ({
                        origin: lane.origin,
                        destination: lane.destination,
                        verdict: 'good',
                        reason: 'Adequate coverage and pricing.'
                    })));
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_test',
                model: body?.model || 'claude-sonnet-5-5',
                content: [{ type: 'text', text }]
            }));
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                requests,
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close(error => (error ? closeReject(error) : closeResolve()));
                })
            });
        });
        server.on('error', reject);
    });
}

function runClientAgentCli(args, {
    env = {},
    input = null,
    timeoutMs = 20_000
} = {}) {
    const cliEnv = {
        ...process.env,
        ...env
    };
    for (const key of [
        'RATE_NINJA_BUYER_API_KEY',
        'CLOUDBBS_AGENT_TOKEN',
        'CLOUDBBS_TOKEN',
        'ANTHROPIC_API_KEY',
        'RATE_NINJA_ADMIN_API_KEY',
        'CLIENT_AGENT_MODEL',
        'CLOUDBBS_AGENT_NAME'
    ]) {
        if (!Object.prototype.hasOwnProperty.call(env, key)) {
            delete cliEnv[key];
        }
    }
    return new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'rateninja-admin.js'), ...args], {
            cwd: path.join(__dirname, '..', '..'),
            env: cliEnv,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            resolve({ status: null, stdout, stderr, signal: 'SIGTERM', timedOut: true });
        }, timeoutMs);
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('close', (status, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status, stdout, stderr, signal, timedOut: false });
        });
        if (input != null) child.stdin.write(input);
        child.stdin.end();
    });
}

function assertSecretsAbsent(result, secrets, extras = []) {
    const haystacks = [result.stdout, result.stderr, ...extras];
    for (const secret of secrets) {
        if (!secret) continue;
        for (const hay of haystacks) {
            if (typeof hay === 'string' && hay.includes(secret)) {
                throw new Error(`Secret leaked: ${secret.slice(0, 8)}…`);
            }
            if (hay && typeof hay === 'object') {
                const text = JSON.stringify(hay);
                if (text.includes(secret)) {
                    throw new Error(`Secret leaked in object: ${secret.slice(0, 8)}…`);
                }
            }
        }
    }
}

function secrets() {
    return [BUYER_KEY, AGENT_TOKEN, ANNOUNCE_TOKEN, ANTHROPIC_KEY];
}

module.exports = {
    BUYER_KEY,
    AGENT_TOKEN,
    ANNOUNCE_TOKEN,
    ANTHROPIC_KEY,
    HOSTILE_MARKER,
    PROJECT_ID,
    AGENT_ID,
    SESSION_ID,
    OTHER_AGENT_ID,
    mulberry32,
    defaultRateDateRanges,
    buildAnnouncementBody,
    startFakeRateNinja,
    startFakeCloudBbsMcp,
    startFakeClaude,
    runClientAgentCli,
    assertSecretsAbsent,
    secrets
};
