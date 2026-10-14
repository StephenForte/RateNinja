'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { resolveCompanyContext, canAdministerOwnerData, companyContextMismatch } = require('../permissions');
const dataOps = require('../data-ops');
const pullForward = require('../pull-forward');

function sendFailure(response, error) {
    if (error instanceof dataOps.DataOpsError) {
        const payload = { error: error.message, code: error.code };
        if (error.extra) Object.assign(payload, error.extra);
        sendJson(response, error.status, payload, securityHeaders());
        return;
    }
    throw error;
}

function sendScopeFailure(response, result) {
    if (result.code) {
        sendJson(response, result.status, { error: result.error, code: result.code }, securityHeaders());
        return;
    }
    sendError(response, result.status, result.error);
}

function authorize(response, session, body) {
    const scope = resolveCompanyContext(session);
    if (!scope.ok) {
        sendScopeFailure(response, scope);
        return null;
    }
    if (!canAdministerOwnerData(scope.actor, scope)) {
        sendError(response, 403, 'A contract-owner administrator is required.');
        return null;
    }
    if (body) {
        const mismatch = companyContextMismatch(body, scope.company);
        if (mismatch) {
            sendScopeFailure(response, mismatch);
            return null;
        }
    }
    return scope;
}

function companyName(scope) {
    return scope.company.fields?.CompanyName || '';
}

function filterFromUrl(dataset, url) {
    const keys = dataset === 'rates'
        ? ['origin', 'destination', 'carrier', 'effectiveFrom', 'effectiveTo']
        : ['departurePort', 'carrier', 'departureFrom', 'departureTo'];
    const filter = {};
    for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value) filter[key] = value;
    }
    return filter;
}

async function search(dataset, request, response, session) {
    const url = new URL(request.url, 'http://localhost');
    const companyId = url.searchParams.get('companyId');
    const scope = authorize(response, session, companyId ? { companyId } : null);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.searchRecords({
            dataset,
            companyId: scope.company.id,
            companyName: companyName(scope),
            filter: filterFromUrl(dataset, url),
            page: url.searchParams.get('page'),
            pageSize: url.searchParams.get('pageSize')
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function edit(dataset, request, response, session, recordId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.editRecord({
            dataset,
            recordId,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id,
            body
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function preview(request, response, session) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.previewDelete({
            dataset: body.dataset,
            companyId: scope.company.id,
            companyName: companyName(scope),
            selection: body.selection
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function commit(request, response, session) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.commitDelete({
            previewId: body.previewId,
            submissionId: body.submissionId,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function history(request, response, session) {
    const url = new URL(request.url, 'http://localhost');
    const companyId = url.searchParams.get('companyId');
    const scope = authorize(response, session, companyId ? { companyId } : null);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.listHistory({
            companyId: scope.company.id,
            companyName: companyName(scope),
            page: url.searchParams.get('page'),
            pageSize: url.searchParams.get('pageSize')
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function previewPullForward(request, response, session) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, pullForward.previewPullForward({
            dataset: body.dataset,
            companyId: scope.company.id,
            companyName: companyName(scope),
            body
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function commitPullForward(request, response, session) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, pullForward.commitPullForward({
            previewId: body.previewId,
            submissionId: body.submissionId,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function undo(request, response, session, operationId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.undoOperation({
            operationId,
            submissionId: body.submissionId,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function restore(request, response, session, operationId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        sendJson(response, 200, dataOps.restoreOperation({
            operationId,
            submissionId: body.submissionId,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id
        }), securityHeaders());
    } catch (error) {
        sendFailure(response, error);
    }
}

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/admin/data/rates',
            access: 'session',
            handler: (request, response, session) => search('rates', request, response, session)
        },
        {
            method: 'GET',
            path: '/api/admin/data/sailings',
            access: 'session',
            handler: (request, response, session) => search('sailings', request, response, session)
        },
        {
            method: 'PATCH',
            pattern: /^\/api\/admin\/data\/rates\/([^/]+)$/,
            access: 'session',
            handler: (request, response, session, params) => edit('rates', request, response, session, params[0])
        },
        {
            method: 'PATCH',
            pattern: /^\/api\/admin\/data\/sailings\/([^/]+)$/,
            access: 'session',
            handler: (request, response, session, params) => edit('sailings', request, response, session, params[0])
        },
        {
            method: 'POST',
            path: '/api/admin/data/delete/preview',
            access: 'session',
            handler: preview
        },
        {
            method: 'POST',
            path: '/api/admin/data/delete',
            access: 'session',
            handler: commit
        },
        {
            method: 'GET',
            path: '/api/admin/data/operations',
            access: 'session',
            handler: history
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/data\/operations\/([^/]+)\/restore$/,
            access: 'session',
            handler: (request, response, session, params) => restore(request, response, session, params[0])
        },
        {
            method: 'POST',
            path: '/api/admin/data/pull-forward/preview',
            access: 'session',
            handler: previewPullForward
        },
        {
            method: 'POST',
            path: '/api/admin/data/pull-forward',
            access: 'session',
            handler: commitPullForward
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/data\/operations\/([^/]+)\/undo$/,
            access: 'session',
            handler: (request, response, session, params) => undo(request, response, session, params[0])
        }
    ]
};
