'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BODY_SIZE_CAP, REQUEST_TIMEOUT_MS, buildAnnouncement } = require('../lib/cloudbbs-post');
const {
    ADMIN_KEY,
    CLOUDBBS_TOKEN,
    startFakeCloudBbs,
    startFakeAdminReference,
    emptyPagesByPath,
    runAdminCli,
    assertSecretsAbsent
} = require('./helpers/r1-26');

const root = path.join(__dirname, '..');
const CRON_NAME = 'rate-ninja-cloudbbs-post';
const CRON_SCHEDULE = '"17 0 * * *"';
const CRON_BUILD = 'npm install';
const CRON_START = 'node scripts/rateninja-admin.js post-cloudbbs --yes';
const SECRET_KEYS = ['RATE_NINJA_ADMIN_API_KEY', 'CLOUDBBS_TOKEN'];

// Web service block on origin/main at 1ea69b9. CI checks out the PR without
// that ref, so the comparison lives here. A Blueprint sync applies this block.
const WEB_SERVICE_ON_MAIN = [
    '  - type: web',
    '    name: rate-ninja',
    '    runtime: node',
    '    plan: starter',
    '    buildCommand: npm install',
    '    startCommand: npm start',
    '    healthCheckPath: /',
    '    disk:',
    '      name: rate-ninja-data',
    '      mountPath: /var/data',
    '      sizeGB: 1',
    '    envVars:',
    '      # October 21, 2026 Node.js security release. Local development can stay',
    '      # on Node.js 22 or later; this pin applies to the Render build and runtime.',
    '      - key: NODE_VERSION',
    '        value: "26.12.1"',
    '      - key: NODE_ENV',
    '        value: production',
    '      - key: SQLITE_DB_PATH',
    '        value: /var/data/rateninja.db',
    '      - key: RATE_NINJA_API_KEY',
    '        sync: false',
    '      # Admin reference API / CLI. Set in the dashboard; never commit the value.',
    '      - key: RATE_NINJA_ADMIN_API_KEY',
    '        sync: false',
    '      - key: SESSION_SECRET',
    '        generateValue: true',
    '      - key: OAUTH_SIGNING_SECRET',
    '        generateValue: true',
    '      # A blueprint sync writes this value over the dashboard. Keep it true',
    '      # so OceanRelay partner sign-in stays available while testing.',
    '      - key: PARTNER_OAUTH_ENABLED',
    '        value: "true"',
    '      # Set in the Render dashboard. Do not commit the API key or from-address.',
    '      - key: RESEND_API_KEY',
    '        sync: false',
    '      - key: RESEND_FROM',
    '        sync: false',
    '      # Reset links use this origin. They do not trust the request Host header.',
    '      - key: PUBLIC_ORIGIN',
    '        value: https://rate-ninja.onrender.com',
    '      - key: FORTEL2_RECEIPT_PRIVATE_KEY',
    '        sync: false',
    '      - key: FORTEL2_CF_ACCESS_CLIENT_ID',
    '        sync: false',
    '      - key: FORTEL2_CF_ACCESS_CLIENT_SECRET',
    '        sync: false',
    '      - key: FORTEL2_CHAIN_ID',
    '        sync: false',
    '      - key: FORTEL2_WRITE_RPC_URL',
    '        sync: false',
    '      - key: FORTEL2_READ_RPC_URL',
    '        sync: false',
    '      - key: FORTEL2_EXPLORER_URL',
    '        sync: false'
].join('\n');

function readBlueprint() {
    return fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
}

function serviceBlocks(yaml) {
    const lines = yaml.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith('  - type:')) {
            if (current) blocks.push(finishBlock(current));
            current = [line];
        } else if (current) {
            current.push(line);
        }
    }
    if (current) blocks.push(finishBlock(current));
    return blocks;
}

function finishBlock(lines) {
    const copy = lines.slice();
    while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
    return copy.join('\n');
}

function serviceType(block) {
    const match = /^  - type: (\S+)/.exec(block);
    return match ? match[1] : null;
}

function field(block, name) {
    const match = new RegExp(`^    ${name}: (.*)$`, 'm').exec(block);
    return match ? match[1] : null;
}

function envEntries(block) {
    const marker = '\n    envVars:\n';
    const start = block.indexOf(marker);
    assert.notEqual(start, -1, 'service is missing envVars');
    const entries = [];
    let current = null;
    for (const line of block.slice(start + marker.length).split('\n')) {
        if (line.startsWith('      - key:')) {
            if (current) entries.push(current);
            current = { key: line.slice('      - key:'.length).trim(), props: {} };
            continue;
        }
        if (!current) continue;
        const prop = /^        ([A-Za-z0-9_]+):(?: (.*))?$/.exec(line);
        if (prop) current.props[prop[1]] = prop[2] === undefined ? '' : prop[2];
    }
    if (current) entries.push(current);
    return entries;
}

function webBlock(yaml) {
    const blocks = serviceBlocks(yaml).filter(block => serviceType(block) === 'web');
    assert.equal(blocks.length, 1);
    return blocks[0];
}

function cronBlocks(yaml) {
    return serviceBlocks(yaml).filter(block => serviceType(block) === 'cron');
}

function secrets() {
    return [ADMIN_KEY, CLOUDBBS_TOKEN];
}

function assertNoSecrets(result, extraBodies = []) {
    assertSecretsAbsent(result, secrets(), extraBodies);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(output.includes(ADMIN_KEY), false);
    assert.equal(output.includes(CLOUDBBS_TOKEN), false);
}

async function runPost(admin, cloudBbs, env, timeoutMs = 20_000) {
    return runAdminCli(['post-cloudbbs', '--yes'], {
        baseUrl: admin.baseUrl,
        cloudBbsUrl: cloudBbs.baseUrl,
        env,
        timeoutMs
    });
}

function listen(server) {
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close() {
                    for (const socket of sockets) socket.destroy();
                    return new Promise((done, fail) => {
                        server.close(error => (error ? fail(error) : done()));
                    });
                }
            });
        });
        server.on('error', reject);
    });
}

function startHangingAdmin() {
    const requests = [];
    const server = http.createServer(req => {
        requests.push({ method: req.method, url: req.url });
    });
    return listen(server).then(info => Object.assign(info, { requests }));
}

function startHangingCloudBbs() {
    const requests = [];
    const server = http.createServer(req => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            requests.push({
                method: req.method,
                url: req.url,
                rawBody: Buffer.concat(chunks).toString('utf8')
            });
        });
    });
    return listen(server).then(info => Object.assign(info, { requests }));
}

describe('R1-44 render.yaml cron service', () => {
    it('appends one cron service and leaves the web service env unchanged', () => {
        const blueprint = readBlueprint();
        const cron = cronBlocks(blueprint);
        assert.equal(cron.length, 1);
        assert.equal(serviceBlocks(WEB_SERVICE_ON_MAIN).length, 1);
        assert.equal(cronBlocks(WEB_SERVICE_ON_MAIN).length, 0);
        const block = cron[0];
        assert.equal(field(block, 'name'), CRON_NAME);
        assert.equal(field(block, 'runtime'), 'node');
        assert.equal(field(block, 'plan'), 'starter');
        assert.equal(field(block, 'schedule'), CRON_SCHEDULE);
        assert.equal(field(block, 'buildCommand'), CRON_BUILD);
        assert.equal(field(block, 'startCommand'), CRON_START);
        assert.equal(block.includes('\n    disk:'), false);

        const env = envEntries(block);
        assert.deepEqual(env.map(entry => entry.key), [
            'NODE_VERSION',
            'RATE_NINJA_ADMIN_API_KEY',
            'CLOUDBBS_TOKEN'
        ]);
        assert.deepEqual(env[0].props, { value: '"26.12.1"' });
        for (const entry of env.filter(item => SECRET_KEYS.includes(item.key))) {
            assert.deepEqual(entry.props, { sync: 'false' });
            assert.equal(Object.prototype.hasOwnProperty.call(entry.props, 'value'), false);
            assert.equal(Object.prototype.hasOwnProperty.call(entry.props, 'generateValue'), false);
        }
        const denied = [
            'RATE_NINJA_API_KEY',
            'SESSION_SECRET',
            'OAUTH_SIGNING_SECRET',
            'RESEND_API_KEY',
            'RESEND_FROM',
            'FORTEL2_RECEIPT_PRIVATE_KEY',
            'FORTEL2_CF_ACCESS_CLIENT_ID',
            'FORTEL2_CF_ACCESS_CLIENT_SECRET',
            'ANTHROPIC_API_KEY',
            'RATE_NINJA_BUYER_API_KEY',
            'CLOUDBBS_AGENT_TOKEN',
            'CLOUDBBS_SERVER_TOKEN'
        ];
        for (const key of denied) {
            assert.equal(env.some(entry => entry.key === key), false, key);
            assert.equal(block.includes(key), false, key);
        }

        assert.equal(webBlock(blueprint), WEB_SERVICE_ON_MAIN);
        assert.deepEqual(envEntries(webBlock(blueprint)), envEntries(WEB_SERVICE_ON_MAIN));
    });
});

describe('R1-44 post-cloudbbs --yes failure exits', { concurrency: 1 }, () => {
    it('success exits 0 and PUTs once', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 1);
            assert.equal(cloudBbs.requests[0].method, 'PUT');
            assertNoSecrets(result, [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('missing admin key exits non-zero and PUTs nothing', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: '',
                CLOUDBBS_TOKEN
            });
            assert.notEqual(result.status, 0);
            assert.equal(result.status, 2);
            assert.equal(admin.requests.length, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /RATE_NINJA_ADMIN_API_KEY/);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('missing CloudBBS token exits non-zero and PUTs nothing', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN: ''
            });
            assert.notEqual(result.status, 0);
            assert.equal(result.status, 2);
            assert.equal(admin.requests.length, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /CLOUDBBS_TOKEN/);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('admin API error exits non-zero and PUTs nothing', async () => {
        const admin = await startFakeAdminReference({
            pagesByPath: emptyPagesByPath(),
            failOn: {
                path: '/api/admin/v1/reference/rate-date-ranges',
                page: 1,
                status: 500,
                error: 'admin_down'
            }
        });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            });
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /500/);
            assert.match(result.stderr, /admin_down/);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('admin API timeout exits non-zero and PUTs nothing', async () => {
        const admin = await startHangingAdmin();
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            }, REQUEST_TIMEOUT_MS + 10_000);
            assert.equal(result.timedOut, false);
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /timeout/i);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('a reference read failing mid-pagination exits non-zero and PUTs nothing', async () => {
        const pages = emptyPagesByPath();
        pages['/api/admin/v1/reference/origin-ports'] = Array.from({ length: 150 }, (_, index) => ({
            value: `Port-${index}`
        }));
        const admin = await startFakeAdminReference({
            pagesByPath: pages,
            failOn: {
                path: '/api/admin/v1/reference/origin-ports',
                page: 2,
                status: 502,
                error: 'page_failed'
            }
        });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            });
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.ok(admin.requests.filter(entry => entry.path === '/api/admin/v1/reference/origin-ports').length >= 2);
            assert.match(result.stderr, /502/);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('a body over the size limit exits non-zero and PUTs nothing', async () => {
        const pages = emptyPagesByPath();
        pages['/api/admin/v1/reference/origin-ports'] = Array.from({ length: 2000 }, (_, index) => ({
            value: `Very-Long-Origin-Port-Name-${String(index).padStart(4, '0')}-${'x'.repeat(40)}`,
            code: `C${index}`,
            name: `Name-${index}-${'y'.repeat(40)}`
        }));
        const announcement = buildAnnouncement({
            generatedAt: '2026-11-20T00:17:00.000Z',
            source: 'http://127.0.0.1:1',
            reads: {
                rateDateRanges: [],
                originPorts: pages['/api/admin/v1/reference/origin-ports'],
                destinationPorts: [],
                contractOwners: [],
                sailingDateRanges: [],
                predictiveDateRanges: []
            },
            bookingCode: 'ABCDEFGHI'
        });
        assert.ok(announcement.byteLength > BODY_SIZE_CAP);
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            });
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /Not posting/);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('CloudBBS PUT error exits non-zero and reports the failure', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startFakeCloudBbs({
            status: 500,
            responseBody: { error: 'cloudbbs_down' }
        });
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            });
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 1);
            assert.match(result.stderr, /500/);
            assert.match(result.stderr, /cloudbbs_down/);
            assertNoSecrets(result, [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('CloudBBS PUT timeout exits non-zero and reports the failure', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startHangingCloudBbs();
        try {
            const result = await runPost(admin, cloudBbs, {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            }, REQUEST_TIMEOUT_MS + 10_000);
            assert.equal(result.timedOut, false);
            assert.notEqual(result.status, 0);
            assert.equal(cloudBbs.requests.length, 1);
            assert.equal(cloudBbs.requests[0].method, 'PUT');
            assert.match(result.stderr, /CloudBBS/);
            assert.match(result.stderr, /timeout/i);
            assertNoSecrets(result, [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('menu option 9 still asks [y/N] and does not post on n', async () => {
        const admin = await startFakeAdminReference({ pagesByPath: emptyPagesByPath() });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli([], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                },
                input: '9\nn\n8\n'
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.match(result.stdout, /\[y\/N\]/);
            assert.equal(cloudBbs.requests.length, 0);
            assertNoSecrets(result);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });
});
