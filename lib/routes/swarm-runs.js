'use strict';

const { sendJson, securityHeaders } = require('../http');
const { loadActor } = require('../permissions');
const { SwarmError } = require('../swarms');
const runs = require('../swarm-runs');

function handle(status, action) {
    return (request, response, session, params) => {
        const actor = loadActor(session.user.id);
        try {
            sendJson(response, status, action(actor, params), securityHeaders());
        } catch (error) {
            if (!(error instanceof SwarmError)) throw error;
            const payload = { error: error.message };
            if (error.code) payload.code = error.code;
            if (error.reasons) payload.reasons = error.reasons;
            sendJson(response, error.status, payload, securityHeaders());
        }
    };
}

module.exports = {
    routes: [
        { method: 'POST', pattern: /^\/api\/swarms\/([^/]+)\/runs$/, access: 'session',
            handler: handle(202, (actor, [id]) => ({ run: runs.start(actor, id) })) },
        { method: 'GET', path: '/api/swarm-runs', access: 'session',
            handler: handle(200, actor => ({ runs: runs.list(actor) })) },
        { method: 'GET', pattern: /^\/api\/swarm-runs\/([^/]+)$/, access: 'session',
            handler: handle(200, (actor, [id]) => ({ run: runs.get(actor, id) })) },
        { method: 'POST', pattern: /^\/api\/swarm-runs\/([^/]+)\/cancel$/, access: 'session',
            handler: handle(202, (actor, [id]) => ({ run: runs.cancel(actor, id) })) }
    ]
};
