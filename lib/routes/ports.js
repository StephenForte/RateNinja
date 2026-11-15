'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { loadActor, isSystemAdmin } = require('../permissions');
const ports = require('../ports');

function requireSystemAdmin(response, session) {
    const actor = session?.user?.id ? loadActor(session.user.id) : null;
    if (!isSystemAdmin(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return null;
    }
    return actor;
}

function list(request, response, session) {
    if (!requireSystemAdmin(response, session)) return;
    sendJson(response, 200, {
        ports: ports.listPorts(),
        unmatched: ports.listUnmatchedStoredPorts()
    }, securityHeaders());
}

async function create(request, response, session) {
    const actor = requireSystemAdmin(response, session);
    if (!actor) return;
    const body = await readJson(request);
    const result = ports.createPort({
        code: body && body.code,
        name: body && body.name
    }, actor.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 201, { port: result.port }, securityHeaders());
}

async function update(request, response, session, params) {
    const actor = requireSystemAdmin(response, session);
    if (!actor) return;
    const body = await readJson(request);
    const patch = {};
    if (body && Object.prototype.hasOwnProperty.call(body, 'code')) patch.code = body.code;
    if (body && Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = body.name;
    const result = ports.updatePort(params[0], patch, actor.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { port: result.port }, securityHeaders());
}

async function remove(request, response, session, params) {
    const actor = requireSystemAdmin(response, session);
    if (!actor) return;
    await readJson(request);
    const result = ports.deletePort(params[0], actor.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true }, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/ports', access: 'session', handler: list },
        { method: 'POST', path: '/api/admin/ports', access: 'session', handler: create },
        { method: 'PATCH', pattern: /^\/api\/admin\/ports\/([^/]+)$/, access: 'session', handler: update },
        { method: 'DELETE', pattern: /^\/api\/admin\/ports\/([^/]+)$/, access: 'session', handler: remove }
    ]
};
