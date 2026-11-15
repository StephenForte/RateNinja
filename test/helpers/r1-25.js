'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ADMIN_KEY = 'r125-admin-test-key-32chars-xxxxxx';
const DEMO_KEY = 'demo-key';
const SHORT_KEY = 'r125-short-key-exactly-31-chars'; // 31 chars
const EQUAL_KEY = 'r125-equal-key-exactly-32-chars!'; // 32 chars

const ADMIN_ROOT = '/api/admin/v1/reference';
const PARTNER_ROOT = '/api/partner/v1/me';

const ADMIN_ROUTES = [
    'rate-date-ranges',
    'origin-ports',
    'destination-ports',
    'contract-owners',
    'sailing-date-ranges',
    'predictive-date-ranges',
    'companies'
];

const PARITY_ROUTES = [
    'rate-date-ranges',
    'origin-ports',
    'destination-ports',
    'contract-owners',
    'sailing-date-ranges',
    'predictive-date-ranges'
];

function adminModules() {
    return {
        config: require('../../lib/config').config,
        resetAdminApiWindowForTests: require('../../lib/admin-api-key').resetAdminApiWindowForTests
    };
}

function applyAdminKey(value) {
    const { config, resetAdminApiWindowForTests } = adminModules();
    config.adminApiKey = value;
    resetAdminApiWindowForTests();
}

function applyDemoKey(value) {
    adminModules().config.publicApiKey = value;
}

function enableAdminKey() {
    applyDemoKey(DEMO_KEY);
    applyAdminKey(ADMIN_KEY);
}

function resetAdminApiWindowForTests() {
    adminModules().resetAdminApiWindowForTests();
}

async function adminGet(baseUrl, routePath, { key = ADMIN_KEY, query = '', headers = {} } = {}) {
    const url = `${baseUrl}${ADMIN_ROOT}/${routePath}${query ? `?${query}` : ''}`;
    const requestHeaders = { ...headers };
    if (key != null) requestHeaders['x-admin-api-key'] = key;
    const response = await fetch(url, { headers: requestHeaders });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: response.status, text, body };
}

function assertNoPrices(body) {
    const text = JSON.stringify(body);
    for (const needle of ['rate20D', 'rate40D', 'rate40HC', 'customerPrice', '20D Rate', '40D rate', '40HC Rate']) {
        if (text.includes(needle)) {
            throw new Error(`Price field leaked: ${needle}`);
        }
    }
}

function runAdminCli(args, { env = {}, input = null, baseUrl, timeoutMs = 15_000 } = {}) {
    // Must be async spawn: spawnSync blocks the test process event loop, so the
    // in-process server cannot answer the CLI's HTTP requests (deadlock).
    const cliEnv = {
        ...process.env,
        RATE_NINJA_BASE_URL: baseUrl,
        ...env
    };
    // Never inherit a real admin key from the parent unless the caller set one.
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
            resolve({ status: null, stdout, stderr, signal: 'SIGTERM', timedOut: true });
        }, timeoutMs);
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('close', (status, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status, stdout, stderr, signal, timedOut: false });
        });
        if (input != null) child.stdin.write(input);
        child.stdin.end();
    });
}

function randomAdminKey() {
    return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
    ADMIN_KEY,
    DEMO_KEY,
    SHORT_KEY,
    EQUAL_KEY,
    ADMIN_ROOT,
    PARTNER_ROOT,
    ADMIN_ROUTES,
    PARITY_ROUTES,
    applyAdminKey,
    applyDemoKey,
    enableAdminKey,
    adminGet,
    assertNoPrices,
    runAdminCli,
    randomAdminKey,
    resetAdminApiWindowForTests
};
