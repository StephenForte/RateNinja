'use strict';

const { isActiveBuyer, listBuyerApiKeys, createBuyerApiKey, revokeBuyerApiKey } = require('../buyer-api-key');
const { db } = require('../db');
const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { sessionCookie } = require('../session');
const { changeOwnPassword } = require('../accounts');
const { publicSessionUser } = require('../permissions');

function clientIp(request) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    return request.socket?.remoteAddress || 'unknown';
}

function roleLabel(permissions) {
    const parts = [];
    if (permissions?.systemAdmin) parts.push('System administrator');
    if (permissions?.companyAdmin) parts.push('Company administrator');
    if (parts.length === 0) parts.push('Member');
    return parts.join(', ');
}

function companyLine(companyName, companyType) {
    if (!companyName) return '';
    return companyType ? `${companyName} (${companyType})` : companyName;
}

function getAccount(request, response, session) {
    const view = publicSessionUser(session.user.id, session.companyContextId);
    const row = db.prepare('SELECT email FROM users WHERE id = ?').get(session.user.id);
    sendJson(response, 200, {
        displayName: view.username,
        loginName: view.loginName,
        email: row?.email || '',
        company: companyLine(view.companyName, view.companyType),
        companyName: view.companyName,
        companyType: view.companyType,
        role: roleLabel(view.permissions)
    }, securityHeaders());
}

async function postPassword(request, response, session) {
    const body = await readJson(request);
    const result = changeOwnPassword(session.user.id, body, {
        username: session.user.loginName || '',
        source: clientIp(request)
    });
    if (!result.ok) {
        if (result.field) {
            sendJson(response, result.status, { error: result.error, field: result.field }, securityHeaders());
            return;
        }
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true, signInAgain: true }, {
        'Set-Cookie': sessionCookie('', 0),
        ...securityHeaders()
    });
}

async function apiKeys(request, response, session, params) {
    const userId = session.user.id;
    if (!isActiveBuyer(userId)) {
        sendJson(response, 403, { error: 'buyer_access_denied' }, securityHeaders());
        return;
    }
    if (request.method === 'GET') {
        sendJson(response, 200, { keys: listBuyerApiKeys(userId) }, securityHeaders());
        return;
    }
    const result = request.method === 'POST'
        ? createBuyerApiKey(userId, (await readJson(request))?.label)
        : revokeBuyerApiKey(userId, params[0]);
    const { status, ...body } = result;
    sendJson(response, status, body, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/account/api-keys', access: 'session', handler: apiKeys },
        { method: 'POST', path: '/api/account/api-keys', access: 'session', handler: apiKeys },
        { method: 'DELETE', pattern: /^\/api\/account\/api-keys\/([A-Za-z0-9-]+)$/, access: 'session', handler: apiKeys },
        { method: 'GET', path: '/api/account', access: 'session', handler: getAccount },
        { method: 'POST', path: '/api/account/password', access: 'session-unrestricted', handler: postPassword }
    ]
};
