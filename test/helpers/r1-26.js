'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ADMIN_KEY, enableAdminKey } = require('./r1-25');
const { REFERENCE_READS, extractJsonBlock } = require('../../lib/cloudbbs-post');

const CLOUDBBS_TOKEN = 'r126-cloudbbs-token-do-not-leak';
const ADMIN_KEY_FOR_LEAK = ADMIN_KEY;

function startFakeCloudBbs({
    token = CLOUDBBS_TOKEN,
    status = 200,
    responseBody = null,
    onRequest = null
} = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try {
                parsed = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                parsed = null;
            }
            const entry = {
                method: req.method,
                url: req.url,
                headers: {
                    authorization: req.headers.authorization || '',
                    'content-type': req.headers['content-type'] || ''
                },
                rawBody,
                body: parsed
            };
            requests.push(entry);
            if (onRequest) onRequest(entry);

            const auth = req.headers.authorization || '';
            if (auth !== `Bearer ${token}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
            if (req.method !== 'PUT') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'method_not_allowed' }));
                return;
            }
            const projectMatch = /^\/api\/v1\/projects\/([^/]+)\/announcement$/.exec(req.url || '');
            if (!projectMatch) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'not_found' }));
                return;
            }
            const payload = responseBody || {
                projectSlug: decodeURIComponent(projectMatch[1]),
                version: requests.length,
                updatedAt: '2026-11-15T20:00:00.000Z'
            };
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                requests,
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close(error => (error ? closeReject(error) : closeResolve()));
                })
            });
        });
        server.on('error', reject);
    });
}

function startFakeAdminReference({
    pagesByPath = {},
    failOn = null,
    pageSize = 100
} = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: url.pathname, search: url.search });
        if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        const page = Number(url.searchParams.get('page') || '1');
        if (failOn && failOn.path === url.pathname && failOn.page === page) {
            res.writeHead(failOn.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: failOn.error || 'server_error' }));
            return;
        }
        const allRows = pagesByPath[url.pathname] || [];
        const start = (page - 1) * pageSize;
        const data = allRows.slice(start, start + pageSize);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            data,
            meta: {
                total: allRows.length,
                page,
                pageSize,
                returned: data.length
            }
        }));
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                baseUrl: `http://127.0.0.1:${port}`,
                requests,
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close(error => (error ? closeReject(error) : closeResolve()));
                })
            });
        });
        server.on('error', reject);
    });
}

function emptyPagesByPath() {
    const pages = {};
    for (const read of REFERENCE_READS) {
        pages[read.path] = [];
    }
    return pages;
}

function runAdminCli(args, { env = {}, input = null, baseUrl, cloudBbsUrl, timeoutMs = 15_000 } = {}) {
    const cliEnv = {
        ...process.env,
        RATE_NINJA_BASE_URL: baseUrl,
        ...env
    };
    if (cloudBbsUrl != null) cliEnv.CLOUDBBS_URL = cloudBbsUrl;
    if (!Object.prototype.hasOwnProperty.call(env, 'RATE_NINJA_ADMIN_API_KEY')) {
        delete cliEnv.RATE_NINJA_ADMIN_API_KEY;
    }
    if (!Object.prototype.hasOwnProperty.call(env, 'CLOUDBBS_TOKEN')) {
        delete cliEnv.CLOUDBBS_TOKEN;
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

function assertSecretsAbsent(result, secrets, putBodies = []) {
    for (const secret of secrets) {
        if (!secret) continue;
        if (result.stdout.includes(secret)) {
            throw new Error(`Secret leaked in stdout: ${secret.slice(0, 8)}…`);
        }
        if (result.stderr.includes(secret)) {
            throw new Error(`Secret leaked in stderr: ${secret.slice(0, 8)}…`);
        }
        for (const body of putBodies) {
            if (typeof body === 'string' && body.includes(secret)) {
                throw new Error(`Secret leaked in PUT body: ${secret.slice(0, 8)}…`);
            }
            if (body && typeof body === 'object') {
                const text = JSON.stringify(body);
                if (text.includes(secret)) {
                    throw new Error(`Secret leaked in PUT JSON: ${secret.slice(0, 8)}…`);
                }
            }
        }
    }
}

module.exports = {
    CLOUDBBS_TOKEN,
    ADMIN_KEY_FOR_LEAK,
    ADMIN_KEY,
    enableAdminKey,
    startFakeCloudBbs,
    startFakeAdminReference,
    emptyPagesByPath,
    runAdminCli,
    assertSecretsAbsent,
    extractJsonBlock,
    REFERENCE_READS
};
