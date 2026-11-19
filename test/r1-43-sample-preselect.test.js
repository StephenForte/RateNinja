'use strict';

const assert = require('node:assert/strict');
const { before, after, it } = require('node:test');
const { startApp } = require('./helpers/app');
const { applyAdminKey } = require('./helpers/r1-25');
const { ADMIN_KEY, runSampleCli } = require('./helpers/r1-42');
const { COMPANY_TYPE_CUSTOMER, insertCompany, insertUser } = require('./helpers/r1-19');

const COMPANY_ID = 'r143-customer';

const CASES = [
    { id: 'r143-alan-davis', username: 'AlanD', displayName: 'Alan Davis', selected: true },
    { id: 'r143-bob-jones', username: 'BobJ', displayName: 'Bob Jones', selected: true },
    { id: 'r143-test-buyer', username: 'testbuyer', displayName: 'Test Buyer', selected: true },
    { id: 'r143-alan-case', username: 'plain-alan', displayName: 'ALAN davis', selected: true },
    { id: 'r143-bob-space', username: 'plain-bob', displayName: 'bob j', selected: true },
    { id: 'r143-exact-user', username: 'B ob', displayName: 'person', selected: true },
    { id: 'r143-exact-name', username: 'not-alan', displayName: 'A lan', selected: true },
    { id: 'r143-bobby', username: 'bobby', displayName: 'Bobby', selected: false },
    { id: 'r143-kalan', username: 'kalans', displayName: 'Kalan Smith', selected: false },
    { id: 'r143-bobson', username: 'jimb', displayName: 'Jim Bobson', selected: false },
    { id: 'r143-other', username: 'someone', displayName: 'Someone Else', selected: false }
];

let app;

function agentCount() {
    return app.db.prepare('SELECT COUNT(*) AS count FROM managed_agents').get().count;
}

function cli(args, input = '') {
    return runSampleCli(args, {
        input,
        baseUrl: app.baseUrl,
        dbPath: app.dbPath,
        env: { RATE_NINJA_ADMIN_API_KEY: ADMIN_KEY }
    });
}

before(async () => {
    app = await startApp();
    insertCompany(app.db, { id: COMPANY_ID, name: 'Prefix Customer Co', type: COMPANY_TYPE_CUSTOMER });
    for (const user of CASES) {
        insertUser(app.db, { ...user, companyId: COMPANY_ID });
    }
    applyAdminKey(ADMIN_KEY);
});

after(async () => { await app?.close(); });

it('pre-selects an exact compacted name or the display name first word, and writes nothing without confirmation', async () => {
    const menu = await cli([], '13\n\nn\n8\n');
    assert.equal(agentCount(), 0);
    assert.equal(menu.stdout.includes(ADMIN_KEY), false);
    assert.equal(menu.stderr.includes(ADMIN_KEY), false);
    for (const user of CASES) {
        const line = menu.stdout.split('\n').find(row => row.includes(`(${user.username})`));
        assert.ok(line, user.username);
        assert.equal(line.includes(user.selected ? '[x]' : '[ ]'), true, line);
    }

    const dry = await cli(['managed-agents-samples']);
    assert.equal(agentCount(), 0);
    assert.equal(`${dry.stdout}${dry.stderr}`.includes(ADMIN_KEY), false);
});
