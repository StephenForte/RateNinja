'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction } = require('./db');
const { canRequestBooking } = require('./permissions');
const { get: getSwarm, SwarmError } = require('./swarms');
const { readBbsCredentials } = require('./swarm-secrets');
const { clientAgentSettings } = require('./client-agent');
const { DEFAULT_CLOUDBBS_PROJECT } = require('./cloudbbs-post');
const { performRun } = require('./swarm-engine');
const {
    recordAudit, EVENT_SWARM_RUN_STARTED, EVENT_SWARM_RUN_FINISHED, EVENT_SWARM_RUN_CANCEL_REQUESTED
} = require('./audit');

function presentRun(row, includeAgents = false) {
    const snapshot = JSON.parse(row.snapshot);
    const run = {
        id: row.id,
        swarmId: row.swarm_id,
        swarmName: snapshot.name,
        status: row.status,
        startedByUserId: row.started_by_user_id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        summary: row.summary,
        failureReason: row.failure_reason,
        totalSpendCap: snapshot.totalSpendCap,
        totalSlotsCap: snapshot.totalSlotsCap,
        spendBooked: row.spend_booked,
        slotsBooked: row.slots_booked,
        masterTurns: row.master_turns,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cancelRequested: row.cancel_requested === 1
    };
    if (includeAgents) {
        run.agents = db.prepare(`
            SELECT id, role, lane_position AS lanePosition, attempt, status, origin_port AS originPort,
                destination_port AS destinationPort, sailing_date AS sailingDate, started_at AS startedAt,
                finished_at AS finishedAt, report, rate_id AS rateId, price, slots,
                booking_request_id AS bookingRequestId
            FROM swarm_run_agents WHERE run_id = ? ORDER BY started_at, rowid
        `).all(row.id);
    }
    return run;
}

function companyRun(actor, id) {
    const row = db.prepare('SELECT * FROM swarm_runs WHERE id = ? AND company_id = ?')
        .get(id, actor?.company?.id || '');
    if (!row) throw new SwarmError(404, 'Swarm run not found.');
    return row;
}

function list(actor) {
    return db.prepare(`
        SELECT * FROM swarm_runs WHERE company_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 50
    `).all(actor?.company?.id || '').map(row => presentRun(row));
}

function get(actor, id) {
    return presentRun(companyRun(actor, id), true);
}

function redactText(secrets) {
    const needles = secrets.filter(Boolean).sort((a, b) => b.length - a.length);
    return text => needles.reduce((safe, needle) => safe.replaceAll(needle, '[redacted]'), text);
}

function start(actor, swarmId, { fetchImpl = fetch, clock = Date.now, env = process.env } = {}) {
    const settings = clientAgentSettings(env);
    let credentials;
    let redact;
    const row = transaction(() => {
        const { canEdit, ...snapshot } = getSwarm(actor, swarmId);
        credentials = readBbsCredentials(actor.company.id);
        const reasons = [];
        if (!settings.anthropicKey.trim()) reasons.push('ANTHROPIC_API_KEY');
        if (!credentials || credentials.bbsProject === DEFAULT_CLOUDBBS_PROJECT) reasons.push('private CloudBBS credentials');
        if (reasons.length) {
            const error = new SwarmError(409, 'Swarm run prerequisites are missing.', 'swarm_not_ready');
            error.reasons = reasons;
            throw error;
        }
        if (snapshot.lanes.some(lane => lane.allowBookingRequest) && !canRequestBooking(actor)) {
            throw new SwarmError(403, 'You cannot request a booking.', 'cannot_request_booking');
        }
        redact = redactText([settings.anthropicKey, credentials.bbsToken, credentials.bbsProject]);
        snapshot.name = redact(snapshot.name);
        snapshot.instructions = redact(snapshot.instructions);
        const inserted = db.prepare(`
            INSERT INTO swarm_runs (id, swarm_id, company_id, started_by_user_id, status, snapshot, started_at)
            VALUES (?, ?, ?, ?, 'running', ?, ?)
            ON CONFLICT(company_id) WHERE status = 'running' DO NOTHING
            RETURNING *
        `).get(randomUUID(), swarmId, actor.company.id, actor.id, JSON.stringify(snapshot), new Date(clock()).toISOString());
        if (!inserted) throw new SwarmError(409, 'Your company has an active swarm run.', 'run_active');
        audit(EVENT_SWARM_RUN_STARTED, inserted, actor.id);
        return inserted;
    });
    setImmediate(() => {
        performRun(row, { settings, credentials, redact, fetchImpl, clock, settle }).catch(() => {
            // The process must survive a database failure while settling a run.
            console.error('Could not settle swarm run', row.id);
        });
    });
    return presentRun(row);
}

function cancel(actor, id) {
    return transaction(() => {
        const row = companyRun(actor, id);
        if (row.status !== 'running') throw new SwarmError(409, 'This swarm run has ended.', 'not_running');
        if (!row.cancel_requested) {
            db.prepare('UPDATE swarm_runs SET cancel_requested = 1 WHERE id = ?').run(id);
            row.cancel_requested = 1;
            audit(EVENT_SWARM_RUN_CANCEL_REQUESTED, row, actor.id);
        }
        return presentRun(row);
    });
}

function audit(event, row, actorUserId) {
    recordAudit(event, { actorUserId, detail: {
        runId: row.id, swarmId: row.swarm_id, companyId: row.company_id, status: row.status
    } });
}

function settleInTransaction(row, status, finishedAt, summary, reason) {
    const updated = db.prepare(`
        UPDATE swarm_runs SET status = ?, finished_at = ?, summary = ?, failure_reason = ?
        WHERE id = ? AND status = 'running' RETURNING *
    `).get(status, finishedAt, summary, reason, row.id);
    if (!updated) return;
    db.prepare(`
        UPDATE swarm_run_agents SET status = ?, finished_at = ?, report = COALESCE(report, ?)
        WHERE run_id = ? AND status = 'running'
    `).run(status === 'cancelled' ? 'cancelled' : 'failed', finishedAt, reason ?? status, row.id);
    audit(EVENT_SWARM_RUN_FINISHED, updated, row.started_by_user_id);
}

function settle(row, status, finishedAt, summary = null, reason = null) {
    transaction(() => settleInTransaction(row, status, finishedAt, summary, reason));
}

function recoverInterruptedRuns() {
    transaction(() => {
        const finishedAt = new Date().toISOString();
        for (const row of db.prepare("SELECT * FROM swarm_runs WHERE status = 'running'").all()) {
            settleInTransaction(row, 'interrupted', finishedAt, null, 'process_restart');
        }
    });
}

module.exports = { start, list, get, cancel, recoverInterruptedRuns };
