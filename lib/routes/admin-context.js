'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { getCompanyByRecordId } = require('../store');
const { setSessionCompanyContext } = require('../session');
const { loadActor, isSystemAdmin, isCompanyAdmin, publicSessionUser } = require('../permissions');

function requireActor(session) {
    return session?.user?.id ? loadActor(session.user.id) : null;
}

function getContext(request, response, session) {
    const actor = requireActor(session);
    if (!isSystemAdmin(actor) && !isCompanyAdmin(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return;
    }
    const view = publicSessionUser(session.user.id, session.companyContextId);
    sendJson(response, 200, { companyContext: view.companyContext }, securityHeaders());
}

async function postContext(request, response, session) {
    const actor = requireActor(session);
    if (!isSystemAdmin(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return;
    }
    const body = await readJson(request);
    const companyId = typeof body.companyId === 'string' ? body.companyId.trim() : '';
    if (!companyId) {
        sendError(response, 400, 'companyId is required.');
        return;
    }
    const company = getCompanyByRecordId(companyId);
    if (!company) {
        sendError(response, 404, 'Company was not found.');
        return;
    }
    if (!setSessionCompanyContext(session.token, company.id)) {
        sendError(response, 401, 'Please sign in to continue.');
        return;
    }
    sendJson(response, 200, {
        companyContext: { id: company.id, name: company.fields?.CompanyName || '' }
    }, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/context', access: 'session', handler: getContext },
        { method: 'POST', path: '/api/admin/context', access: 'session', handler: postContext }
    ]
};
