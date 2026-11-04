'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { loadActor } = require('../permissions');
const bookings = require('../booking-requests');

function send(response, status, payload) {
    sendJson(response, status, payload, securityHeaders());
}

async function guard(response, work) {
    try {
        await work();
    } catch (error) {
        if (error instanceof bookings.BookingError) {
            sendError(response, error.status, error.message);
            return;
        }
        throw error;
    }
}

function actorFrom(session) {
    return loadActor(session?.user?.id);
}

function list(request, response, session) {
    return guard(response, async () => {
        send(response, 200, { requests: bookings.listRequests(actorFrom(session)) });
    });
}

function unread(request, response, session) {
    return guard(response, async () => {
        send(response, 200, { unread: bookings.unreadCount(actorFrom(session)) });
    });
}

function create(request, response, session) {
    return guard(response, async () => {
        const body = await readJson(request);
        send(response, 201, { request: bookings.createRequest(actorFrom(session), body) });
    });
}

function markAll(request, response, session) {
    return guard(response, async () => {
        send(response, 200, bookings.markSideRead(actorFrom(session)));
    });
}

function readOne(request, response, session, params) {
    return guard(response, async () => {
        send(response, 200, { request: bookings.getRequest(actorFrom(session), params[0]) });
    });
}

function markOne(request, response, session, params) {
    return guard(response, async () => {
        send(response, 200, { request: bookings.markRead(actorFrom(session), params[0]) });
    });
}

function decide(request, response, session, params) {
    return guard(response, async () => {
        const body = await readJson(request);
        const decision = body && typeof body === 'object' ? body.decision : undefined;
        send(response, 200, { request: bookings.decideRequest(actorFrom(session), params[0], decision) });
    });
}

const id = '([^/]+)';

module.exports = {
    routes: [
        { method: 'GET', path: '/api/booking-requests', access: 'session', handler: list },
        { method: 'GET', path: '/api/booking-requests/unread', access: 'session', handler: unread },
        { method: 'POST', path: '/api/booking-requests', access: 'session', handler: create },
        { method: 'POST', path: '/api/booking-requests/read', access: 'session', handler: markAll },
        { method: 'GET', pattern: new RegExp(`^/api/booking-requests/${id}$`), access: 'session', handler: readOne },
        { method: 'POST', pattern: new RegExp(`^/api/booking-requests/${id}/read$`), access: 'session', handler: markOne },
        { method: 'POST', pattern: new RegExp(`^/api/booking-requests/${id}/decision$`), access: 'session', handler: decide }
    ]
};
