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
    ADMIN_KEY,
    enableAdminKey,
    runAdminCli
} = require('./helpers/r1-25');

freezeToday();

describe('R1-25 admin CLI', { concurrency: 1 }, () => {
    let app;

    before(async () => {
        app = await startApp({ companyName: 'R125 CLI Co' });
        enableAdminKey();
        insertPort(app.db, { id: 'port-pkg', code: 'MYPKG', name: 'Port Klang' });
        insertRate(app.db, {
            id: 'r-cli-1',
            owner: app.company.id,
            origin: 'Port Klang',
            destination: 'LALB',
            effective: '2026-10-01',
            expiration: '2026-12-31'
        });
    });

    after(async () => {
        if (app) await app.close();
    });

    function assertKeyAbsent(result) {
        assert.equal(result.stdout.includes(ADMIN_KEY), false);
        assert.equal(result.stderr.includes(ADMIN_KEY), false);
        assert.equal(result.timedOut, false, 'CLI timed out');
    }

    it('list exits 0 and names all seven commands', async () => {
        const result = await runAdminCli(['list'], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
        });
        assert.equal(result.status, 0, result.stderr);
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
        assertKeyAbsent(result);
    });

    it('origin-ports prints a seeded port and the total line', async () => {
        const result = await runAdminCli(['origin-ports'], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Port Klang/);
        assert.match(result.stdout, /total/);
        assertKeyAbsent(result);
    });

    it('--json output parses', async () => {
        const result = await runAdminCli(['origin-ports', '--json'], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
        });
        assert.equal(result.status, 0, result.stderr);
        const body = JSON.parse(result.stdout.trim());
        assert.ok(Array.isArray(body.data));
        assert.ok(body.data.some(row => row.value === 'Port Klang'));
        assertKeyAbsent(result);
    });

    it('missing key exits 2', async () => {
        const result = await runAdminCli(['list'], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: '' }
        });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /RATE_NINJA_ADMIN_API_KEY/);
        assertKeyAbsent(result);
    });

    it('wrong key exits 1 with 401', async () => {
        const result = await runAdminCli(['origin-ports'], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: 'wrong-admin-key-value-xxxxxxxxxxxxxx' }
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /401/);
        assertKeyAbsent(result);
    });

    it('piped menu input runs a read and exits 0', async () => {
        // 2 = origin-ports; skip all prompts with blank lines; then quit.
        const input = ['2', '', '', '', '', '', '', '8'].join('\n') + '\n';
        const result = await runAdminCli([], {
            baseUrl: app.baseUrl,
            env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY },
            input
        });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /Port Klang/);
        assertKeyAbsent(result);
    });
});
