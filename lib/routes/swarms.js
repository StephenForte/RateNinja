'use strict';

const { readJson, sendJson, securityHeaders } = require('../http');
const { loadActor } = require('../permissions');
const swarms = require('../swarms');

function sendFailure(response, error) {
    const payload = { error: error.message };
    if (error.code) payload.code = error.code;
    if (Number.isInteger(error.position)) payload.position = error.position;
    sendJson(response, error.status, payload, securityHeaders());
}

function handle(status, action) {
    return async (request, response, session, params) => {
        try {
            const actor = loadActor(session.user.id);
            const result = await action(actor, request, params);
            sendJson(response, status, result, securityHeaders());
        } catch (error) {
            if (!(error instanceof swarms.SwarmError)) throw error;
            sendFailure(response, error);
        }
    };
}

const byId = /^\/api\/swarms\/([^/]+)$/;

module.exports = {
    routes: [
        { method: 'GET', path: '/api/swarm/access', access: 'session', handler: handle(200, actor => swarms.access(actor)) },
        { method: 'GET', path: '/api/swarms', access: 'session', handler: handle(200, actor => ({ swarms: swarms.list(actor) })) },
        { method: 'POST', path: '/api/swarms', access: 'session', handler: handle(201, async (actor, request) => ({ swarm: swarms.create(actor, await readJson(request)) })) },
        { method: 'GET', pattern: byId, access: 'session', handler: handle(200, (actor, request, [id]) => ({ swarm: swarms.get(actor, id) })) },
        { method: 'PUT', pattern: byId, access: 'session', handler: handle(200, async (actor, request, [id]) => ({ swarm: swarms.update(actor, id, await readJson(request)) })) },
        { method: 'DELETE', pattern: byId, access: 'session', handler: handle(204, (actor, request, [id]) => { swarms.remove(actor, id); }) }
    ]
};
