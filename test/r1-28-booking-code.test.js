'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';
process.env.RATE_NINJA_API_KEY = 'demo-key';
process.env.RATE_NINJA_ADMIN_API_KEY = 'r125-admin-test-key-32chars-xxxxxx';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    BOOKING_CODE_ALPHABET,
    BOOKING_CODE_LENGTH,
    REFERENCE_SCHEMA,
    generateBookingCode,
    buildAnnouncement,
    extractJsonBlock
} = require('../lib/cloudbbs-post');
const {
    ADMIN_KEY,
    CLOUDBBS_TOKEN,
    startFakeCloudBbs,
    startFakeAdminReference,
    emptyPagesByPath,
    runAdminCli,
    assertSecretsAbsent
} = require('./helpers/r1-26');

const BOOKING_CODE_RE = /^[A-Z0-9]{9}$/;
const EMPTY_READS = {
    rateDateRanges: [],
    originPorts: [],
    destinationPorts: [],
    contractOwners: [],
    sailingDateRanges: [],
    predictiveDateRanges: []
};

function secrets() {
    return [ADMIN_KEY, CLOUDBBS_TOKEN];
}

function countBookingCodeLine(body, code) {
    const needle = `Today's Booking Code: ${code}`;
    let count = 0;
    let from = 0;
    while (true) {
        const at = body.indexOf(needle, from);
        if (at === -1) break;
        count += 1;
        from = at + needle.length;
    }
    return count;
}

describe('R1-28 booking code format', () => {
    it('places the same code once in the body line and once as bookingCode', () => {
        const announcement = buildAnnouncement({
            generatedAt: '2026-11-16T12:00:00.000Z',
            source: 'http://127.0.0.1:9',
            reads: EMPTY_READS,
            bookingCode: 'ABCDE1234'
        });
        assert.equal(announcement.bookingCode, 'ABCDE1234');
        assert.match(announcement.bookingCode, BOOKING_CODE_RE);
        assert.equal(countBookingCodeLine(announcement.body, 'ABCDE1234'), 1);
        const parsed = extractJsonBlock(announcement.body);
        assert.equal(parsed.bookingCode, 'ABCDE1234');
        assert.equal(parsed.schema, REFERENCE_SCHEMA);
        assert.deepEqual(Object.keys(parsed), [
            'schema',
            'generatedAt',
            'bookingCode',
            'source',
            'reads'
        ]);
        assert.deepEqual(parsed.reads, EMPTY_READS);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'companies'), false);
    });

    it('two injected generators produce different codes that both match the pattern', () => {
        const first = buildAnnouncement({
            generatedAt: '2026-11-16T12:00:00.000Z',
            source: 'http://127.0.0.1:9',
            reads: EMPTY_READS,
            generateBookingCode: () => 'AAAAA0001'
        });
        const second = buildAnnouncement({
            generatedAt: '2026-11-16T12:00:00.000Z',
            source: 'http://127.0.0.1:9',
            reads: EMPTY_READS,
            generateBookingCode: () => 'ZZZZZ9999'
        });
        assert.match(first.bookingCode, BOOKING_CODE_RE);
        assert.match(second.bookingCode, BOOKING_CODE_RE);
        assert.notEqual(first.bookingCode, second.bookingCode);
        assert.equal(extractJsonBlock(first.body).bookingCode, first.bookingCode);
        assert.equal(extractJsonBlock(second.body).bookingCode, second.bookingCode);
    });

    it('real generateBookingCode draws 9 A–Z0–9 chars and covers the alphabet over 10000 draws', () => {
        const seen = new Set();
        for (let i = 0; i < 10000; i += 1) {
            const code = generateBookingCode();
            assert.match(code, BOOKING_CODE_RE);
            assert.equal(code.length, BOOKING_CODE_LENGTH);
            for (const ch of code) seen.add(ch);
        }
        assert.equal(seen.size, BOOKING_CODE_ALPHABET.length);
        for (const ch of BOOKING_CODE_ALPHABET) {
            assert.equal(seen.has(ch), true, `missing alphabet char ${ch}`);
        }
    });
});

describe('R1-28 post-cloudbbs booking code', { concurrency: 1 }, () => {
    it('posts a fresh bookingCode matching the body line with the exact five top-level keys', async () => {
        const pages = emptyPagesByPath();
        pages['/api/admin/v1/reference/origin-ports'] = [{ value: 'Port Klang', code: 'MYPKG', name: 'Port Klang' }];
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
            assert.equal(result.status, 0, result.stderr + result.stdout);
            assert.equal(cloudBbs.requests.length, 1);
            const body = cloudBbs.requests[0].body.body;
            const parsed = extractJsonBlock(body);
            assert.match(parsed.bookingCode, BOOKING_CODE_RE);
            assert.equal(countBookingCodeLine(body, parsed.bookingCode), 1);
            assert.deepEqual(Object.keys(parsed), [
                'schema',
                'generatedAt',
                'bookingCode',
                'source',
                'reads'
            ]);
            assert.deepEqual(parsed.reads.originPorts, [
                { value: 'Port Klang', code: 'MYPKG', name: 'Port Klang' }
            ]);
            assert.deepEqual(parsed.reads.rateDateRanges, []);
            assert.deepEqual(parsed.reads.destinationPorts, []);
            assert.deepEqual(parsed.reads.contractOwners, []);
            assert.deepEqual(parsed.reads.sailingDateRanges, []);
            assert.deepEqual(parsed.reads.predictiveDateRanges, []);
            assert.equal(Object.prototype.hasOwnProperty.call(parsed.reads, 'companies'), false);
            assertSecretsAbsent(result, secrets(), [cloudBbs.requests[0].rawBody]);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('two successful posts draw different booking codes', async () => {
        const pages = emptyPagesByPath();
        const admin = await startFakeAdminReference({ pagesByPath: pages });
        const cloudBbs = await startFakeCloudBbs();
        try {
            const first = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            const second = await runAdminCli(['post-cloudbbs', '--yes'], {
                baseUrl: admin.baseUrl,
                cloudBbsUrl: cloudBbs.baseUrl,
                env: {
                    RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY,
                    CLOUDBBS_TOKEN
                }
            });
            assert.equal(first.status, 0, first.stderr);
            assert.equal(second.status, 0, second.stderr);
            assert.equal(cloudBbs.requests.length, 2);
            const code1 = extractJsonBlock(cloudBbs.requests[0].body.body).bookingCode;
            const code2 = extractJsonBlock(cloudBbs.requests[1].body.body).bookingCode;
            assert.match(code1, BOOKING_CODE_RE);
            assert.match(code2, BOOKING_CODE_RE);
            assert.notEqual(code1, code2);
        } finally {
            await cloudBbs.close();
            await admin.close();
        }
    });

    it('a failed read still sends zero CloudBBS requests and draws no posted code', async () => {
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
});
