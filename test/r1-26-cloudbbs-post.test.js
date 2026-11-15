'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.RATE_NINJA_ADMIN_API_KEY = 'r125-admin-test-key-32chars-xxxxxx';
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const {
    freezeToday,
    insertRate,
    insertPort
} = require('./helpers/r1-24');
const {
    BODY_SIZE_CAP,
    ANNOUNCEMENT_TITLE,
    REFERENCE_SCHEMA,
    buildAnnouncement,
    extractJsonBlock
} = require('../lib/cloudbbs-post');
const {
    ADMIN_KEY,
    CLOUDBBS_TOKEN,
    enableAdminKey,
    startFakeCloudBbs,
    startFakeAdminReference,
    emptyPagesByPath,
    runAdminCli,
    assertSecretsAbsent
} = require('./helpers/r1-26');

freezeToday();

function secrets() {
    return [ADMIN_KEY, CLOUDBBS_TOKEN];
}

describe('R1-26 CloudBBS announcement format', () => {
    it('builds a constant title and parseable schema payload without companies', () => {
        const reads = {
            rateDateRanges: [{ a: 1 }],
            originPorts: [{ value: 'Port Klang' }, { value: 'LALB' }],
            destinationPorts: [{ value: 'LALB' }],
            contractOwners: [{ value: 'Kings' }],
            sailingDateRanges: [],
            predictiveDateRanges: [{ origin: 'X' }]
        };
        const announcement = buildAnnouncement({
            generatedAt: '2026-11-15T20:00:00.000Z',
            source: 'http://127.0.0.1:9',
            reads
        });
        assert.equal(announcement.title, ANNOUNCEMENT_TITLE);
        assert.match(announcement.body, /^Generated 2026-11-15T20:00:00\.000Z from http:\/\/127\.0\.0\.1:9\.\n/);
        assert.match(announcement.body, new RegExp(REFERENCE_SCHEMA));
        const parsed = extractJsonBlock(announcement.body);
        assert.equal(parsed.schema, REFERENCE_SCHEMA);
        assert.deepEqual(parsed.reads.originPorts, reads.originPorts);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed.reads, 'companies'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'companies'), false);
    });
});

describe('R1-26 post-cloudbbs against real admin + fake CloudBBS', { concurrency: 1 }, () => {
    let app;
    let cloudBbs;

    before(async () => {
        app = await startApp({ companyName: 'R126 Post Co' });
        enableAdminKey();
        insertPort(app.db, { id: 'port-pkg', code: 'MYPKG', name: 'Port Klang' });
        insertRate(app.db, {
            id: 'r-r126-1',
            owner: app.company.id,
            origin: 'Port Klang',
            destination: 'LALB',
            effective: '2026-10-01',
            expiration: '2026-12-31'
        });
        cloudBbs = await startFakeCloudBbs();
    });

    after(async () => {
        if (cloudBbs) await cloudBbs.close();
        if (app) await app.close();
    });

    it('posts the six reads with a parseable body and no companies key', async () => {
        cloudBbs.requests.length = 0;
        const result = await runAdminCli(['post-cloudbbs', '--yes'], {
            baseUrl: app.baseUrl,
            cloudBbsUrl: cloudBbs.baseUrl,
            env: {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN,
                CLOUDBBS_PROJECT: 'rn'
            }
        });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(cloudBbs.requests.length, 1);
        const put = cloudBbs.requests[0];
        assert.equal(put.method, 'PUT');
        assert.equal(put.url, '/api/v1/projects/rn/announcement');
        assert.equal(put.headers.authorization, `Bearer ${CLOUDBBS_TOKEN}`);
        assert.equal(put.body.title, ANNOUNCEMENT_TITLE);
        const parsed = extractJsonBlock(put.body.body);
        assert.equal(parsed.schema, REFERENCE_SCHEMA);
        assert.equal(parsed.source, app.baseUrl);
        assert.ok(parsed.reads.originPorts.some(row => row.value === 'Port Klang'));
        assert.equal(Object.prototype.hasOwnProperty.call(parsed.reads, 'companies'), false);
        assert.match(result.stdout, /version 1/);
        assertSecretsAbsent(result, secrets(), [put.rawBody, put.body]);
    });

    it('a second post is a full PUT replacement on the same path', async () => {
        cloudBbs.requests.length = 0;
        const first = await runAdminCli(['post-cloudbbs', '--yes'], {
            baseUrl: app.baseUrl,
            cloudBbsUrl: cloudBbs.baseUrl,
            env: {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            }
        });
        const second = await runAdminCli(['post-cloudbbs', '--yes'], {
            baseUrl: app.baseUrl,
            cloudBbsUrl: cloudBbs.baseUrl,
            env: {
                RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                CLOUDBBS_TOKEN
            }
        });
        assert.equal(first.status, 0, first.stderr);
        assert.equal(second.status, 0, second.stderr);
        assert.equal(cloudBbs.requests.length, 2);
        assert.equal(cloudBbs.requests[0].method, 'PUT');
        assert.equal(cloudBbs.requests[1].method, 'PUT');
        assert.equal(cloudBbs.requests[0].url, cloudBbs.requests[1].url);
        assert.match(second.stdout, /version 2/);
        assertSecretsAbsent(first, secrets(), [cloudBbs.requests[0].rawBody]);
        assertSecretsAbsent(second, secrets(), [cloudBbs.requests[1].rawBody]);
    });
});

describe('R1-26 multi-page concatenation', { concurrency: 1 }, () => {
    it('concatenates every page of each read into the posted JSON', async () => {
        const pages = emptyPagesByPath();
        pages['/api/admin/v1/reference/origin-ports'] = Array.from({ length: 101 }, (_, index) => ({
            value: `P${index}`
        }));
        pages['/api/admin/v1/reference/destination-ports'] = [{ value: 'D0' }, { value: 'D1' }];
        const admin = await startFakeAdminReference({ pagesByPath: pages, pageSize: 100 });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 1);
            const originRequests = admin.requests.filter(
                entry => entry.path === '/api/admin/v1/reference/origin-ports'
            );
            assert.equal(originRequests.length, 2);
            const parsed = extractJsonBlock(cloudBbs.requests[0].body.body);
            assert.equal(parsed.reads.originPorts.length, 101);
            assert.deepEqual(parsed.reads.originPorts[0], { value: 'P0' });
            assert.deepEqual(parsed.reads.originPorts[100], { value: 'P100' });
            assert.deepEqual(parsed.reads.destinationPorts, [{ value: 'D0' }, { value: 'D1' }]);
            assert.equal(Object.prototype.hasOwnProperty.call(parsed.reads, 'companies'), false);
            assertSecretsAbsent(result, secrets(), [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });
});

describe('R1-26 fail-closed posting', { concurrency: 1 }, () => {
    it('sends zero CloudBBS requests when a later page fails', async () => {
        const pages = emptyPagesByPath();
        pages['/api/admin/v1/reference/origin-ports'] = Array.from({ length: 150 }, (_, index) => ({
            value: `Port-${index}`
        }));
        const admin = await startFakeAdminReference({
            pagesByPath: pages,
            failOn: {
                path: '/api/admin/v1/reference/origin-ports',
                page: 2,
                status: 500,
                error: 'boom'
            }
        });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 1);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /500/);
            assertSecretsAbsent(result, secrets());
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('sends zero CloudBBS requests when any read fails', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({
            pagesByPath: pages,
            failOn: {
                path: '/api/admin/v1/reference/contract-owners',
                page: 1,
                status: 503,
                error: 'admin_api_disabled'
            }
        });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 1);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /503/);
            assertSecretsAbsent(result, secrets());
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('oversized body prints the size and sends zero requests', async () => {
        const pages = emptyPagesByPath();
        // Compact JSON of many long strings exceeds the 16384-byte body cap.
        pages['/api/admin/v1/reference/origin-ports'] = Array.from({ length: 400 }, (_, index) => ({
            value: `Very-Long-Origin-Port-Name-${String(index).padStart(4, '0')}-${'x'.repeat(40)}`,
            code: `C${index}`,
            name: `Name-${index}-${'y'.repeat(40)}`
        }));
        const announcement = buildAnnouncement({
            generatedAt: '2026-11-15T20:00:00.000Z',
            source: 'http://127.0.0.1:1',
            reads: {
                rateDateRanges: [],
                originPorts: pages['/api/admin/v1/reference/origin-ports'],
                destinationPorts: [],
                contractOwners: [],
                sailingDateRanges: [],
                predictiveDateRanges: []
            }
        });
        assert.ok(announcement.byteLength > BODY_SIZE_CAP);

        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 1);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, new RegExp(String(BODY_SIZE_CAP)));
            assert.match(result.stderr, /\d+ bytes/);
            assertSecretsAbsent(result, secrets());
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('confirm answered n sends zero requests', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const input = ['9', 'n', '8'].join('\n') + '\n';
            const result = await runAdminCli([], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                },
                input
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stdout, /Cancelled/);
            assertSecretsAbsent(result, secrets());
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('post-cloudbbs without --yes exits 2 with zero requests', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 2);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /--yes/);
            assertSecretsAbsent(result, secrets());
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('missing CLOUDBBS_TOKEN exits 2 with zero requests', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN: ''
                }
            });
            assert.equal(result.status, 2);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /CLOUDBBS_TOKEN/);
            assertSecretsAbsent(result, [ADMIN_KEY, CLOUDBBS_TOKEN]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('CloudBBS 401 is reported by status without leaking the token', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs({
            token: 'other-token-not-matching',
            status: 401,
            responseBody: { error: 'unauthorized' }
        });
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 1);
            assert.equal(cloudBbs.requests.length, 1);
            assert.match(result.stderr, /401/);
            assertSecretsAbsent(result, secrets(), [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('CloudBBS 403 is reported by status without leaking the token', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs({
            status: 403,
            responseBody: { error: 'capability_denied' }
        });
        try {
            const result = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(result.status, 1);
            assert.equal(cloudBbs.requests.length, 1);
            assert.match(result.stderr, /403/);
            assert.match(result.stderr, /capability_denied/);
            assertSecretsAbsent(result, secrets(), [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });
});

describe('R1-26 menu numbering', { concurrency: 1 }, () => {
    it('list prints 8. quit and 9. Post this information to the CloudBBS', async () => {
        const result = await runAdminCli(['list'], {
            baseUrl: 'http://127.0.0.1:9',
            env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^8\. quit$/m);
        assert.match(result.stdout, /^9\. Post this information to the CloudBBS$/m);
        for (const name of [
            'rate-date-ranges',
            'origin-ports',
            'destination-ports',
            'contract-owners',
            'sailing-date-ranges',
            'predictive-date-ranges',
            'companies'
        ]) {
            assert.match(result.stdout, new RegExp(name));
        }
        assertSecretsAbsent(result, secrets());
    });

    it('choosing 8 still quits without posting', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli([], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                },
                input: '8\n'
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 0);
            assert.equal(admin.requests.length, 0);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('menu stays open after missing CLOUDBBS_TOKEN on option 9', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const result = await runAdminCli([], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN: ''
                },
                input: ['9', '8'].join('\n') + '\n'
            });
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 0);
            assert.match(result.stderr, /CLOUDBBS_TOKEN/);
            assert.match(result.stdout, /Choice:/);
            assertSecretsAbsent(result, [ADMIN_KEY, CLOUDBBS_TOKEN]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });
});
