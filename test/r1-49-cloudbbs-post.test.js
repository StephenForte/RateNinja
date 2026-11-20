'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve } = require('node:path');
const { after, afterEach, before, it, mock } = require('node:test');
const { login, call } = require('./helpers/r1-19');
const { startFakeAdminReference } = require('./helpers/r1-26');
const { NOON, insertAgent, until } = require('./helpers/r1-45');
const { startFixture, assertNoSecrets, ADMIN_KEY, POST_TOKEN, UPDATED_AT, OLD_CODE } = require('./helpers/r1-49');
const shared = require('../lib/cloudbbs-post');

const POST = '/api/managed-agents/cloudbbs-post';
const RUNS = '/api/managed-agents/runs';
const auditEvent = 'cloudbbs_announcement_posted';
const logs = [];

let app;
let cloud;
let runs;
let adminId;
let bookingCodeFailure;
let sharedPost;
let retryAdmin;
const originalPost = shared.postCloudBbs;
let postImpl = originalPost;

before(async () => {
    sharedPost = mock.method(shared, 'postCloudBbs', options => postImpl(options));
    for (const method of ['log', 'error', 'warn']) {
        mock.method(console, method, (...args) => { logs.push(args.map(String).join(' ')); });
    }
    ({ app, cloud, runs, adminId } = await startFixture());
    retryAdmin = await startFakeAdminReference();
    ({ bookingCodeFailure } = require('../lib/booking-code'));
    insertAgent(app.db, { id: 'r149-queue', companyId: app.company.id, userId: adminId });
});

after(async () => {
    await retryAdmin?.close();
    await cloud?.close();
    await app?.close();
    mock.restoreAll();
});

afterEach(() => {
    process.env.CLOUDBBS_TOKEN = POST_TOKEN;
    process.env.RATE_NINJA_ADMIN_API_KEY = ADMIN_KEY;
    process.env.RATE_NINJA_BASE_URL = app.baseUrl;
    runs.setTestClock(() => NOON);
    runs.setTestRunner(null);
    cloud.onPut = undefined;
    postImpl = originalPost;
});

async function request(path, method = 'POST', options = {}) {
    const response = await app.request(path, { method, ...(method === 'POST' && { body: '{}' }), ...options });
    return { status: response.status, body: await response.json() };
}

function latest() {
    return request(`${RUNS}/latest`, 'GET');
}

function audit() {
    return app.db.prepare('SELECT actor_user_id, detail FROM audit_events WHERE event_type = ? ORDER BY rowid').all(auditEvent);
}

it('requires a system-admin session and CSRF before reading reference data', async () => {
    for (const name of ['r149-member', 'r149-company-admin', 'r149-customer']) {
        const session = await login(app.baseUrl, name);
        const result = await call(app.baseUrl, session, 'POST', POST, {});
        assert.equal(result.status, 403);
        assert.equal(result.json.code, 'forbidden');
        assert.equal((await call(app.baseUrl, session, 'GET', `${RUNS}/latest`)).status, 403);
    }
    assert.equal((await request(POST, 'POST', { cookie: false })).status, 401);
    assert.equal((await request(POST, 'POST', { csrf: false })).status, 403);
    assert.equal(sharedPost.mock.callCount(), 0);
    assert.equal(cloud.puts.length, 0);
});

it('reports missing credentials before the daily window and observes both UTC boundaries', async () => {
    runs.setTestClock(() => Date.parse('2026-11-20T00:15:00.000Z'));
    for (const name of ['CLOUDBBS_TOKEN', 'RATE_NINJA_ADMIN_API_KEY']) {
        const previous = process.env[name];
        delete process.env[name];
        const result = await request(POST);
        assert.equal(result.status, 503);
        assert.equal(result.body.code, 'cloudbbs_not_configured');
        assert.match(result.body.error, new RegExp(name));
        assert.deepEqual((await latest()).body.readiness.cloudBbsPost, {
            configured: false, inProgress: false, disabledReason: result.body.error
        });
        process.env[name] = previous;
    }
    for (const time of ['00:15:00.000', '00:17:00.000', '00:18:59.999']) {
        runs.setTestClock(() => Date.parse(`2026-11-20T${time}Z`));
        const result = await request(POST);
        assert.equal(result.status, 423);
        assert.equal(result.body.code, 'post_window');
        assert.equal((await latest()).body.readiness.cloudBbsPost.disabledReason, result.body.error);
    }
    runs.setTestClock(() => Date.parse('2026-11-20T00:19:00.000Z'));
    assert.equal((await latest()).body.readiness.cloudBbsPost.disabledReason, null);
    assert.equal(cloud.puts.length, 0);
});

it('posts once, audits typed metadata, and immediately replaces the cached booking code', async () => {
    assert.equal(await bookingCodeFailure(OLD_CODE), null);
    assert.equal(await bookingCodeFailure(OLD_CODE), null);
    assert.equal(cloud.boardReads, 1);
    const response = await request(POST);
    assert.equal(response.status, 200);
    assert.equal(cloud.puts.length, 1);
    const code = cloud.lastCode();
    assert.deepEqual(response.body, {
        version: 1, updatedAt: UPDATED_AT, byteLength: Buffer.byteLength(cloud.puts[0].body)
    });
    assert.deepEqual(audit().map(row => ({ actor: row.actor_user_id, detail: JSON.parse(row.detail) })), [
        { actor: adminId, detail: { project: 'rn', version: 1 } }
    ]);
    assert.deepEqual(await bookingCodeFailure(OLD_CODE), { status: 403, error: 'invalid_booking_code' });
    assert.equal(await bookingCodeFailure(code), null);
    assert.equal(cloud.boardReads, 2);
    assertNoSecrets([response, audit(), logs], code);
});

it('the route and CLI both invoke postCloudBbs and send equivalent announcement bodies', async () => {
    const previous = sharedPost.mock.callCount();
    assert.equal((await request(POST)).status, 200);
    assert.equal(sharedPost.mock.callCount(), previous + 1);
    const routeBody = cloud.puts.at(-1);

    const cli = resolve(__dirname, '../scripts/rateninja-admin.js');
    const sharedFile = require.resolve('../lib/cloudbbs-post');
    const probe = `
        const shared = require(${JSON.stringify(sharedFile)});
        const post = shared.postCloudBbs;
        shared.postCloudBbs = (...args) => {
            process.stderr.write('called postCloudBbs\\n');
            return post(...args);
        };
        require(process.argv[1]);
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', probe, cli, 'post-cloudbbs', '--yes'], {
        cwd: app.directory, env: process.env
    });
    assert.equal(result.stderr, 'called postCloudBbs\n');
    assert.equal(result.stdout, `Posted to rn: version ${cloud.puts.length}, updatedAt ${UPDATED_AT}\n`);
    const cliBody = cloud.puts.at(-1);
    assert.notEqual(cliBody, routeBody);
    const normalize = ({ title, body }) => {
        const { generatedAt, bookingCode } = shared.extractJsonBlock(body);
        return { title, body: body.replaceAll(generatedAt, '<time>').replaceAll(bookingCode, '<code>') };
    };
    assert.deepEqual(normalize(routeBody), normalize(cliBody));
    assertNoSecrets([result, logs], cloud.lastCode());
});

it('rejects overlapping runs and posts in both directions, then releases both actions', async () => {
    const initialPuts = cloud.puts.length;
    const firstRun = Promise.withResolvers();
    runs.setTestRunner(() => firstRun.promise);
    const running = await request(RUNS);
    assert.equal(running.status, 202);
    try {
        const blocked = await request(POST);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'run_in_progress');
        assert.equal((await latest()).body.readiness.cloudBbsPost.disabledReason, blocked.body.error);
        assert.equal(cloud.puts.length, initialPuts);
    } finally {
        firstRun.resolve(0);
        await until(() => app.db.prepare('SELECT status FROM managed_agent_runs WHERE id = ?')
            .get(running.body.run.id).status === 'succeeded');
    }

    const putEntered = Promise.withResolvers();
    const releasePut = Promise.withResolvers();
    cloud.onPut = () => {
        putEntered.resolve();
        return releasePut.promise;
    };
    const posting = request(POST);
    try {
        await Promise.race([putEntered.promise, posting.then(() => assert.fail('Post finished before reaching PUT'))]);
        const state = (await latest()).body.readiness;
        assert.deepEqual(state.cloudBbsPost, {
            configured: true, inProgress: true, disabledReason: 'A CloudBBS post is already in progress.'
        });
        assert.equal(state.disabledReason, state.cloudBbsPost.disabledReason);
        for (const path of [RUNS, POST]) {
            const blocked = await request(path);
            assert.equal(blocked.status, 409);
            assert.equal(blocked.body.code, 'post_in_progress');
        }
        assert.equal(cloud.puts.length, initialPuts + 1);
    } finally {
        releasePut.resolve();
        await posting;
        cloud.onPut = undefined;
    }
    assert.equal((await posting).status, 200);
    assert.equal((await latest()).body.readiness.cloudBbsPost.inProgress, false);
    assert.equal((await request(POST)).status, 200);
    runs.setTestRunner(async () => 0);
    assert.equal((await request(RUNS)).status, 202);
});

async function assertFailureThenRetry(pattern, expectedAttemptedPuts, ...codes) {
    const initialPuts = cloud.puts.length;
    const initialAudits = audit().length;
    const failed = await request(POST);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'cloudbbs_post_failed');
    assert.match(failed.body.error, pattern);
    assert.equal(audit().length, initialAudits);
    assert.equal(cloud.puts.length, initialPuts + expectedAttemptedPuts);
    const putCodes = cloud.puts.slice(initialPuts).map(put => shared.extractJsonBlock(put.body).bookingCode);
    assertNoSecrets([failed, audit(), logs], ...codes, ...putCodes);
    assert.equal((await latest()).body.readiness.cloudBbsPost.inProgress, false);
    cloud.onPut = undefined;
    postImpl = originalPost;
    process.env.RATE_NINJA_BASE_URL = retryAdmin.baseUrl;
    assert.equal((await request(POST)).status, 200);
    assert.equal(audit().length, initialAudits + 1);
}

it('a failed reference read on page two leaves the announcement and lock intact for a retry', async () => {
    const { path } = shared.REFERENCE_READS[0];
    const fake = await startFakeAdminReference({
        pagesByPath: { [path]: [{ synthetic: 'first' }, { synthetic: 'second' }] },
        pageSize: 1,
        failOn: { path, page: 2, error: ADMIN_KEY + POST_TOKEN + OLD_CODE }
    });
    try {
        process.env.RATE_NINJA_BASE_URL = fake.baseUrl;
        await assertFailureThenRetry(/reference data/, 0);
        assert.deepEqual(fake.requests.map(read => new URLSearchParams(read.search).get('page')), ['1', '2']);
    } finally {
        await fake.close();
    }
});

it('an oversized announcement makes no PUT and releases the lock', async () => {
    const fake = await startFakeAdminReference({
        pagesByPath: { [shared.REFERENCE_READS[0].path]: [{ padding: 'x'.repeat(shared.BODY_SIZE_CAP) }] }
    });
    try {
        process.env.RATE_NINJA_BASE_URL = fake.baseUrl;
        await assertFailureThenRetry(/CloudBBS cap is 262144/, 0);
    } finally {
        await fake.close();
    }
});

it('a PUT 403 has a short safe error and releases the lock', async () => {
    cloud.onPut = ({ body }) => ({
        status: 403, body: { error: POST_TOKEN + ADMIN_KEY + shared.extractJsonBlock(body).bookingCode }
    });
    await assertFailureThenRetry(/update the CloudBBS announcement/, 1);
});

it('an HTTP timeout aborts a held PUT and releases the lock', async () => {
    const gate = Promise.withResolvers();
    cloud.onPut = () => gate.promise;
    try {
        await assertFailureThenRetry(/update the CloudBBS announcement/, 1);
    } finally {
        gate.resolve();
    }
});

it('an unexpected throw is redacted and releases the lock', async () => {
    postImpl = () => { throw new Error(`${POST_TOKEN} ${ADMIN_KEY} ${OLD_CODE}`); };
    await assertFailureThenRetry(/Could not post the CloudBBS announcement/, 0);
});

it('does not forward arbitrary strings in successful upstream metadata', async () => {
    cloud.onPut = ({ body }) => ({
        status: 200,
        body: { version: ADMIN_KEY, updatedAt: shared.extractJsonBlock(body).bookingCode, token: POST_TOKEN }
    });
    const response = await request(POST);
    assert.equal(response.status, 200);
    assert.equal(response.body.version, null);
    assert.equal(response.body.updatedAt, null);
    assert.deepEqual(JSON.parse(audit().at(-1).detail), { project: 'rn', version: null });
    assertNoSecrets([response, audit(), logs], cloud.lastCode());
});
