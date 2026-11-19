'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
    COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER, insertCompany, insertUser, insertRate, insertMargin, utcDay
} = require('./r1-19');

const ADMIN_KEY = 'r142-sample-admin-key-0123456789';
const ROOT = '/api/admin/v1/managed-agents';
const PASSWORD_HASH = 'sample-password-hash-sentinel';
const EMAIL = 'sample-email-sentinel@example.test';
const RATE_TYPE = 'Port to Port';
const BASE_LOW = 6543;
const BASE_HIGH = 8123;
const EXPIRED_BASE = 2222;
const MARGIN = { percent: 0, number: 250 };

function seedSampleWorld(db) {
    const companies = {
        owner: 'sample-owner',
        expiredOwner: 'sample-expired-owner',
        edgeOwner: 'sample-edge-owner',
        edgeCustomer: 'sample-edge-customer',
        blackwater: 'sample-blackwater',
        blueSky: 'sample-bluesky',
        testBuyer: 'sample-testbuyer',
        empty: 'sample-empty'
    };
    insertCompany(db, { id: companies.owner, name: 'Synthetic Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
    insertCompany(db, { id: companies.expiredOwner, name: 'Expired Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
    insertCompany(db, { id: companies.blackwater, name: 'Blackwater Shippers', type: COMPANY_TYPE_CUSTOMER });
    insertCompany(db, { id: companies.blueSky, name: 'Blue Sky Shipping', type: COMPANY_TYPE_CUSTOMER });
    insertCompany(db, { id: companies.testBuyer, name: 'Test Buyer Co', type: COMPANY_TYPE_CUSTOMER });
    insertCompany(db, { id: companies.empty, name: 'Empty Lane Co', type: COMPANY_TYPE_CUSTOMER });
    insertCompany(db, { id: companies.edgeOwner, name: 'Edge Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
    insertCompany(db, { id: companies.edgeCustomer, name: 'Edge Customer', type: COMPANY_TYPE_CUSTOMER });

    const users = {
        alan: { id: 'user-alan', username: 'alan-code', displayName: 'A lan', companyId: companies.blackwater },
        bob: { id: 'user-bob', username: 'B ob', displayName: 'person', companyId: companies.blueSky },
        bobby: { id: 'user-bobby', username: 'bobby', displayName: 'Bobby', companyId: companies.blueSky },
        testBuyer: { id: 'user-testbuyer', username: 'tb-user', displayName: 'Test Buyer', companyId: companies.testBuyer },
        nora: { id: 'user-nora', username: 'nora', displayName: 'Nora', companyId: companies.testBuyer },
        disabled: { id: 'user-disabled', username: 'disabled-bob', displayName: 'Bob Disabled', companyId: companies.testBuyer },
        owner: { id: 'user-owner', username: 'owner-alan', displayName: 'Alan Owner', companyId: companies.owner },
        empty: { id: 'user-empty', username: 'empty-user', displayName: 'Empty Lane', companyId: companies.empty },
        edge: { id: 'user-edge', username: 'edge-user', displayName: 'Edge User', companyId: companies.edgeCustomer }
    };
    for (const user of Object.values(users)) {
        insertUser(db, user);
        db.prepare('UPDATE users SET password_hash = ?, email = ? WHERE id = ?').run(PASSWORD_HASH, EMAIL, user.id);
    }
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(users.disabled.id);

    for (const customer of [companies.blackwater, companies.blueSky, companies.testBuyer]) {
        insertMargin(db, {
            id: `margin-${customer}`,
            owner: companies.owner,
            customer,
            percent: MARGIN.percent,
            number: MARGIN.number
        });
    }
    insertMargin(db, {
        id: 'margin-edge',
        owner: companies.edgeOwner,
        customer: companies.edgeCustomer,
        percent: MARGIN.percent,
        number: MARGIN.number
    });
    insertMargin(db, {
        id: 'margin-empty',
        owner: companies.expiredOwner,
        customer: companies.empty,
        percent: MARGIN.percent,
        number: MARGIN.number
    });

    const pricedLanes = [['SHA', 'LAX'], ['SHA', 'OAK'], ['SIN', 'NYC']];
    for (const [origin, destination] of pricedLanes) {
        for (const [suffix, base] of [['low', BASE_LOW], ['high', BASE_HIGH]]) {
            const id = `sample-${origin}-${destination}-${suffix}`.toLowerCase();
            insertRate(db, {
                id,
                owner: companies.owner,
                origin,
                destination,
                rate20: null,
                rate40: base,
                rate40hc: null,
                effective: utcDay(0),
                expiration: utcDay(20)
            });
            db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, id);
        }
    }
    insertRate(db, {
        id: 'sample-unpriced',
        owner: companies.owner,
        origin: 'NGB',
        destination: 'LAX',
        rate20: null,
        rate40: null,
        rate40hc: null,
        effective: utcDay(0),
        expiration: utcDay(20)
    });
    db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'sample-unpriced');
    insertRate(db, {
        id: 'sample-expired',
        owner: companies.owner,
        origin: 'OLD',
        destination: 'GONE',
        rate20: null,
        rate40: EXPIRED_BASE,
        rate40hc: null,
        effective: utcDay(-10),
        expiration: utcDay(-1)
    });
    db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'sample-expired');
    insertRate(db, {
        id: 'sample-empty-expired',
        owner: companies.expiredOwner,
        origin: 'SHA',
        destination: 'LAX',
        rate20: null,
        rate40: EXPIRED_BASE,
        rate40hc: null,
        effective: utcDay(-10),
        expiration: utcDay(-1)
    });
    db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'sample-empty-expired');
    insertRate(db, {
        id: 'sample-edge',
        owner: companies.edgeOwner,
        origin: 'EDGE',
        destination: 'DAY',
        rate20: null,
        rate40: BASE_LOW,
        rate40hc: null,
        effective: utcDay(0),
        expiration: utcDay(0)
    });
    db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'sample-edge');
    insertRate(db, {
        id: 'sample-edge-expired',
        owner: companies.edgeOwner,
        origin: 'OLD',
        destination: 'EDGE',
        rate20: null,
        rate40: EXPIRED_BASE,
        rate40hc: null,
        effective: utcDay(-5),
        expiration: utcDay(-1)
    });
    db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, 'sample-edge-expired');

    return { companies, users, rateType: RATE_TYPE };
}

function runSampleCli(args, { env = {}, input = '', baseUrl, dbPath, timeoutMs = 15000 } = {}) {
    const cliEnv = {
        ...process.env,
        RATE_NINJA_BASE_URL: baseUrl,
        SQLITE_DB_PATH: dbPath,
        ...env
    };
    if (!Object.prototype.hasOwnProperty.call(env, 'RATE_NINJA_ADMIN_API_KEY')) {
        delete cliEnv.RATE_NINJA_ADMIN_API_KEY;
    }
    delete cliEnv.RATE_NINJA_API_KEY;
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
            resolve({ status: 124, stdout, stderr: `${stderr}\nCLI timed out\n` });
        }, timeoutMs);
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        child.stdin.end(input);
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status: code, stdout, stderr });
        });
    });
}

module.exports = {
    ADMIN_KEY,
    ROOT,
    PASSWORD_HASH,
    EMAIL,
    BASE_LOW,
    BASE_HIGH,
    EXPIRED_BASE,
    MARGIN,
    RATE_TYPE,
    seedSampleWorld,
    runSampleCli
};
