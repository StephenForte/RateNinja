'use strict';

const { sendJson, sendError, securityHeaders, readJson } = require('../http');
const { listUsersForAdmin, getUserById } = require('../store');
const { clearMfa } = require('../mfa');
const permissions = require('../permissions');
const {
    setPasswordById,
    setEmailById,
    setDisabled,
    markTemporaryPassword,
    setDisplayNameById,
    setCompanyRole,
    createCompanyUser,
    normalizeEmail
} = require('../accounts');

function sendResult(response, result) {
    if (result.code) {
        sendJson(response, result.status, { error: result.error, code: result.code }, securityHeaders());
        return;
    }
    sendError(response, result.status, result.error);
}

function scopeOrReject(response, session, body) {
    const scope = permissions.resolveCompanyContext(session);
    if (!scope.ok) {
        sendResult(response, scope);
        return null;
    }
    if (body && permissions.assignsSystemAdmin(body)) {
        sendError(response, 400, 'System administrator assignment is not available here.');
        return null;
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'role') && body.role === 'system_admin') {
        sendError(response, 400, 'System administrator assignment is not available here.');
        return null;
    }
    if (body) {
        const mismatch = permissions.companyContextMismatch(body, scope.company);
        if (mismatch) {
            sendResult(response, mismatch);
            return null;
        }
    }
    return scope;
}

function listUsers(request, response, session) {
    const scope = scopeOrReject(response, session, null);
    if (!scope) return;
    sendJson(response, 200, { users: listUsersForAdmin(scope.company.id) }, securityHeaders());
}

async function createUser(request, response, session) {
    const body = await readJson(request);
    const scope = scopeOrReject(response, session, body);
    if (!scope) return;
    const result = createCompanyUser(body, session.user.id, scope.company);
    if (!result.ok) {
        sendResult(response, result);
        return;
    }
    sendJson(response, 200, { ok: true, user: result.user }, securityHeaders());
}

async function updateUser(request, response, session, params) {
    const userId = params[0];
    const body = await readJson(request);
    const scope = scopeOrReject(response, session, body);
    if (!scope) return;
    if (Object.prototype.hasOwnProperty.call(body, 'role')) {
        sendError(response, 400, 'Change a role with the role action.');
        return;
    }
    if (!permissions.canManageUser(scope.actor, getUserById(userId), scope)) {
        sendError(response, 404, 'User was not found.');
        return;
    }
    const hasName = Object.prototype.hasOwnProperty.call(body, 'displayName');
    const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email');
    const hasDisabled = typeof body.disabled === 'boolean';
    if (!hasName && !hasEmail && !hasDisabled) {
        sendError(response, 400, 'disabled must be true or false.');
        return;
    }
    if (hasEmail) {
        const parsedEmail = normalizeEmail(body.email);
        if (parsedEmail.error) {
            sendError(response, 400, parsedEmail.error);
            return;
        }
    }
    if (hasName) {
        const nameResult = setDisplayNameById(userId, body.displayName, session.user.id, scope.company.id);
        if (!nameResult.ok) {
            sendResult(response, nameResult);
            return;
        }
    }
    if (hasEmail) {
        const emailResult = setEmailById(userId, body.email, session.user.id, scope.company.id);
        if (!emailResult.ok) {
            sendResult(response, emailResult);
            return;
        }
    }
    if (hasDisabled) {
        const result = setDisabled(userId, body.disabled, session.user.id, scope.company.id);
        if (!result.ok) {
            sendResult(response, result);
            return;
        }
    }
    sendJson(response, 200, { ok: true }, securityHeaders());
}

async function changeRole(request, response, session, params) {
    const userId = params[0];
    const body = await readJson(request);
    const scope = scopeOrReject(response, session, body);
    if (!scope) return;
    const result = setCompanyRole(userId, body.role, session.user.id, scope.company.id);
    if (!result.ok) {
        sendResult(response, result);
        return;
    }
    sendJson(response, 200, { ok: true, role: result.role }, securityHeaders());
}

async function resetPassword(request, response, session, params) {
    const userId = params[0];
    const body = await readJson(request);
    const scope = scopeOrReject(response, session, body);
    if (!scope) return;
    const result = setPasswordById(userId, body.password, session.user.id, scope.company.id);
    if (!result.ok) {
        sendResult(response, result);
        return;
    }
    markTemporaryPassword(userId, session.user.id);
    sendJson(response, 200, { ok: true, signedOut: userId === session.user.id }, securityHeaders());
}

async function clearTwoFactor(request, response, session, params) {
    const userId = params[0];
    const body = await readJson(request);
    const scope = scopeOrReject(response, session, body);
    if (!scope) return;
    if (!permissions.canManageUser(scope.actor, getUserById(userId), scope)) {
        sendError(response, 404, 'User was not found.');
        return;
    }
    const result = clearMfa(userId, session.user.id);
    if (!result.ok) {
        sendResult(response, result);
        return;
    }
    sendJson(response, 200, { ok: true, signedOut: userId === session.user.id }, securityHeaders());
}

module.exports = {
    routes: [
        { method: 'GET', path: '/api/admin/users', access: 'session', handler: listUsers },
        { method: 'POST', path: '/api/admin/users', access: 'session', handler: createUser },
        { method: 'PATCH', pattern: /^\/api\/admin\/users\/([\w-]+)$/, access: 'session', handler: updateUser },
        { method: 'POST', pattern: /^\/api\/admin\/users\/([\w-]+)\/role$/, access: 'session', handler: changeRole },
        { method: 'POST', pattern: /^\/api\/admin\/users\/([\w-]+)\/password$/, access: 'session', handler: resetPassword },
        { method: 'DELETE', pattern: /^\/api\/admin\/users\/([\w-]+)\/two-factor$/, access: 'session', handler: clearTwoFactor }
    ]
};
