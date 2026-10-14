'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const permissions = require('../permissions');
const { nameCheck, onboardCompany } = require('../onboarding');

function requireOnboardingAdmin(response, session) {
    const actor = permissions.loadActor(session.user.id);
    if (!permissions.canOnboardCompanies(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return null;
    }
    return actor;
}

function nameCheckRoute(request, response, session) {
    const actor = requireOnboardingAdmin(response, session);
    if (!actor) return;
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const result = nameCheck(url.searchParams.get('q') || '');
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, {
        q: result.q,
        match: result.match,
        warning: result.warning
    }, securityHeaders());
}

async function createCompany(request, response, session) {
    const actor = requireOnboardingAdmin(response, session);
    if (!actor) return;
    const body = await readJson(request);
    if (permissions.assignsSystemAdmin(body)) {
        sendError(response, 400, 'System administrator assignment is not available here.');
        return;
    }
    const result = onboardCompany(body, actor.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, result.result, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/onboarding/name-check', access: 'session', handler: nameCheckRoute },
        { method: 'POST', path: '/api/admin/onboarding', access: 'session', handler: createCompany }
    ]
};
