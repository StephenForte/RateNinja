'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction } = require('./db');
const { clientAgentSettings } = require('./client-agent');
const { finishInterrupted } = require('./managed-agents');
const { runManagedAgents } = require('./managed-agent-runner');

const SUMMARY_MAX = 32768;
const POLL_NOTE = 'Earlier output omitted.\n';
const INTERRUPTED_SUMMARY = 'Run interrupted before this agent finished.';

let testRunner = null;
let testClock = null;
let invocations = 0;

function now() {
    return testClock ? testClock() : Date.now();
}

function setTestClock(fn) {
    if (process.env.NODE_ENV !== 'test') return;
    testClock = typeof fn === 'function' ? fn : null;
}

function setTestRunner(fn) {
    if (process.env.NODE_ENV !== 'test') return;
    testRunner = typeof fn === 'function' ? fn : null;
}

function invocationCount() {
    return invocations;
}

function resetInvocationCount() {
    invocations = 0;
}

function secretList(env) {
    const names = [
        'RATE_NINJA_ADMIN_API_KEY',
        'RATE_NINJA_API_KEY',
        'RATE_NINJA_BUYER_API_KEY',
        'ANTHROPIC_API_KEY',
        'CLOUDBBS_AGENT_TOKEN',
        'CLOUDBBS_TOKEN',
        'CLOUDBBS_SERVER_TOKEN',
        'SESSION_SECRET',
        'OAUTH_SIGNING_SECRET'
    ];
    return names
        .map(name => env[name])
        .filter(value => typeof value === 'string' && value.length >= 8)
        .sort((left, right) => right.length - left.length);
}

function redact(text, secrets) {
    let safe = String(text);
    for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
    return safe;
}

function boundSummary(text) {
    if (text.length <= SUMMARY_MAX) return text;
    return POLL_NOTE + text.slice(text.length - (SUMMARY_MAX - POLL_NOTE.length));
}

function postSchedule(at) {
    const date = new Date(at);
    const windowClosed = date.getUTCHours() === 0 && date.getUTCMinutes() >= 15 && date.getUTCMinutes() < 19;
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 17, 0, 0));
    if (at >= next.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return { windowClosed, nextPostAt: next.toISOString() };
}

function missingSettings(env = process.env) {
    return clientAgentSettings(env).missing.filter(name => name !== 'RATE_NINJA_BUYER_API_KEY');
}

function missingMessage(missing) {
    return `Set ${missing.join(' and ')} to run managed agents.`;
}

function queuedCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM managed_agents WHERE status = 'queued'").get().n;
}

function rowById(id) {
    return db.prepare('SELECT * FROM managed_agent_runs WHERE id = ?').get(id);
}

function latestRow() {
    return db.prepare('SELECT * FROM managed_agent_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get() || null;
}

function presentRun(row) {
    if (!row) return null;
    const user = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(row.started_by_user_id);
    let startedAgentIds = [];
    try {
        const parsed = JSON.parse(row.started_agent_ids);
        if (Array.isArray(parsed)) startedAgentIds = parsed.filter(id => typeof id === 'string');
    } catch {
        startedAgentIds = [];
    }
    return {
        id: row.id,
        status: row.status,
        startedBy: user?.display_name || user?.username || '',
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        startedAgentIds,
        summary: row.summary
    };
}

function readiness(env = process.env) {
    const missing = missingSettings(env);
    const schedule = postSchedule(now());
    const running = db.prepare("SELECT id FROM managed_agent_runs WHERE status = 'running' LIMIT 1").get();
    const state = {
        queuedCount: queuedCount(),
        missingSettings: missing,
        windowClosed: schedule.windowClosed,
        nextPostAt: schedule.nextPostAt,
        runInProgress: Boolean(running)
    };
    state.disabledReason = disabledReason(state);
    return state;
}

function disabledReason(state) {
    if (state.missingSettings.length) return missingMessage(state.missingSettings);
    if (state.windowClosed) return 'Runs are paused from 00:15 to 00:19 UTC, around the daily CloudBBS post.';
    if (state.runInProgress) return 'A run is already in progress.';
    if (state.queuedCount === 0) return 'No queued managed agents.';
    return null;
}

function latestPayload(env = process.env) {
    return { run: presentRun(latestRow()), readiness: readiness(env) };
}

function insertRun(userId) {
    const id = randomUUID();
    const startedAt = new Date(now()).toISOString();
    try {
        return transaction(() => {
            const result = db.prepare(`
                INSERT INTO managed_agent_runs (
                    id, started_by_user_id, started_at, status, started_agent_ids, summary
                )
                SELECT ?, ?, ?, 'running', '[]', ''
                WHERE NOT EXISTS (
                    SELECT 1 FROM managed_agent_runs WHERE status = 'running'
                )
            `).run(id, userId, startedAt);
            if (result.changes !== 1) return null;
            return rowById(id);
        });
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) return null;
        throw error;
    }
}

function appendStarted(runId, agentId) {
    if (typeof agentId !== 'string' || !agentId) return;
    transaction(() => {
        const row = db.prepare(`
            SELECT started_agent_ids FROM managed_agent_runs WHERE id = ? AND status = 'running'
        `).get(runId);
        if (!row) return;
        let ids = [];
        try {
            const parsed = JSON.parse(row.started_agent_ids);
            if (Array.isArray(parsed)) ids = parsed.filter(id => typeof id === 'string');
        } catch {
            ids = [];
        }
        if (!ids.includes(agentId)) ids.push(agentId);
        db.prepare('UPDATE managed_agent_runs SET started_agent_ids = ? WHERE id = ?').run(JSON.stringify(ids), runId);
    });
}

function settle(runId, status, exitCode, summary) {
    db.prepare(`
        UPDATE managed_agent_runs
        SET status = ?, exit_code = ?, finished_at = ?, summary = ?
        WHERE id = ? AND status = 'running'
    `).run(status, exitCode, new Date(now()).toISOString(), summary, runId);
}

async function performRun(runId) {
    invocations += 1;
    const env = { ...process.env };
    const secrets = secretList(env);
    let summary = '';
    const capture = chunk => {
        summary = boundSummary(redact(summary + String(chunk), secrets));
        try {
            db.prepare(`
                UPDATE managed_agent_runs SET summary = ? WHERE id = ? AND status = 'running'
            `).run(summary, runId);
        } catch {
            // A summary write must not take down the process. settle() writes it again.
        }
    };
    const impl = process.env.NODE_ENV === 'test' && testRunner ? testRunner : runManagedAgents;
    try {
        const code = await impl({
            confirmed: true,
            env,
            stdout: { write: capture },
            stderr: { write: capture },
            onAgentStarted: id => appendStarted(runId, id)
        });
        settle(runId, code === 0 ? 'succeeded' : 'failed', Number.isInteger(code) ? code : null, summary);
    } catch (error) {
        capture(`\n${error instanceof Error ? error.message : 'Run failed.'}`);
        try {
            settle(runId, 'failed', null, summary);
        } catch {
            // The process stays up even when the failure itself cannot be stored.
        }
    }
}

function launch(runId) {
    const task = performRun(runId);
    task.catch(() => {});
    return task;
}

function recoverInterruptedRuns() {
    const runs = db.prepare("SELECT id, started_agent_ids FROM managed_agent_runs WHERE status = 'running'").all();
    for (const run of runs) {
        let ids = [];
        try {
            const parsed = JSON.parse(run.started_agent_ids || '[]');
            if (Array.isArray(parsed)) ids = parsed;
        } catch {
            ids = [];
        }
        for (const id of ids) {
            if (typeof id === 'string') finishInterrupted(id, INTERRUPTED_SUMMARY);
        }
        db.prepare(`
            UPDATE managed_agent_runs SET status = 'interrupted', finished_at = ?
            WHERE id = ? AND status = 'running'
        `).run(new Date(now()).toISOString(), run.id);
    }
}

module.exports = {
    INTERRUPTED_SUMMARY,
    SUMMARY_MAX,
    appendStarted,
    disabledReason,
    invocationCount,
    latestPayload,
    launch,
    missingMessage,
    performRun,
    presentRun,
    readiness,
    recoverInterruptedRuns,
    resetInvocationCount,
    setTestClock,
    setTestRunner,
    insertRun
};
