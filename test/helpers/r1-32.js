'use strict';

const http = require('node:http');
const { Writable } = require('node:stream');
const { runClientAgent } = require('../../lib/client-agent');
const { buildAnnouncementBody, BUYER_KEY, AGENT_TOKEN, ANTHROPIC_KEY, AGENT_ID, PROJECT_ID, SESSION_ID } = require('./r1-30');

const START = Date.parse('2026-11-17T03:20:00.000Z');
const PORTS = ['Boston', 'Miami', 'Norfolk', 'Savannah'];
function ranges(origins = 10) {
    return Array.from({ length: origins }, (_, i) => PORTS.map(destinationPort => ({ originPort: `Origin ${i}`, destinationPort }))).flat();
}
function note(rows) {
    return '| Origin | Destination | Rates | Lowest 40D | Verdict | Reason |\n| --- | --- | --- | --- | --- | --- |\n' + rows.map(([o, d, v = 'poor', reason = 'thin']) => `| ${o} | ${d} | 1 | 1 | ${v} | ${reason} |`).join('\n');
}
function root(id, body, ageDays = 1, replies = []) {
    return { id, title: 'Client agent searches — week of 2026-11-16', authorAgentId: 'another-agent', category: 'note', createdAt: new Date(START - ageDays * 86400000).toISOString(), body, replies };
}
function maxSpan(requests) {
    let max = 0;
    for (const entry of requests) max = Math.max(max, requests.filter(r => r.at >= entry.at && r.at <= entry.at + 60000).length);
    return max;
}
async function fakeRun(t, options = {}) {
    let time = START;
    const requests = [], claude = [], tools = [], writes = [], waits = [];
    const threads = options.threads || [];
    const rateDateRanges = options.ranges || ranges();
    const announcement = buildAnnouncementBody({ rateDateRanges });
    let partnerCalls = 0;
    const server = http.createServer(async (req, res) => {
        const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname.startsWith('/api/partner/')) {
            partnerCalls++;
            requests.push({ at: time, path: url.pathname, origin: url.searchParams.get('originPort'), destination: url.searchParams.get('destinationPort'), key: req.headers['x-buyer-api-key'] });
            if (options.reject?.(partnerCalls, requests.at(-1))) return send(429, { error: 'rate_limited' });
            if (url.pathname.endsWith('/profile')) return send(200, { name: 'Fake Buyer', companyName: 'Fake Co' });
            if (url.pathname.endsWith('/sailings')) return send(200, { data: [{ departure: '2026-11-21', arrivalPort: null }], meta: { total: 1 } });
            const price = options.price ? options.price(requests.at(-1)) : (url.searchParams.get('destinationPort') === 'Miami' ? 200 : 100);
            return send(200, { data: price === null ? [] : [{ rate40D: price }], meta: { total: 1 } });
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (url.pathname === '/v1/messages') {
            claude.push(body);
            const content = body.messages[0].content;
            const lanes = JSON.parse(content.slice(content.indexOf('\n[') + 1));
            const isAlternatives = content.startsWith('Pick up to three');
            const text = isAlternatives
                ? (options.alternativeText ?? JSON.stringify(options.alternatives ? options.alternatives(lanes) : lanes.map(lane => ({ ...lane, alternatives: lane.candidates.filter(d => d !== lane.destination).slice(0, 3) }))))
                : JSON.stringify(lanes.map((lane, i) => ({ ...lane, verdict: i < (options.poorCount ?? 0) ? 'poor' : 'good', reason: 'Coverage' })));
            return send(200, { content: [{ type: 'text', text }] });
        }
        const name = body.params.name, args = body.params.arguments;
        tools.push({ name, args });
        let result;
        if (name === 'connect_agent') result = { agent: { id: AGENT_ID }, sessionId: SESSION_ID };
        else if (name === 'list_projects') result = { projects: [{ id: PROJECT_ID, slug: 'rn' }] };
        else if (name === 'check_board') result = { announcements: { projects: [{ body: announcement, bodyOffset: 0 }] } };
        else if (name === 'list_messages') {
            let items = threads.filter(row => !args.filters.author_agent_id || row.authorAgentId === args.filters.author_agent_id);
            if (args.filters.urgent || args.filters.pinned) items = [];
            const offset = Number(args.cursor || 0), limit = options.pageSize || 100;
            // Deliberately truncated list excerpts: only get_thread provides complete bodies.
            result = { items: items.slice(offset, offset + limit).map(({ replies, body, ...row }) => ({ ...row, excerpt: 'truncated' })), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
        } else if (name === 'get_thread') {
            const thread = threads.find(row => row.id === args.root_id);
            const offset = Number(args.reply_cursor || 0), limit = options.replyPageSize || 100;
            // Verified against CloudBBS tools/list and domain/messages/reads.ts.
            const { replies, ...rootRow } = thread;
            result = { root: rootRow, replies: replies.slice(offset, offset + limit), replyCount: replies.length, nextReplyCursor: offset + limit < replies.length ? String(offset + limit) : null };
        } else if (name === 'post_message' || name === 'reply_message') {
            writes.push({ name, args });
            const message = { id: `write-${writes.length}`, createdAt: new Date(time).toISOString(), authorAgentId: AGENT_ID, body: args.body };
            if (name === 'post_message') threads.push({ ...message, title: args.title, category: 'note', replies: [] });
            else threads.find(row => row.id === args.root_id).replies.push(message);
            result = { id: message.id };
        } else throw new Error(`Unexpected tool ${name}`);
        send(200, { jsonrpc: '2.0', id: body.id, result: { structuredContent: result } });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const env = { RATE_NINJA_BUYER_API_KEY: BUYER_KEY, CLOUDBBS_AGENT_TOKEN: AGENT_TOKEN, ANTHROPIC_API_KEY: ANTHROPIC_KEY, RATE_NINJA_BASE_URL: baseUrl, CLOUDBBS_URL: baseUrl, CLIENT_AGENT_ANTHROPIC_URL: baseUrl };
    async function run(extra = {}) {
        let stdout = '', stderr = '';
        const out = new Writable({ write(chunk, encoding, cb) { stdout += chunk; cb(); } });
        const err = new Writable({ write(chunk, encoding, cb) { stderr += chunk; cb(); } });
        const status = await runClientAgent({ env, confirmed: true, stdout: out, stderr: err,
            random: () => 0.99999, now: () => new Date(time), sleep: async ms => { waits.push(ms); time += ms; }, ...extra });
        time += 1000;
        return { status, stdout, stderr };
    }
    return { run, requests, claude, tools, writes, waits, threads, rateDateRanges };
}
module.exports = { START, PORTS, ranges, note, root, maxSpan, fakeRun };
