'use strict';

const { sendJson, securityHeaders, readBody } = require('../http');
const { recordAudit } = require('../audit');
const { requirePartnerAccess, pageArgs, sendOAuthError } = require('../partner-http');
const { loadActor } = require('../permissions');
const { ALLOCATION_NOTICE } = require('../visibility');
const bookings = require('../booking-requests');

function sendData(response, data, meta) {
    sendJson(response, 200, { data, meta }, securityHeaders());
}

function sendFailure(response, error) {
    const failure = bookings.partnerBookingFailure(error);
    if (!failure) throw error;
    sendOAuthError(response, failure.status, failure.body.error, failure.body.error_description);
}

function oneMeta() {
    return { notice: ALLOCATION_NOTICE };
}

function listMeta(total, page, pageSize, returned) {
    return { total, page, pageSize, returned, notice: ALLOCATION_NOTICE };
}

function paging(source) {
    const read = name => {
        if (typeof source.get === 'function') return source.get(name) || '';
        const value = source[name];
        return value == null ? '' : value;
    };
    const params = new URLSearchParams();
    const page = read('page');
    const pageSize = read('pageSize');
    if (page !== '') params.set('page', String(page));
    if (pageSize !== '') params.set('pageSize', String(pageSize));
    return pageArgs(params);
}

function auditRead(access, count) {
    recordAudit('partner_booking_requests_read', {
        actorUserId: access.sub,
        clientId: access.clientId,
        detail: { count }
    });
}

async function readObjectBody(request) {
    let text;
    try {
        text = await readBody(request);
    } catch (error) {
        const message = error.message === 'Request body is too large.'
            ? 'Request body is too large.'
            : 'Request body must be valid JSON.';
        return { error: message };
    }
    if (!text) return { body: {} };
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return { error: 'Request body must be valid JSON.' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be an object.' };
    }
    return { body };
}

function list(request, response) {
    const access = requirePartnerAccess(request, response, 'bookings:read');
    if (!access) return;
    const url = new URL(request.url, 'http://localhost');
    const query = paging(url.searchParams);
    if (query.error) return sendOAuthError(response, 400, 'invalid_request', query.error);
    const status = url.searchParams.has('status') ? url.searchParams.get('status') : undefined;
    try {
        const page = bookings.listOwnerRequests(loadActor(access.sub), {
            status,
            page: query.page,
            pageSize: query.pageSize
        });
        auditRead(access, page.requests.length);
        sendData(response, page.requests, listMeta(page.total, query.page, query.pageSize, page.requests.length));
    } catch (error) {
        sendFailure(response, error);
    }
}

function readOne(request, response, session, params) {
    const access = requirePartnerAccess(request, response, 'bookings:read');
    if (!access) return;
    try {
        const data = bookings.getOwnerRequest(loadActor(access.sub), params[0]);
        auditRead(access, 1);
        sendData(response, data, oneMeta());
    } catch (error) {
        sendFailure(response, error);
    }
}

async function decide(request, response, session, params) {
    const access = requirePartnerAccess(request, response, 'bookings:write');
    if (!access) return;
    const parsed = await readObjectBody(request);
    if (parsed.error) return sendOAuthError(response, 400, 'invalid_request', parsed.error);
    try {
        const data = bookings.decideRequest(loadActor(access.sub), params[0], parsed.body.decision, {
            clientId: access.clientId,
            channel: 'api'
        });
        sendData(response, data, oneMeta());
    } catch (error) {
        sendFailure(response, error);
    }
}

const id = '([^/]+)';

module.exports = {
    routes: [
        { method: 'GET', path: '/api/partner/v1/me/booking-requests', access: 'public', handler: list },
        { method: 'GET', pattern: new RegExp(`^/api/partner/v1/me/booking-requests/${id}$`), access: 'public', handler: readOne },
        { method: 'POST', pattern: new RegExp(`^/api/partner/v1/me/booking-requests/${id}/decision$`), access: 'public', handler: decide }
    ]
};
