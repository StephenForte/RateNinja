'use strict';

const { sendJson, sendError, securityHeaders } = require('../http');
const { loadReadActor, listCompanies, listRuns, getRun } = require('../swarm-run-admin');
const { SwarmError } = require('../swarms');

function read(action) {
    return (request, response, session, params) => {
        try {
            const result = action(loadReadActor(session.user.id), request, params);
            sendJson(response, 200, result, securityHeaders());
        } catch (error) {
            if (!(error instanceof SwarmError)) throw error;
            sendError(response, error.status, error.message);
        }
    };
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/swarm-runs/companies', access: 'session',
            handler: read(actor => ({ companies: listCompanies(actor) })) },
        { method: 'GET', path: '/api/admin/swarm-runs', access: 'session',
            handler: read((actor, request) => {
                const url = new URL(request.url, 'http://localhost');
                return { runs: listRuns(actor, url.searchParams.get('companyId')) };
            }) },
        { method: 'GET', pattern: /^\/api\/admin\/swarm-runs\/([^/]+)$/, access: 'session',
            handler: read((actor, request, [id]) => ({ run: getRun(actor, id) })) }
    ]
};
