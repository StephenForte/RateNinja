'use strict';

const { sendJson, securityHeaders } = require('../http');
const { isSystemAdmin, loadActor } = require('../permissions');
const runs = require('../managed-agent-runs');

function reject(response, status, code, error) {
    sendJson(response, status, { error, code }, securityHeaders());
}

function requireSystemAdmin(response, session) {
    const actor = loadActor(session.user.id);
    if (!actor || !isSystemAdmin(actor)) {
        reject(response, 403, 'forbidden', 'System admin access is required.');
        return null;
    }
    return actor;
}

function latest(request, response, session) {
    if (!requireSystemAdmin(response, session)) return;
    sendJson(response, 200, runs.latestPayload(), securityHeaders());
}

function start(request, response, session) {
    const actor = requireSystemAdmin(response, session);
    if (!actor) return;
    const state = runs.readiness();
    if (state.cloudBbsPost.inProgress) {
        reject(response, 409, 'post_in_progress', 'A CloudBBS post is already in progress.');
        return;
    }
    if (state.missingSettings.length) {
        reject(response, 503, 'runner_not_configured', runs.missingMessage(state.missingSettings));
        return;
    }
    if (state.windowClosed) {
        reject(response, 423, 'post_window', 'Managed agent runs are paused from 00:15 to 00:19 UTC.');
        return;
    }
    const row = runs.insertRun(session.user.id);
    if (!row) {
        reject(response, 409, 'run_in_progress', 'A managed agent run is already in progress.');
        return;
    }
    const run = runs.presentRun(row);
    sendJson(response, 202, { run }, securityHeaders());
    runs.launch(row.id);
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/managed-agents/runs/latest', access: 'session', handler: latest },
        { method: 'POST', path: '/api/managed-agents/runs', access: 'session', handler: start }
    ]
};
