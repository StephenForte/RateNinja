'use strict';

const { readJson, sendJson, sendError, securityHeaders } = require('../http');
const { loadActor, isSystemAdmin } = require('../permissions');
const settings = require('../swarm-settings');

function requireSystemAdmin(response, session) {
    const actor = session?.user?.id ? loadActor(session.user.id) : null;
    if (!isSystemAdmin(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return null;
    }
    return actor;
}

function sendFailure(response, error) {
    const payload = { error: error.message };
    if (error.code) payload.code = error.code;
    sendJson(response, error.status, payload, securityHeaders());
}

function list(request, response, session) {
    if (!requireSystemAdmin(response, session)) return;
    sendJson(response, 200, { companies: settings.listCompanies() }, securityHeaders());
}

async function update(request, response, session, params) {
    const actor = requireSystemAdmin(response, session);
    if (!actor) return;
    try {
        const company = settings.updateCompany(actor, params[0], await readJson(request));
        sendJson(response, 200, { company }, securityHeaders());
    } catch (error) {
        if (!(error instanceof settings.SettingsError)) throw error;
        sendFailure(response, error);
    }
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/swarm/companies', access: 'session', handler: list },
        { method: 'PUT', pattern: /^\/api\/admin\/swarm\/companies\/([^/]+)$/, access: 'session', handler: update }
    ]
};
