'use strict';

const { readJson, sendJson, securityHeaders } = require('../http');
const { requireAdminApiAccess } = require('../admin-api-key');
const { BookingError } = require('../booking-requests');
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
            handler: handle(201, async (request, [id]) => ({ booking: agents.bookForAdmin(id, await readJson(request)) }))
        }
    ]
};
