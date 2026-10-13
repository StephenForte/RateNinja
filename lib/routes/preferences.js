'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const preferences = require('../preferences');

function send(response, status, payload) {
    sendJson(response, status, payload, securityHeaders());
}

async function guard(response, work) {
    try {
        await work();
    } catch (error) {
        if (error instanceof preferences.PreferenceError) {
            sendError(response, error.status, error.message);
            return;
        }
        throw error;
    }
}

function userId(session) {
    return session?.user?.id || '';
}

function fields(request, response) {
    send(response, 200, preferences.catalog());
}

function listQueries(request, response, session) {
    return guard(response, async () => {
        send(response, 200, { queries: preferences.listQueries(userId(session)) });
    });
}

function createQuery(request, response, session) {
    return guard(response, async () => {
        const body = await readJson(request);
        send(response, 201, { query: preferences.createQuery(userId(session), body) });
    });
}

function readQuery(request, response, session, params) {
    return guard(response, async () => {
        send(response, 200, { query: preferences.getQuery(userId(session), params[0]) });
    });
}

function patchQuery(request, response, session, params) {
    return guard(response, async () => {
        const body = await readJson(request);
        send(response, 200, { query: preferences.updateQuery(userId(session), params[0], body) });
    });
}

function removeQuery(request, response, session, params) {
    return guard(response, async () => {
        preferences.deleteQuery(userId(session), params[0]);
        send(response, 204);
    });
}

function listViews(request, response, session) {
    return guard(response, async () => {
        send(response, 200, { views: preferences.listViews(userId(session)) });
    });
}

function createView(request, response, session) {
    return guard(response, async () => {
        const body = await readJson(request);
        send(response, 201, { view: preferences.createView(userId(session), body) });
    });
}

function readView(request, response, session, params) {
    return guard(response, async () => {
        send(response, 200, { view: preferences.getView(userId(session), params[0]) });
    });
}

function patchView(request, response, session, params) {
    return guard(response, async () => {
        const body = await readJson(request);
        send(response, 200, { view: preferences.updateView(userId(session), params[0], body) });
    });
}

function removeView(request, response, session, params) {
    return guard(response, async () => {
        preferences.deleteView(userId(session), params[0]);
        send(response, 204);
    });
}

function putDefault(request, response, session) {
    return guard(response, async () => {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'id')) {
            sendError(response, 400, 'id must be a saved view id or null.');
            return;
        }
        const view = preferences.setDefaultView(userId(session), body.id);
        send(response, 200, { view });
    });
}

const id = '([^/]+)';

module.exports = {
    routes: [
        { method: 'GET', path: '/api/preferences/fields', access: 'session', handler: fields },
        { method: 'GET', path: '/api/preferences/queries', access: 'session', handler: listQueries },
        { method: 'POST', path: '/api/preferences/queries', access: 'session', handler: createQuery },
        { method: 'GET', pattern: new RegExp(`^/api/preferences/queries/${id}$`), access: 'session', handler: readQuery },
        { method: 'PATCH', pattern: new RegExp(`^/api/preferences/queries/${id}$`), access: 'session', handler: patchQuery },
        { method: 'DELETE', pattern: new RegExp(`^/api/preferences/queries/${id}$`), access: 'session', handler: removeQuery },
        { method: 'GET', path: '/api/preferences/views', access: 'session', handler: listViews },
        { method: 'POST', path: '/api/preferences/views', access: 'session', handler: createView },
        { method: 'GET', pattern: new RegExp(`^/api/preferences/views/${id}$`), access: 'session', handler: readView },
        { method: 'PATCH', pattern: new RegExp(`^/api/preferences/views/${id}$`), access: 'session', handler: patchView },
        { method: 'DELETE', pattern: new RegExp(`^/api/preferences/views/${id}$`), access: 'session', handler: removeView },
        { method: 'PUT', path: '/api/preferences/default-view', access: 'session', handler: putDefault }
    ]
};
