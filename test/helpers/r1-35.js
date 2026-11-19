'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { CODE, referenceBody } = require('./r1-37');
const { ADMIN_KEY, CLOUD_TOKEN, ROOT } = require('./r1-34');

const CLAUDE_KEY = 'distinctive-r135-synthetic-claude-key';
const ORIGIN = 'synthetic-private-origin';
const DESTINATION = 'synthetic-private-destination';
const ALTERNATIVES = ['synthetic-alt-one', 'synthetic-alt-two', 'synthetic-alt-three', 'synthetic-alt-four'];
const PRICE = 76543.21;
const RATE_ID = 'synthetic-private-rate-id';
const CARRIER = 'synthetic-private-carrier';
const COMPANY = 'synthetic-private-company';
const CREATOR = 'synthetic-private-creator';
const PAYLOAD = '<img src=x onerror=alert(1)>';
const env = {
    RATE_NINJA_BASE_URL: 'http://rateninja.invalid',
    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
    RATE_NINJA_BUYER_API_KEY: '',
    CLOUDBBS_URL: 'http://cloudbbs.invalid',
    CLOUDBBS_AGENT_TOKEN: CLOUD_TOKEN,
    CLOUDBBS_PROJECT: 'decoy',
    CLOUDBBS_TOKEN: '',
    ANTHROPIC_API_KEY: CLAUDE_KEY,
    CLIENT_AGENT_ANTHROPIC_URL: 'http://claude.invalid',
    CLIENT_AGENT_MODEL: 'synthetic-claude'
};

function agent(id, more = {}) {
    return {
        id, status: 'queued', companyName: COMPANY, creatorName: CREATOR,
        rateType: 'Port to Port', originPort: ORIGIN, destinationPort: DESTINATION,
        sailingDate: '2026-12-01', containerType: '20D', allowAlternativeRoutes: false,
        allowBookingRequest: true, bookingRequestId: null, ...more
    };
}

function matches(destination, overrides = {}) {
    return {
        destinationPort: destination,
        matches: [{
            price: PRICE, rateId: RATE_ID, carrier: CARRIER, bookable: true, withinPriceRange: true,
            rateEffectiveDate: '2026-11-01', rateExpirationDate: null, ...overrides
        }],
        sailings: [{ departure: '2026-12-01' }]
    };
}

function fakeProviders({ judge, alternatives, lanes, postStatus = 200, bookingCode = CODE } = {}) {
    const calls = [];
    const posts = [];
    const ranges = lanes ?? ALTERNATIVES.map(destinationPort => ({ originPort: ORIGIN, destinationPort }))
        .concat({ originPort: 'other-origin', destinationPort: 'off-list-port' });
    const body = referenceBody(bookingCode, { rateDateRanges: ranges });

    function reply(url, method, payload) {
        if (url.pathname === '/api/mcp') {
            const { name, arguments: args } = payload.params;
            calls.push({ provider: 'cloud', name, args, method });
            if (name === 'post_message') {
                posts.push(args);
                if (postStatus !== 200) return Response.json({ error: { message: CLOUD_TOKEN } }, { status: postStatus });
            }
            const page = args.continuation ? { body: body.slice(43), bodyOffset: 43 }
                : { body: body.slice(0, 43), truncated: true, continuation: 'next' };
            const data = {
                connect_agent: { sessionId: 'test-session' },
                list_projects: { projects: [{ slug: 'rn', id: 'test-rn' }, { slug: 'decoy', id: 'test-decoy' }] },
                check_board: { announcements: { projects: [page] } },
                post_message: { id: 'test-note' }
            }[name];
            return Response.json({ jsonrpc: '2.0', id: payload.id, result: { structuredContent: data } });
        }
        if (url.pathname !== '/v1/messages') throw new Error('Unexpected provider route.');
        const message = payload.messages[0].content;
        const input = JSON.parse(message.slice(message.lastIndexOf('\n') + 1));
        const isAlternatives = !!input.candidates;
        calls.push({ provider: 'claude', name: isAlternatives ? 'alternatives' : 'judge', input, model: payload.model });
        const answer = isAlternatives
            ? (alternatives?.(input) ?? ['off-list-port', ...ALTERNATIVES, ALTERNATIVES[0]])
            : (judge?.(input) ?? { rateId: RATE_ID, summary: 'Synthetic findings.' });
        return answer instanceof Response ? answer
            : Response.json({ content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] });
    }
    return { reply, calls, posts };
}

function fakeAdmin(agents, responder) {
    const calls = [];
    const states = new Map(agents.map(value => [value.id, { ...value }]));
    function reply(url, method, body, time) {
        const [id, step = 'list'] = url.pathname.slice(ROOT.length).split('/').filter(Boolean);
        const row = states.get(id);
        const destination = url.searchParams.get('destinationPort') ?? row?.destinationPort;
        const call = { method, id, step, body, destination, time, status: url.searchParams.get('status') };
        calls.push(call);
        const special = responder?.(call, row);
        if (special) return special;
        if (step === 'list') return Response.json({ agents: [...states.values()].filter(a => a.status === call.status) });
        if (step === 'matches') return Response.json(matches(destination));
        if (step === 'start') {
            row.status = 'running';
            return Response.json({ agent: row });
        }
        if (step === 'booking-requests') {
            row.bookingRequestId = 'booking-' + id;
            return Response.json({ booking: { id: row.bookingRequestId } }, { status: 201 });
        }
        if (step !== 'finish') throw new Error('Unexpected admin route.');
        Object.assign(row, body);
        return Response.json({ agent: row });
    }
    return { reply, states, calls };
}

async function serveProviders(options) {
    const fake = fakeProviders(options);
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const result = fake.reply(new URL(request.url, 'http://localhost'), request.method, JSON.parse(Buffer.concat(chunks)));
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(await result.text());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        ...fake,
        baseUrl: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

async function cli(app, providers, args, input = '') {
    const child = spawn(process.execPath, [path.join(__dirname, '../../scripts/rateninja-admin.js'), ...args], {
        cwd: app.directory,
        env: { ...process.env, ...env, RATE_NINJA_BASE_URL: app.baseUrl, CLOUDBBS_URL: providers.baseUrl,
            CLIENT_AGENT_ANTHROPIC_URL: providers.baseUrl, SQLITE_DB_PATH: app.dbPath },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.end(input);
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
}

module.exports = {
    ADMIN_KEY, CLOUD_TOKEN, CLAUDE_KEY, ROOT, ORIGIN, DESTINATION, ALTERNATIVES, PRICE, RATE_ID, CARRIER,
    COMPANY, CREATOR, PAYLOAD, env, agent, matches, fakeProviders, fakeAdmin, serveProviders, cli
};
