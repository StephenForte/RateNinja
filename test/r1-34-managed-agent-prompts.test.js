'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { it } = require('node:test');
const { runAdminCli, applyAdminKey } = require('./helpers/r1-25');
const { startApp } = require('./helpers/app');
const { call, activate, login } = require('./helpers/r1-19');
const { seedManagedAgents, search } = require('./helpers/r1-33');
const { ADMIN_KEY, CLOUD_TOKEN, ROOT, hashTables, fakeCloudBbs } = require('./helpers/r1-34');

function cli(baseUrl, cloudUrl, args = ['managed-agent-prompts', '--json'], input = null) {
    return runAdminCli(args, {
        baseUrl, input,
        env: {
            RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
            CLOUDBBS_AGENT_TOKEN: cloudUrl ? CLOUD_TOKEN : '',
            CLOUDBBS_URL: cloudUrl ?? baseUrl,
            CLOUDBBS_PROJECT: 'rn',
            CLIENT_AGENT_ANTHROPIC_URL: baseUrl,
            ANTHROPIC_API_KEY: 'distinctive-r134-unused-claude-key'
        }
    });
}

it('prints one prompt per queued agent with only RateNinja GETs and allowlisted CloudBBS calls', async t => {
    const cloud = await fakeCloudBbs();
    t.after(cloud.close);
    const methods = [];
    const baseAgent = {
        ...search({ allowAlternativeRoutes: false }), status: 'queued', companyName: 'Synthetic Buyer',
        creatorName: 'Synthetic Creator', companyType: 'Freight Forwarder/Customer'
    };
    const agents = [
        { ...baseAgent, id: 'preview', allowAlternativeRoutes: true, allowBookingRequest: true, priceMin: 90, priceMax: 110, bookingSlots: 3 },
        { ...baseAgent, id: 'no-match', allowBookingRequest: true, bookingSlots: 1, priceMin: 1, priceMax: 2 },
        { ...baseAgent, id: 'no-permissions', creatorName: ADMIN_KEY }
    ];
    const matches = [
        { rateId: 'expired', price: 90, bookable: false, withinPriceRange: true },
        { rateId: 'outside', price: 1, bookable: true, withinPriceRange: false },
        { rateId: 'more-expensive', price: 101, bookable: true, withinPriceRange: true, rateExpirationDate: '2031-01-01' },
        { rateId: 'open', price: 100, bookable: true, withinPriceRange: true, rateExpirationDate: null },
        { rateId: 'later', price: 100, bookable: true, withinPriceRange: true, rateExpirationDate: '2031-03-01' },
        { rateId: 'best', price: 100, bookable: true, withinPriceRange: true, rateExpirationDate: '2031-02-01' }
    ];
    let fail = false;
    let alternatives = true;
    const server = http.createServer((request, response) => {
        methods.push([request.method, request.url, request.headers['x-admin-api-key'] === ADMIN_KEY]);
        response.setHeader('content-type', 'application/json');
        if (fail) {
            response.writeHead(500);
            response.end(JSON.stringify({ error: ADMIN_KEY + CLOUD_TOKEN }));
        } else if (request.url === ROOT) {
            response.end(JSON.stringify({ agents: alternatives ? agents : agents.slice(1) }));
        } else if (request.url === ROOT + '/preview/matches') {
            response.end(JSON.stringify({ matches, sailings: [] }));
        } else {
            response.end(JSON.stringify({ matches: [], sailings: [] }));
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await cli(baseUrl, cloud.baseUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp([ADMIN_KEY, CLOUD_TOKEN, 'distinctive-r134-unused-claude-key'].join('|')));
    const prompts = JSON.parse(result.stdout);
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /Synthetic Buyer/);
    assert.match(prompts[0], /Synthetic Creator/);
    assert.match(prompts[0], /Alternative destinations\n\["OAK"\]/);
    assert.match(prompts[0], /GET .*\/preview\/matches\?destinationPort=/);
    assert.match(prompts[0], /3 slot\(s\) of 40HC/);
    assert.match(prompts[0], /POST .*\/preview\/booking-requests\nX-Admin-API-Key: <RATE_NINJA_ADMIN_API_KEY>\nContent-Type: application\/json\n\{"rateId":"best"\}$/);
    assert.match(prompts[1], /No match inside the price range/);
    assert.doesNotMatch(prompts[1], /Alternative destinations|POST /);
    assert.doesNotMatch(prompts[2], /Alternative destinations|Booking request/);
    assert.deepEqual(methods, [['GET', ROOT, true], ...agents.map(agent => ['GET', `${ROOT}/${agent.id}/matches`, true])]);
    assert.deepEqual(cloud.tools.map(tool => tool.name), ['connect_agent', 'list_projects', 'check_board', 'check_board']);
    assert.ok(cloud.tools.every(tool => tool.method === 'POST' && tool.path === '/api/mcp' && tool.authorized));

    alternatives = false;
    const interactive = await cli(baseUrl, null, [], '11\n8\n');
    assert.equal(interactive.status, 0, interactive.stderr);
    assert.match(interactive.stdout, /11\. Preview managed agent prompts/);
    assert.match(interactive.stdout, /Managed agent no-match/);
    assert.deepEqual(methods.slice(-3), [['GET', ROOT, true], ...agents.slice(1).map(agent => ['GET', `${ROOT}/${agent.id}/matches`, true])]);
    assert.equal(cloud.tools.length, 4);

    fail = true;
    const rejected = await cli(baseUrl, cloud.baseUrl);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /HTTP 500/);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(ADMIN_KEY + '|' + CLOUD_TOKEN));
});

it('leaves every real server table unchanged except the expected read audits', async t => {
    const app = await startApp();
    t.after(app.close);
    const cloud = await fakeCloudBbs();
    t.after(cloud.close);
    const users = seedManagedAgents(app.db);
    activate(users.creator);
    const session = await login(app.baseUrl, users.creator);
    const response = await call(app.baseUrl, session, 'POST', '/api/managed-agents', [
        search({ allowBookingRequest: true, bookingSlots: 3, priceMin: 1000, priceMax: 1200, containerType: '20D' }),
        search({ allowAlternativeRoutes: false })
    ]);
    assert.equal(response.status, 201, response.text);
    applyAdminKey(ADMIN_KEY);
    const hashes = hashTables(app.db, { skipAudit: true });
    const audits = () => app.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'admin_managed_agents_read'").get().n;
    const prior = audits();
    const preview = await cli(app.baseUrl, cloud.baseUrl, ['managed-agent-prompts']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /"bookingSlots": 3/);
    assert.match(preview.stdout, /"rateId":"managed-rate-1"/);
    assert.equal(preview.stdout.split('\n\n---\n\n').length, 2);
    assert.deepEqual(hashTables(app.db, { skipAudit: true }), hashes);
    assert.equal(audits() - prior, 3);
});
