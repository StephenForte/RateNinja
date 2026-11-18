'use strict';

const { readJson, sendJson, securityHeaders } = require('../http');
const { loadActor } = require('../permissions');
const agents = require('../managed-agents');

function handle(status, action) {
    return async (request, response, session, params) => {
        try {
            const actor = loadActor(session.user.id);
            const result = await action(actor, request, params);
            sendJson(response, status, result, securityHeaders());
        } catch (error) {
            if (!(error instanceof agents.ManagedAgentError)) throw error;
            sendJson(response, error.status, { error: error.message }, securityHeaders());
        }
    };
}

const byId = /^\/api\/managed-agents\/([^/]+)$/;

module.exports = {
    routes: [
        { method: 'GET', path: '/api/managed-agents/options', access: 'session', handler: handle(200, agents.getOptions) },
        { method: 'GET', path: '/api/managed-agents', access: 'session', handler: handle(200, actor => ({ agents: agents.list(actor) })) },
        { method: 'POST', path: '/api/managed-agents', access: 'session', handler: handle(201, async (actor, request) =>
            ({ agents: agents.create(actor, await readJson(request)) })) },
        { method: 'PUT', pattern: byId, access: 'session', handler: handle(200, async (actor, request, [id]) =>
            ({ agent: agents.update(actor, id, await readJson(request)) })) },
        { method: 'DELETE', pattern: byId, access: 'session', handler: handle(204, (actor, request, [id]) => agents.remove(actor, id)) }
    ]
};
