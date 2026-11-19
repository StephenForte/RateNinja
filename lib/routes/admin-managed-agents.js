'use strict';

const { readJson, sendJson, securityHeaders } = require('../http');
const { requireAdminApiAccess } = require('../admin-api-key');
const { BookingError } = require('../booking-requests');
const { bookingCodeFailure } = require('../booking-code');
const { recordAudit, EVENT_ADMIN_MANAGED_AGENTS_READ } = require('../audit');
const agents = require('../managed-agents');

function handle(status, action) {
    return async (request, response, session, params) => {
        if (!requireAdminApiAccess(request, response)) return;
        try {
            sendJson(response, status, await action(request, params), securityHeaders());
        } catch (error) {
            if (error instanceof agents.ManagedAgentError) {
                sendJson(response, error.status, { error: error.message }, securityHeaders());
            } else if (error instanceof BookingError) {
                sendJson(response, error.status, { error: 'invalid_request', error_description: error.message }, securityHeaders());
            } else {
                throw error;
            }
        }
    };
}

function query(request) {
    return new URL(request.url, 'http://localhost').searchParams;
}

function list(request) {
    const status = query(request).get('status') ?? 'queued';
    const rows = agents.listForAdmin(status);
    recordAudit(EVENT_ADMIN_MANAGED_AGENTS_READ, { detail: { status, count: rows.length } });
    return { agents: rows };
}

function customers() {
    const rows = agents.listCustomerUsers();
    recordAudit(EVENT_ADMIN_MANAGED_AGENTS_READ, { detail: { customers: rows.length } });
    return { customers: rows };
}

function sampleSeed(value) {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string') throw new agents.ManagedAgentError(400, 'seed must be a string.');
    return value;
}

function samplePreview(request) {
    const params = query(request);
    const userId = params.get('userId');
    if (!userId || !userId.trim()) throw new agents.ManagedAgentError(400, 'userId is required.');
    const preview = agents.previewSampleAgents(userId, { seed: sampleSeed(params.get('seed')) });
    recordAudit(EVENT_ADMIN_MANAGED_AGENTS_READ, { detail: { userId: preview.userId, samplePreview: true } });
    return preview;
}

function matches(request, [id]) {
    const payload = agents.matchesForAdmin(id, query(request).get('destinationPort')?.trim() ?? null);
    recordAudit(EVENT_ADMIN_MANAGED_AGENTS_READ, { detail: { agentId: id, count: payload.matches.length } });
    return payload;
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/v1/managed-agents', access: 'public', handler: handle(200, list) },
        { method: 'GET', pattern: /^\/api\/admin\/v1\/managed-agents\/([^/]+)\/matches$/, access: 'public', handler: handle(200, matches) },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/v1\/managed-agents\/([^/]+)\/booking-requests$/,
            access: 'public',
            handler: handle(201, async (request, [id]) => {
                const body = await readJson(request);
                const failure = await bookingCodeFailure(body?.bookingCode);
                if (failure) throw new agents.ManagedAgentError(failure.status, failure.error);
                return { booking: agents.bookForAdmin(id, body) };
            })
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/v1\/managed-agents\/([^/]+)\/start$/,
            access: 'public',
            handler: handle(200, (request, [id]) => ({ agent: agents.startForAdmin(id) }))
        },
        {
            method: 'POST',
            pattern: /^\/api\/admin\/v1\/managed-agents\/([^/]+)\/finish$/,
            access: 'public',
            handler: handle(200, async (request, [id]) => ({ agent: agents.finishForAdmin(id, await readJson(request)) }))
        },
        { method: 'GET', path: '/api/admin/v1/managed-agents/customers', access: 'public', handler: handle(200, customers) },
        { method: 'GET', path: '/api/admin/v1/managed-agents/samples', access: 'public', handler: handle(200, samplePreview) },
        {
            method: 'POST',
            path: '/api/admin/v1/managed-agents/samples',
            access: 'public',
            handler: handle(201, async request => {
                const body = await readJson(request);
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    throw new agents.ManagedAgentError(400, 'invalid_request');
                }
                const userId = typeof body.userId === 'string' ? body.userId : '';
                if (!userId.trim()) throw new agents.ManagedAgentError(400, 'userId is required.');
                return agents.createSampleAgents(userId, { seed: sampleSeed(body.seed) });
            })
        }
    ]
};
