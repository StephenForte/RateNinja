'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describe, it } = require('node:test');
const { insertAgent } = require('./helpers/r1-45');

const root = path.resolve(__dirname, '..');
const INTERRUPTED_SUMMARY = 'Run interrupted before this agent finished.';

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function boot(dbPath) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    delete env.MIGRATIONS_DIR;
    execFileSync(process.execPath, ['-e', "require('./lib/db').db.close()"], {
        cwd: root,
        env,
        stdio: 'pipe'
    });
}

function startServer(dbPath, port) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: dbPath,
        PORT: String(port),
        HOST: '127.0.0.1',
        SESSION_SECRET: 'test-session-secret-value-which-is-long',
        OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
    };
    delete env.MIGRATIONS_DIR;
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Server did not start:\n${output}`));
        }, 20000);
        const onData = chunk => {
            output += chunk.toString();
            if (output.includes('Rate Ninja is running')) {
                clearTimeout(timer);
                resolve(output);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', code => {
            clearTimeout(timer);
            reject(new Error(`Server exited ${code} before listening:\n${output}`));
        });
    });
    return { child, ready };
}

function stopServer(child) {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

describe('r1-45 interrupted run recovery', () => {
    it('finishes only the agents that interrupted run started', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r145-recovery-'));
        const dbPath = path.join(directory, 'app.db');
        assert.equal(dbPath.includes(`${path.sep}data${path.sep}rateninja.db`), false);
        let db;
        try {
            boot(dbPath);
            db = new DatabaseSync(dbPath);
            insertAgent(db, { id: 'started-running', companyId: 'co', userId: 'user', status: 'running' });
            insertAgent(db, {
                id: 'started-done', companyId: 'co', userId: 'user', status: 'completed', summary: 'kept'
            });
            insertAgent(db, { id: 'other-running', companyId: 'co', userId: 'user', status: 'running' });
            db.prepare(`
                INSERT INTO managed_agent_runs (
                    id, started_by_user_id, started_at, status, started_agent_ids, summary
                ) VALUES ('run-1', 'user', '2026-11-20T01:00:00.000Z', 'running', ?, '')
            `).run(JSON.stringify(['started-running', 'started-done']));
            db.close();
            db = null;

            const first = startServer(dbPath, await freePort());
            try {
                await first.ready;
            } catch (error) {
                await stopServer(first.child);
                throw error;
            }
            await stopServer(first.child);

            db = new DatabaseSync(dbPath);
            const run = db.prepare('SELECT status, finished_at FROM managed_agent_runs WHERE id = ?').get('run-1');
            assert.equal(run.status, 'interrupted');
            assert.ok(run.finished_at);
            const agents = db.prepare('SELECT id, status, result_summary FROM managed_agents ORDER BY id').all()
                .map(row => ({ id: row.id, status: row.status, result_summary: row.result_summary }));
            assert.deepEqual(agents, [
                { id: 'other-running', status: 'running', result_summary: null },
                { id: 'started-done', status: 'completed', result_summary: 'kept' },
                { id: 'started-running', status: 'failed', result_summary: INTERRUPTED_SUMMARY }
            ]);
            const audits = db.prepare(
                "SELECT detail FROM audit_events WHERE event_type = 'managed_agent_finished'"
            ).all().map(row => JSON.parse(row.detail));
            assert.deepEqual(audits, [{ agentId: 'started-running', companyId: 'co', status: 'failed' }]);
            db.close();
            db = null;

            const second = startServer(dbPath, await freePort());
            try {
                await second.ready;
            } catch (error) {
                await stopServer(second.child);
                throw error;
            }
            await stopServer(second.child);
            db = new DatabaseSync(dbPath);
            assert.equal(db.prepare('SELECT status FROM managed_agent_runs WHERE id = ?').get('run-1').status, 'interrupted');
            assert.equal(db.prepare(
                "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'managed_agent_finished'"
            ).get().n, 1);
            assert.equal(db.prepare("SELECT status FROM managed_agents WHERE id = 'other-running'").get().status, 'running');
        } finally {
            db?.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
