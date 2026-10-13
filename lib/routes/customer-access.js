'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { listCustomerMarginTargets, upsertCompanyMargin, getCompanyByRecordId } = require('../store');
const { recordAudit } = require('../audit');
const permissions = require('../permissions');
const access = require('../customer-access');

function sendResult(response, result) {
    if (result.code) {
        sendJson(response, result.status, { error: result.error, code: result.code }, securityHeaders());
        return;
    }
    sendError(response, result.status, result.error);
}

function ownerScope(response, session, body) {
    const scope = permissions.resolveCompanyContext(session);
    if (!scope.ok) {
        sendResult(response, scope);
        return null;
    }
    if (body) {
        const mismatch = permissions.companyContextMismatch(body, scope.company);
        if (mismatch) {
            sendResult(response, mismatch);
            return null;
        }
    }
    if (!permissions.canAdministerOwnerData(scope.actor, scope)) {
        sendError(response, 403, 'A contract-owner administrator is required.');
        return null;
    }
    return scope;
}

function listCustomers(request, response, session) {
    const scope = ownerScope(response, session);
    if (!scope) return;
    sendJson(response, 200, access.listCustomers(scope.company.id), securityHeaders());
}

function lookupCustomers(request, response, session, params, url) {
    const scope = ownerScope(response, session);
    if (!scope) return;
    const result = access.lookupCustomers(scope.company.id, url.searchParams.get('q') || '');
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { companies: result.companies }, securityHeaders());
}

async function authorizeCustomer(request, response, session, params) {
    const body = await readJson(request);
    const scope = ownerScope(response, session, body);
    if (!scope) return;
    const result = access.authorizeCustomer(scope.company, params[0], session.user.id, body);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    recordAudit('customer_authorized', {
        actorUserId: session.user.id,
        detail: { customerCompanyId: params[0], ownerCompanyId: scope.company.id }
    });
    sendJson(response, 200, { ok: true, customer: result.customer }, securityHeaders());
}

async function revokeCustomer(request, response, session, params) {
    const body = await readJson(request);
    const scope = ownerScope(response, session, body);
    if (!scope) return;
    const result = access.revokeCustomer(scope.company.id, params[0], session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    recordAudit('customer_revoked', {
        actorUserId: session.user.id,
        detail: { customerCompanyId: params[0], ownerCompanyId: scope.company.id }
    });
    sendJson(response, 200, { ok: true, customer: result.customer }, securityHeaders());
}

async function updateMargins(request, response, session, params) {
    const body = await readJson(request);
    const scope = ownerScope(response, session, body);
    if (!scope) return;
    const result = access.updateMargins(scope.company.id, params[0], session.user.id, body);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    recordAudit('customer_margins_updated', {
        actorUserId: session.user.id,
        detail: { customerCompanyId: params[0], ownerCompanyId: scope.company.id }
    });
    sendJson(response, 200, { ok: true, customer: result.customer }, securityHeaders());
}

async function previewPrices(request, response, session, params) {
    const body = await readJson(request);
    const scope = ownerScope(response, session, body);
    if (!scope) return;
    const result = access.previewPrices(scope.company.id, params[0], body);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, result.preview, securityHeaders());
}

// Moved from server.js. Existing tests still call these URLs. The customers
// screen does not. Saving here still creates a link, which is the old behavior
// those tests assert. New margin edits go through PATCH /api/admin/customers/:id/margins.
function legacyList(request, response, session) {
    const scope = ownerScope(response, session);
    if (!scope) return;
    sendJson(response, 200, { companies: listCustomerMarginTargets(scope.company.id) }, securityHeaders());
}

async function legacyUpdate(request, response, session, params) {
    const body = await readJson(request);
    const scope = ownerScope(response, session, body);
    if (!scope) return;
    const { marginPercent, marginNumber } = body;
    if (![marginPercent, marginNumber].every(value => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
        sendError(response, 400, 'Margins must be non-negative numbers no greater than 1,000,000.');
        return;
    }
    const company = getCompanyByRecordId(params[0]);
    if (!permissions.marginTargetInScope(scope, company)) {
        sendError(response, 404, 'Company was not found in your administration scope.');
        return;
    }
    upsertCompanyMargin(scope.company.id, params[0], { marginPercent, marginNumber });
    recordAudit('margin_updated', { actorUserId: session.user.id, detail: { customerCompanyId: params[0] } });
    sendJson(response, 200, { ok: true }, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/customers', access: 'session', handler: listCustomers },
        {
            method: 'GET',
            path: '/api/admin/customers/lookup',
            access: 'session',
            handler(request, response, session) {
                const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
                return lookupCustomers(request, response, session, [], url);
            }
        },
        { method: 'POST', pattern: /^\/api\/admin\/customers\/([\w-]+)\/authorize$/, access: 'session', handler: authorizeCustomer },
        { method: 'POST', pattern: /^\/api\/admin\/customers\/([\w-]+)\/revoke$/, access: 'session', handler: revokeCustomer },
        { method: 'PATCH', pattern: /^\/api\/admin\/customers\/([\w-]+)\/margins$/, access: 'session', handler: updateMargins },
        { method: 'POST', pattern: /^\/api\/admin\/customers\/([\w-]+)\/preview$/, access: 'session', handler: previewPrices },
        { method: 'GET', path: '/api/admin/companies', access: 'session', handler: legacyList },
        { method: 'PATCH', pattern: /^\/api\/admin\/companies\/([\w-]+)$/, access: 'session', handler: legacyUpdate }
    ]
};
