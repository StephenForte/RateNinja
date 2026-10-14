'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { resolveCompanyContext, canAdministerOwnerData, companyContextMismatch } = require('../permissions');
const { ImportError } = require('../imports/fields');
const { DataOpsError } = require('../data-ops');
const { importMaxBytes } = require('../config');
const jobs = require('../imports/jobs');

function sendFailure(response, error) {
    if (error instanceof ImportError || error instanceof DataOpsError) {
        const payload = { error: error.message, code: error.code };
        if (error.extra) Object.assign(payload, error.extra);
        sendJson(response, error.status, payload, securityHeaders());
        return true;
    }
    return false;
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

async function readCapped(request) {
    const maxBytes = importMaxBytes();
    const declared = request.headers['content-length'];
    if (declared != null && /^\d+$/.test(String(declared)) && Number(declared) > maxBytes) {
        const error = new ImportError(413, 'too_large', `The file is larger than ${maxBytes} bytes.`);
        error.beforeRead = true;
        throw error;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new ImportError(413, 'too_large', `The file is larger than ${maxBytes} bytes.`);
            error.beforeRead = true;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function limits(request, response, session) {
    const scope = authorize(response, session);
    if (!scope) return;
    sendJson(response, 200, {
        ...jobs.limits(),
        company: { id: scope.company.id, name: companyName(scope) }
    }, securityHeaders());
}

async function upload(request, response, session) {
    const scope = authorize(response, session);
    if (!scope) return;
    try {
        const buffer = await readCapped(request);
        const created = await jobs.createUpload({
            companyId: scope.company.id,
            actorUserId: scope.actor.id,
            dataset: request.headers['x-import-dataset'],
            filename: request.headers['x-import-filename'],
            buffer
        });
        sendJson(response, 201, created, securityHeaders());
    } catch (error) {
        const handled = sendFailure(response, error);
        if (error && error.beforeRead) {
            request.on('error', () => {});
            response.on('finish', () => {
                if (!request.destroyed) request.destroy();
            });
        }
        if (!handled) throw error;
    }
}

async function sheet(request, response, session, jobId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        const job = jobs.loadJob(jobId, scope.company.id);
        sendJson(response, 200, await jobs.sheetDetail(job, body.sheetName), securityHeaders());
    } catch (error) {
        if (!sendFailure(response, error)) throw error;
    }
}

async function suggest(request, response, session, jobId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        const job = jobs.loadJob(jobId, scope.company.id);
        sendJson(response, 200, await jobs.suggestMapping(job, body.confirmed), securityHeaders());
    } catch (error) {
        if (!sendFailure(response, error)) throw error;
    }
}

async function validate(request, response, session, jobId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        const job = jobs.loadJob(jobId, scope.company.id);
        const evaluated = await jobs.evaluate(job, body);
        sendJson(response, 200, jobs.validationPayload(evaluated), securityHeaders());
    } catch (error) {
        if (!sendFailure(response, error)) throw error;
    }
}

async function commit(request, response, session, jobId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        const job = jobs.loadJob(jobId, scope.company.id);
        sendJson(response, 200, await jobs.commitImport({
            job,
            companyId: scope.company.id,
            companyName: companyName(scope),
            actorUserId: scope.actor.id,
            body
        }), securityHeaders());
    } catch (error) {
        if (!sendFailure(response, error)) throw error;
    }
}

async function cancel(request, response, session, jobId) {
    const body = await readJson(request);
    const scope = authorize(response, session, body);
    if (!scope) return;
    try {
        const job = jobs.loadJob(jobId, scope.company.id);
        sendJson(response, 200, jobs.cancelImport(job, scope.company.id), securityHeaders());
    } catch (error) {
        if (!sendFailure(response, error)) throw error;
    }
}

jobs.sweepExpired();

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/admin/imports/limits',
            access: 'session',
            handler: limits
        },
        {
            method: 'POST',
            path: '/api/admin/imports/uploads',
            access: 'session',
            body: 'raw',
            handler: upload
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/imports\/([^/]+)\/sheet$/,
            access: 'session',
            handler: (request, response, session, params) => sheet(request, response, session, params[0])
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/imports\/([^/]+)\/suggest$/,
            access: 'session',
            handler: (request, response, session, params) => suggest(request, response, session, params[0])
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/imports\/([^/]+)\/validate$/,
            access: 'session',
            handler: (request, response, session, params) => validate(request, response, session, params[0])
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/imports\/([^/]+)\/commit$/,
            access: 'session',
            handler: (request, response, session, params) => commit(request, response, session, params[0])
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/imports\/([^/]+)\/cancel$/,
            access: 'session',
            handler: (request, response, session, params) => cancel(request, response, session, params[0])
        }
    ]
};
