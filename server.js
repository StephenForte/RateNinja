const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const {
    PORT,
    HOST,
    ROOT,
    PUBLIC_API_RATE_LIMIT,
    PUBLIC_API_WINDOW_MS,
    config,
    partnerOauthEnabled,
    oauthSigningKey
} = require('./lib/config');
const { COMPANY_TYPE_CONTRACT_OWNER } = require('./lib/constants');
const { db } = require('./lib/db');
const {
    getRatesByCarrierOrigin,
    getCompanyByRecordId,
    companyForUser,
    getSailings,
    queryPublicRates,
    pullForwardRates,
    pullForwardSailings,
    getUserCredentials,
    getUserById,
    listCustomerMarginTargets,
    upsertCompanyMargin,
    listUsersForAdmin
} = require('./lib/store');
const {
    parsePageNumber,
    validatePullForwardRange,
    mapRateRecord
} = require('./lib/domain');
const {
    getSession,
    createSession,
    destroySession,
    sessionCookie,
    startSessionSweep
} = require('./lib/session');
const { verifyPasswordOrDummy } = require('./lib/passwords');
const {
    isLimited,
    recordFailure,
    clearFailures,
    mfaLimited,
    recordMfaFailure,
    clearMfaFailures,
    clearMfaUserFailures
} = require('./lib/throttle');
const { recordAudit } = require('./lib/audit');
const {
    sendJson,
    sendError,
    securityHeaders,
    readBody,
    readJson,
    formBody,
    requireCsrf
} = require('./lib/http');
const routeModules = require('./lib/routes');
const { setPasswordById, setEmailById, setDisabled } = require('./lib/accounts');
const permissions = require('./lib/permissions');
const { requestPasswordReset, completePasswordReset } = require('./lib/password-reset');
const { resendSettings } = require('./lib/resend');
const {
    mfaStatus,
    startEnrollment,
    confirmEnrollment,
    verifySecondFactor,
    disableOwnMfa,
    clearMfa,
    hasOpenLoginChallenge,
    createLoginChallenge,
    readLoginChallenge,
    consumeLoginChallenge
} = require('./lib/mfa');
const { ensureFoundation } = require('./lib/foundation');
const { appRates, appPredictiveRates, appSailings, listPartnerRates, getPartnerRate, listPartnerSailings, getPartnerSailing } = require('./lib/visibility');
const oauth = require('./lib/oauth');
const { handleMcp, SUPPORTED_PROTOCOL_VERSIONS } = require('./lib/mcp');
const { predictiveWindow, demoPredictiveData } = require('./lib/predictive');
const { bearerToken, requirePartnerAccess, pageArgs, consumePartnerRequest } = require('./lib/partner-http');

let publicApiWindow = { startedAt: Date.now(), requests: 0 };

const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function sendOAuthError(response, status, error, description, headers = {}) {
    sendJson(response, status, { error, error_description: description }, headers);
}

function sendHtml(response, status, html, headers = {}) {
    response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...securityHeaders(),
        ...headers
    });
    response.end(html);
}

function redirectTo(response, location) {
    response.writeHead(302, {
        Location: location,
        'Cache-Control': 'no-store',
        ...securityHeaders()
    });
    response.end();
}

function externalOrigin(request) {
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = forwarded ? String(forwarded).split(',')[0].trim() : 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
}

function clientIp(request) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    return request.socket?.remoteAddress || 'unknown';
}

function sourceFingerprint(ip) {
    return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 12);
}

function requireConfiguration(response) {
    if (config.sessionSecret) return true;
    sendError(response, 500, 'Server configuration is incomplete. Set SESSION_SECRET.');
    return false;
}

function presentSession(record) {
    const company = companyForUser(record);
    const companyType = company?.fields?.CompanyType || '';
    return {
        id: record.id,
        username: record.displayName || record.username,
        loginName: record.username,
        rateView: record.rateView,
        companyId: company?.fields?.CompanyID || record.companyId || '',
        companyRecordId: company?.id || '',
        companyName: company?.fields?.CompanyName || '',
        companyType,
        isAdmin: permissions.isCompanyAdmin(permissions.loadActor(record.id)),
        isContractOwner: companyType === COMPANY_TYPE_CONTRACT_OWNER,
        sessionEpoch: record.sessionEpoch,
        csrfToken: crypto.randomBytes(32).toString('base64url')
    };
}

function publicUser(userId, companyContextId = null) {
    return permissions.publicSessionUser(userId, companyContextId);
}

function sendPermissionResult(response, result) {
    if (result.code) {
        sendJson(response, result.status, { error: result.error, code: result.code }, securityHeaders());
        return;
    }
    sendError(response, result.status, result.error);
}

function rejectCompanyMismatch(response, body, company) {
    const mismatch = permissions.companyContextMismatch(body, company);
    if (!mismatch) return false;
    sendPermissionResult(response, mismatch);
    return true;
}

function liveSession(request) {
    const session = getSession(request);
    if (!session?.user?.id) return null;
    const user = getUserById(session.user.id);
    if (!user || user.disabled || user.sessionEpoch !== session.user.sessionEpoch) {
        destroySession(session.token);
        return null;
    }
    return session;
}

function requireSession(request, response) {
    const session = liveSession(request);
    if (!session) {
        sendError(response, 401, 'Please sign in to continue.');
        return null;
    }
    return session;
}

function requireAdmin(response, session) {
    const result = permissions.resolveCompanyContext(session);
    if (!result.ok) {
        sendPermissionResult(response, result);
        return null;
    }
    return result;
}

function requireContractAdmin(response, session) {
    const result = requireAdmin(response, session);
    if (!result) return null;
    if (!permissions.canAdministerOwnerData(result.actor, result)) {
        sendError(response, 403, 'A contract-owner administrator is required.');
        return null;
    }
    return result;
}

function requireSystemAdmin(response, session) {
    const actor = permissions.loadActor(session.user.id);
    if (!permissions.isSystemAdmin(actor)) {
        sendError(response, 403, 'Administrator access is required.');
        return null;
    }
    return actor;
}

function publicApiKeyIsValid(request) {
    const suppliedKey = request.headers['x-api-key'];
    if (typeof suppliedKey !== 'string' || !config.publicApiKey) return false;
    const supplied = Buffer.from(suppliedKey);
    const expected = Buffer.from(config.publicApiKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function consumePublicApiRequest(response) {
    const now = Date.now();
    if (now - publicApiWindow.startedAt >= PUBLIC_API_WINDOW_MS) {
        publicApiWindow = { startedAt: now, requests: 0 };
    }
    if (publicApiWindow.requests >= PUBLIC_API_RATE_LIMIT) {
        sendError(response, 429, 'Demo API rate limit exceeded. Try again in a minute.');
        return false;
    }
    publicApiWindow.requests += 1;
    return true;
}

function requirePublicApiAccess(request, response) {
    if (!config.publicApiKey) {
        sendError(response, 500, 'Public API configuration is incomplete. Set RATE_NINJA_API_KEY.');
        return false;
    }
    if (!publicApiKeyIsValid(request)) {
        sendError(response, 401, 'A valid X-API-Key header is required.');
        return false;
    }
    return consumePublicApiRequest(response);
}

async function handleLogin(request, response) {
    if (!requireConfiguration(response)) return;
    const { username, password } = await readJson(request);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        sendError(response, 400, 'Username and password are required.');
        return;
    }
    const loginName = username.trim();
    const source = clientIp(request);
    if (isLimited(loginName, source)) {
        recordAudit('login_throttled', { detail: { username: loginName, source: sourceFingerprint(source) } });
        sendError(response, 429, 'Too many attempts. Try again later.');
        return;
    }
    const record = getUserCredentials(loginName);
    const passwordOk = Boolean(record && !record.disabled && verifyPasswordOrDummy(record.passwordHash, password));
    if (!record || record.disabled || !record.passwordHash) verifyPasswordOrDummy(null, password);
    if (!passwordOk) {
        recordFailure(loginName, source);
        recordAudit('login_failure', { actorUserId: record?.id, detail: { username: loginName, source: sourceFingerprint(source) } });
        sendError(response, 401, 'Invalid username or password.');
        return;
    }
    if (record.totpEnabled) {
        if (!hasOpenLoginChallenge(record.id)) clearMfaUserFailures(loginName);
        clearFailures(loginName, source);
        const challenge = createLoginChallenge(record.id);
        recordAudit('login_mfa_required', { actorUserId: record.id, detail: { username: loginName } });
        sendJson(response, 200, { mfaRequired: true, challenge }, securityHeaders());
        return;
    }
    clearFailures(loginName, source);
    finishLogin(response, record, loginName);
}

function finishLogin(response, record, loginName) {
    const user = presentSession(record);
    const token = createSession(user);
    recordAudit('login_success', { actorUserId: user.id, detail: { username: loginName } });
    sendJson(response, 200, { user: publicUser(user.id), csrfToken: user.csrfToken }, {
        'Set-Cookie': sessionCookie(token),
        ...securityHeaders()
    });
}

async function handleMfaLogin(request, response) {
    if (!requireConfiguration(response)) return;
    const { challenge, code } = await readJson(request);
    if (typeof challenge !== 'string' || typeof code !== 'string' || !challenge || !code.trim()) {
        sendError(response, 400, 'Authentication code is required.');
        return;
    }
    const pending = readLoginChallenge(challenge);
    const record = pending ? getUserById(pending.user_id) : null;
    const loginName = record?.username || '';
    const source = clientIp(request);
    if (loginName && mfaLimited(loginName, source)) {
        recordAudit('login_throttled', { detail: { username: loginName, source: sourceFingerprint(source) } });
        sendError(response, 429, 'Too many attempts. Try again later.');
        return;
    }
    if (!record || record.disabled || !verifySecondFactor(record.id, code.trim())) {
        if (loginName) recordMfaFailure(loginName, source);
        recordAudit('login_failure', { actorUserId: record?.id, detail: { username: loginName, source: sourceFingerprint(source) } });
        sendError(response, 401, 'Invalid authentication code.');
        return;
    }
    if (!consumeLoginChallenge(challenge)) {
        sendError(response, 401, 'Invalid authentication code.');
        return;
    }
    clearMfaFailures(loginName, source);
    clearFailures(loginName, source);
    finishLogin(response, record, loginName);
}

async function handleForgotPassword(request, response) {
    const { username } = await readJson(request);
    const source = clientIp(request);
    const loginName = typeof username === 'string' ? username.trim() : '';
    if (loginName && isLimited(`reset:${loginName}`, source)) {
        sendError(response, 429, 'Too many attempts. Try again later.');
        return;
    }
    if (loginName) recordFailure(`reset:${loginName}`, source);
    const result = await requestPasswordReset({ username: loginName });
    sendJson(response, 200, result, securityHeaders());
}

async function handleResetPassword(request, response) {
    const { token, password } = await readJson(request);
    const result = completePasswordReset({ token, password });
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true }, securityHeaders());
}

async function handleRates(request, response, session) {
    sendJson(response, 200, { rates: appRates(session.user) }, securityHeaders());
}

async function handlePredictiveRates(request, response, session, url) {
    const after = url.searchParams.get('after') || '';
    const window = predictiveWindow(after);
    if (!window.ok) {
        sendError(response, 400, window.error);
        return;
    }
    const rates = appPredictiveRates(session.user, window.fullThirtyDayPeriods, after);
    sendJson(response, 200, { rates }, securityHeaders());
}

async function handlePublicRates(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const destinationPort = url.searchParams.get('destinationPort') || '';
    const page = parsePageNumber(url.searchParams.get('page'), 1, 10_000);
    const pageSize = parsePageNumber(url.searchParams.get('pageSize'), 50, 100);
    const { rates: records, total } = queryPublicRates({ carrier, originPort, destinationPort, page, pageSize });
    const rates = records.map(record => mapRateRecord(record, null));
    sendJson(response, 200, {
        data: rates,
        meta: { total, page, pageSize, returned: rates.length }
    }, securityHeaders());
}

async function handlePublicSailings(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, originPort, and after query parameters are required.');
        return;
    }
    const sailings = getSailings({ carrier, originPort, after });
    sendJson(response, 200, { data: sailings, meta: { total: sailings.length } }, securityHeaders());
}

async function handlePredictivePricing(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, originPort, and after query parameters are required.');
        return;
    }
    const result = demoPredictiveData(getRatesByCarrierOrigin(carrier, originPort), after);
    if (!result.ok) {
        sendError(response, 400, result.error);
        return;
    }
    sendJson(response, 200, result.body, securityHeaders());
}

async function handleSailings(request, response, session, url) {
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, origin port, and effective date are required.');
        return;
    }
    const sailings = appSailings(session.user, { carrier, originPort, after });
    sendJson(response, 200, { sailings }, securityHeaders());
}

async function handleAdminCompanies(request, response, session) {
    const scope = requireContractAdmin(response, session);
    if (!scope) return;
    sendJson(response, 200, { companies: listCustomerMarginTargets(scope.company.id) }, securityHeaders());
}

async function handleAdminCompanyUpdate(request, response, session, recordId) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireContractAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    const { marginPercent, marginNumber } = body;
    if (![marginPercent, marginNumber].every(value => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
        sendError(response, 400, 'Margins must be non-negative numbers no greater than 1,000,000.');
        return;
    }
    const company = getCompanyByRecordId(recordId);
    if (!permissions.marginTargetInScope(scope, company)) {
        sendError(response, 404, 'Company was not found in your administration scope.');
        return;
    }
    upsertCompanyMargin(scope.company.id, recordId, { marginPercent, marginNumber });
    recordAudit('margin_updated', { actorUserId: session.user.id, detail: { customerCompanyId: recordId } });
    sendJson(response, 200, { ok: true }, securityHeaders());
}

async function handlePullForwardRates(request, response, session) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireContractAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    const validation = validatePullForwardRange(body);
    if (validation.error) {
        sendError(response, 400, validation.error);
        return;
    }
    const { priceIncreasePercent } = body;
    if (typeof priceIncreasePercent !== 'number' || !Number.isFinite(priceIncreasePercent) || priceIncreasePercent < 0 || priceIncreasePercent > 100) {
        sendError(response, 400, 'Price increase percent must be a number between 0 and 100.');
        return;
    }
    const result = pullForwardRates({
        sourceStart: body.sourceStart,
        sourceEnd: body.sourceEnd,
        targetStart: body.targetStart,
        targetEnd: body.targetEnd,
        offsetDays: validation.offsetDays,
        priceIncreasePercent,
        deleteExisting: body.deleteExisting === true,
        ownerCompanyId: scope.company.id
    });
    sendJson(response, 200, { ok: true, copied: result.copied, deleted: result.deleted }, securityHeaders());
}

async function handlePullForwardSailings(request, response, session) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireContractAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    const validation = validatePullForwardRange(body);
    if (validation.error) {
        sendError(response, 400, validation.error);
        return;
    }
    const result = pullForwardSailings({
        sourceStart: body.sourceStart,
        sourceEnd: body.sourceEnd,
        targetStart: body.targetStart,
        targetEnd: body.targetEnd,
        offsetDays: validation.offsetDays,
        deleteExisting: body.deleteExisting === true,
        ownerCompanyId: scope.company.id
    });
    sendJson(response, 200, { ok: true, copied: result.copied, deleted: result.deleted }, securityHeaders());
}

async function handleAdminUsers(request, response, session) {
    const scope = requireAdmin(response, session);
    if (!scope) return;
    sendJson(response, 200, { users: listUsersForAdmin(scope.company.id) }, securityHeaders());
}

function userInAdminScope(scope, userId) {
    return permissions.canManageUser(scope.actor, getUserById(userId), scope);
}

async function handleAdminPassword(request, response, session, userId) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    if (!userInAdminScope(scope, userId)) {
        sendError(response, 404, 'User was not found.');
        return;
    }
    const result = setPasswordById(userId, body.password, session.user.id, scope.company.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true, signedOut: userId === session.user.id }, securityHeaders());
}

async function handleAdminUserUpdate(request, response, session, userId) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    if (!userInAdminScope(scope, userId)) {
        sendError(response, 404, 'User was not found.');
        return;
    }
    const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email');
    const hasDisabled = typeof body.disabled === 'boolean';
    if (!hasEmail && !hasDisabled) {
        sendError(response, 400, 'disabled must be true or false.');
        return;
    }
    if (hasEmail) {
        const emailResult = setEmailById(userId, body.email, session.user.id, scope.company.id);
        if (!emailResult.ok) {
            sendError(response, emailResult.status, emailResult.error);
            return;
        }
    }
    if (hasDisabled) {
        const result = setDisabled(userId, body.disabled, session.user.id, scope.company.id);
        if (!result.ok) {
            sendError(response, result.status, result.error);
            return;
        }
    }
    sendJson(response, 200, { ok: true }, securityHeaders());
}

async function handleAdminClearMfa(request, response, session, userId) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const scope = requireAdmin(response, session);
    if (!scope) return;
    if (rejectCompanyMismatch(response, body, scope.company)) return;
    if (!userInAdminScope(scope, userId)) {
        sendError(response, 404, 'User was not found.');
        return;
    }
    const result = clearMfa(userId, session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true, signedOut: userId === session.user.id }, securityHeaders());
}

function handleSecurityStatus(request, response, session) {
    sendJson(response, 200, mfaStatus(session.user.id), securityHeaders());
}

async function handleSecurityStart(request, response, session) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = startEnrollment(session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { secret: result.secret, otpauthUrl: result.otpauthUrl }, securityHeaders());
}

async function handleSecurityConfirm(request, response, session) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = confirmEnrollment(session.user.id, body.code);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true, recoveryCodes: result.recoveryCodes }, securityHeaders());
}

async function handleSecurityDisable(request, response, session) {
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = disableOwnMfa(session.user.id, body.password, body.code);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { ok: true, signedOut: true }, securityHeaders());
}

async function handleAdminClients(request, response, session) {
    if (!requireSystemAdmin(response, session)) return;
    sendJson(response, 200, { clients: oauth.listClientsAdmin() }, securityHeaders());
}

async function handleAdminClientCreate(request, response, session) {
    if (!requireSystemAdmin(response, session)) return;
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = oauth.registerClient(body, session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 201, { client: result.client, clientSecret: result.clientSecret }, securityHeaders());
}

async function handleAdminClientUpdate(request, response, session, clientId) {
    if (!requireSystemAdmin(response, session)) return;
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = oauth.updateClient(clientId, body, session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { client: result.client }, securityHeaders());
}

async function handleAdminClientRotate(request, response, session, clientId) {
    if (!requireSystemAdmin(response, session)) return;
    const body = await readJson(request);
    if (!requireCsrf(request, response, session, body)) return;
    const result = oauth.rotateClientSecret(clientId, session.user.id);
    if (!result.ok) {
        sendError(response, result.status, result.error);
        return;
    }
    sendJson(response, 200, { client: result.client, clientSecret: result.clientSecret }, securityHeaders());
}

function sendOAuthResult(response, result) {
    if (result.type === 'redirect') return redirectTo(response, result.location);
    if (result.type === 'login') return redirectTo(response, `/login?next=${encodeURIComponent(result.next)}`);
    if (result.type === 'html') return sendHtml(response, result.status, result.html);
    return sendOAuthError(response, result.status || 400, result.body?.error || 'invalid_request', result.body?.error_description || 'Request failed.');
}

async function handleAuthorize(request, response, url) {
    if (request.method === 'GET') {
        const session = liveSession(request);
        const result = oauth.beginAuthorization({
            query: Object.fromEntries(url.searchParams),
            sessionUser: session?.user || null
        });
        return sendOAuthResult(response, result);
    }
    if (request.method === 'POST') {
        const form = formBody(await readBody(request));
        const session = liveSession(request);
        if (!session) {
            return sendOAuthResult(response, oauth.completeAuthorization({ form, sessionUser: null }));
        }
        if (!requireCsrf(request, response, session, form)) return;
        return sendOAuthResult(response, oauth.completeAuthorization({ form, sessionUser: session.user }));
    }
    sendError(response, 405, 'Method not allowed.');
}

function parseOAuthBody(text, contentType) {
    if ((contentType || '').includes('application/json')) {
        try {
            const body = text ? JSON.parse(text) : {};
            if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: true };
            return { body };
        } catch {
            return { error: true };
        }
    }
    return { body: formBody(text) };
}

async function handleToken(request, response) {
    const text = await readBody(request);
    const parsed = parseOAuthBody(text, request.headers['content-type'] || '');
    if (parsed.error) {
        sendOAuthError(response, 400, 'invalid_request', 'Request body must be valid JSON.');
        return;
    }
    const result = oauth.grantToken(parsed.body);
    sendJson(response, result.status, result.body, securityHeaders());
}

async function handleRevoke(request, response) {
    const text = await readBody(request);
    const parsed = parseOAuthBody(text, request.headers['content-type'] || '');
    if (parsed.error) {
        sendOAuthError(response, 400, 'invalid_request', 'Request body must be valid JSON.');
        return;
    }
    const result = oauth.revokePresentedToken(parsed.body);
    sendJson(response, result.status, result.body, securityHeaders());
}

function handleUserInfo(request, response) {
    const result = oauth.userInfo(bearerToken(request));
    const headers = result.status === 401
        ? { 'WWW-Authenticate': `Bearer realm="rateninja", resource_metadata="${externalOrigin(request)}/.well-known/oauth-protected-resource"` }
        : {};
    sendJson(response, result.status, result.body, { ...headers, ...securityHeaders() });
}

function handleConsents(request, response, session) {
    if (!session.user.isContractOwner) {
        sendError(response, 403, 'Only contract-owner accounts have partner grants.');
        return;
    }
    sendJson(response, 200, { grants: oauth.listUserGrants(session.user.id) }, securityHeaders());
}

function handleConsentDelete(request, response, session, clientId) {
    if (!requireCsrf(request, response, session)) return;
    if (!session.user.isContractOwner) {
        sendError(response, 403, 'Only contract-owner accounts have partner grants.');
        return;
    }
    oauth.revokeUserClientGrant(session.user.id, clientId);
    sendJson(response, 200, { ok: true }, securityHeaders());
}

function handlePartnerRates(request, response, url) {
    const access = requirePartnerAccess(request, response, 'rates:read');
    if (!access) return;
    const query = pageArgs(url.searchParams);
    if (query.error) return sendOAuthError(response, 400, 'invalid_request', query.error);
    const payload = listPartnerRates(access, query);
    recordAudit('partner_rates_read', { actorUserId: access.sub, clientId: access.clientId, detail: { count: payload.data.length } });
    sendJson(response, 200, payload, securityHeaders());
}

function handlePartnerRate(request, response, rateId) {
    const access = requirePartnerAccess(request, response, 'rates:read');
    if (!access) return;
    const payload = getPartnerRate(access, rateId);
    if (!payload) return sendOAuthError(response, 404, 'not_found', 'Rate not found.');
    recordAudit('partner_rates_read', { actorUserId: access.sub, clientId: access.clientId, detail: { count: 1 } });
    sendJson(response, 200, payload, securityHeaders());
}

function handlePartnerSailings(request, response, url) {
    const access = requirePartnerAccess(request, response, 'sailings:read');
    if (!access) return;
    const query = pageArgs(url.searchParams);
    if (query.error) return sendOAuthError(response, 400, 'invalid_request', query.error);
    const payload = listPartnerSailings(access, query);
    recordAudit('partner_sailings_read', { actorUserId: access.sub, clientId: access.clientId, detail: { count: payload.data.length } });
    sendJson(response, 200, payload, securityHeaders());
}

function handlePartnerSailing(request, response, sailingId) {
    const access = requirePartnerAccess(request, response, 'sailings:read');
    if (!access) return;
    const payload = getPartnerSailing(access, sailingId);
    if (!payload) return sendOAuthError(response, 404, 'not_found', 'Sailing not found.');
    recordAudit('partner_sailings_read', { actorUserId: access.sub, clientId: access.clientId, detail: { count: 1 } });
    sendJson(response, 200, payload, securityHeaders());
}

async function handleMcpRequest(request, response) {
    const origin = externalOrigin(request);
    const authHeaders = {
        'WWW-Authenticate': `Bearer realm="rateninja", resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    };
    let message = null;
    try {
        const text = await readBody(request);
        message = text ? JSON.parse(text) : null;
    } catch {
        message = null;
    }
    if (!partnerOauthEnabled()) {
        sendJson(response, 403, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32001, message: 'partner_oauth_disabled' } }, securityHeaders());
        return;
    }
    const protocolHeader = request.headers['mcp-protocol-version'];
    if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(protocolHeader))) {
        sendJson(response, 400, {
            jsonrpc: '2.0',
            id: message?.id ?? null,
            error: { code: -32600, message: 'Unsupported protocol version' }
        }, securityHeaders());
        return;
    }
    const token = bearerToken(request);
    const verified = token ? oauth.verifyAccessToken(token) : { ok: false, status: 401, error: 'invalid_token', description: 'A bearer access token is required.' };
    if (!verified.ok) {
        sendJson(response, verified.status, {
            jsonrpc: '2.0',
            id: message?.id ?? null,
            error: { code: -32001, message: verified.error }
        }, { ...authHeaders, ...securityHeaders() });
        return;
    }
    if (!consumePartnerRequest(verified.access.clientId, verified.access.sub)) {
        sendJson(response, 429, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32001, message: 'rate_limited' } }, securityHeaders());
        return;
    }
    const result = handleMcp({ message, access: verified.access, pageFrom: args => pageArgs(args) });
    if (result.status === 202) {
        response.writeHead(202, securityHeaders());
        response.end();
        return;
    }
    sendJson(response, result.status, result.body, securityHeaders());
}

function handleHealth(request, response) {
    let database = false;
    try {
        database = db.prepare('SELECT 1 AS ok').get().ok === 1;
    } catch {
        database = false;
    }
    const checks = {
        sessionSecret: Boolean(config.sessionSecret),
        oauthSigningKey: Boolean(oauthSigningKey()),
        database
    };
    const ok = checks.sessionSecret && checks.oauthSigningKey && checks.database;
    sendJson(response, ok ? 200 : 503, {
        ok,
        service: 'rate-ninja',
        partnerOauthEnabled: partnerOauthEnabled(),
        passwordHashing: 'argon2id',
        mcp: '/mcp',
        resendConfigured: resendSettings().configured,
        checks
    });
}

const PUBLIC_DIR = path.join(ROOT, 'public');

function hasDotSegment(pathname) {
    return pathname.split('/').some(segment => segment.startsWith('.'));
}

function staticPathFromRequest(requestUrl) {
    const raw = typeof requestUrl === 'string' && requestUrl.length > 0 ? requestUrl : '/';
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
}

function hasEmptySegment(pathname) {
    return pathname.split('/').slice(1).some(segment => segment.length === 0);
}

function staticPathForbidden(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) {
        return true;
    }
    return hasDotSegment(pathname) || hasEmptySegment(pathname);
}

function isInsideDir(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative.length > 0
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

async function serveStatic(request, response, pathname) {
    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    if (staticPathForbidden(requestedPath)) {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(requestedPath);
    } catch {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    if (staticPathForbidden(decodedPath)) {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    const filePath = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
    if (!isInsideDir(PUBLIC_DIR, filePath)) {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    try {
        const realPublic = await fs.realpath(PUBLIC_DIR);
        const listed = await fs.lstat(filePath);
        if (listed.isSymbolicLink() || !listed.isFile()) {
            sendError(response, 403, 'Forbidden.');
            return;
        }
        const realFile = await fs.realpath(filePath);
        if (!isInsideDir(realPublic, realFile)) {
            sendError(response, 403, 'Forbidden.');
            return;
        }
        const content = await fs.readFile(realFile);
        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(realFile)] || 'application/octet-stream',
            ...securityHeaders()
        });
        response.end(content);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            sendError(response, 404, 'Not found.');
            return;
        }
        sendError(response, 403, 'Forbidden.');
    }
}

// Literal path to literal file. Do not join request input onto a directory.
const EXACT_DOCUMENTS = new Map([
    ['/docs/partner-integration.md', path.join(ROOT, 'docs', 'partner-integration.md')],
    ['/API-README.md', path.join(ROOT, 'API-README.md')]
]);

async function serveExactDocument(response, requestPath) {
    const filePath = EXACT_DOCUMENTS.get(requestPath);
    if (!filePath) return false;
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
        'Content-Type': contentTypes['.md'],
        ...securityHeaders()
    });
    response.end(content);
    return true;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchRoute(route, pathname) {
    if (typeof route.path === 'string' && route.pattern == null) {
        return route.path === pathname ? [] : null;
    }
    if (route.pattern instanceof RegExp && route.path == null) {
        const expression = new RegExp(route.pattern.source, route.pattern.flags.replace('g', ''));
        const match = expression.exec(pathname);
        return match ? match.slice(1) : null;
    }
    return null;
}

function findModuleRoute(pathname, method, accessNames) {
    for (const mod of routeModules) {
        const routes = mod && Array.isArray(mod.routes) ? mod.routes : [];
        for (const route of routes) {
            if (!route || route.method !== method || !accessNames.includes(route.access)) continue;
            const params = matchRoute(route, pathname);
            if (params) return { route, params };
        }
    }
    return null;
}

async function dispatchModuleRoute(request, response, pathname, kind, session) {
    const accessNames = kind === 'public' ? ['public'] : ['session', 'session-unrestricted'];
    const hit = findModuleRoute(pathname, request.method, accessNames);
    if (!hit) return false;
    if (kind !== 'public' && !SAFE_METHODS.has(request.method)) {
        const text = await readBody(request);
        request._rnRawBody = text;
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            throw new Error('Request body must be valid JSON.');
        }
        if (!requireCsrf(request, response, session, body)) return true;
    }
    await hit.route.handler(request, response, session, hit.params);
    return true;
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const { pathname } = url;
    try {
        if (pathname === '/api/health' && request.method === 'GET') return handleHealth(request, response);
        if (pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, response);
        if (pathname === '/api/auth/login/mfa' && request.method === 'POST') return handleMfaLogin(request, response);
        if (pathname === '/api/auth/forgot-password' && request.method === 'POST') return handleForgotPassword(request, response);
        if (pathname === '/api/auth/reset-password' && request.method === 'POST') return handleResetPassword(request, response);
        if (pathname === '/api/auth/logout' && request.method === 'POST') {
            const session = getSession(request);
            if (session && !requireCsrf(request, response, session)) return;
            if (session) destroySession(session.token);
            sendJson(response, 204, null, { 'Set-Cookie': sessionCookie('', 0), ...securityHeaders() });
            return;
        }
        if (pathname === '/api/session' && request.method === 'GET') {
            const session = requireSession(request, response);
            if (!session) return;
            sendJson(response, 200, { user: publicUser(session.user.id, session.companyContextId), csrfToken: session.user.csrfToken }, securityHeaders());
            return;
        }
        if (pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
            return sendJson(response, 200, oauth.authorizationServerMetadata(externalOrigin(request)));
        }
        if ((pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') {
            return sendJson(response, 200, oauth.protectedResourceMetadata(externalOrigin(request)));
        }
        if (pathname === '/oauth/authorize') return handleAuthorize(request, response, url);
        if (pathname === '/oauth/token' && request.method === 'POST') return handleToken(request, response);
        if (pathname === '/oauth/revoke' && request.method === 'POST') return handleRevoke(request, response);
        if (pathname === '/oauth/userinfo' && request.method === 'GET') return handleUserInfo(request, response);
        if (pathname === '/mcp' && request.method === 'POST') return handleMcpRequest(request, response);
        if (pathname === '/api/v1' && request.method === 'GET') {
            sendJson(response, 200, {
                name: 'Rate Ninja Demo API',
                version: 'v1',
                authentication: 'Send your demo key in the X-API-Key header. This key does not grant partner API access.',
                endpoints: ['/api/v1/rates', '/api/v1/sailings', '/api/v1/predictive-pricing']
            }, securityHeaders());
            return;
        }
        if (pathname === '/api/v1/rates' && request.method === 'GET') return handlePublicRates(request, response, url);
        if (pathname === '/api/v1/sailings' && request.method === 'GET') return handlePublicSailings(request, response, url);
        if (pathname === '/api/v1/predictive-pricing' && request.method === 'GET') return handlePredictivePricing(request, response, url);

        if (pathname === '/api/partner/v1/me/rates' && request.method === 'GET') return handlePartnerRates(request, response, url);
        if (pathname === '/api/partner/v1/me/sailings' && request.method === 'GET') return handlePartnerSailings(request, response, url);
        const partnerRateMatch = pathname.match(/^\/api\/partner\/v1\/me\/rates\/([\w-]+)$/);
        if (partnerRateMatch && request.method === 'GET') return handlePartnerRate(request, response, partnerRateMatch[1]);
        const partnerSailingMatch = pathname.match(/^\/api\/partner\/v1\/me\/sailings\/([\w-]+)$/);
        if (partnerSailingMatch && request.method === 'GET') return handlePartnerSailing(request, response, partnerSailingMatch[1]);

        if (await dispatchModuleRoute(request, response, pathname, 'public', null)) return;

        const session = pathname.startsWith('/api/') || pathname.startsWith('/oauth/') ? requireSession(request, response) : null;
        if ((pathname.startsWith('/api/') || pathname.startsWith('/oauth/')) && !session) return;
        if (pathname === '/oauth/consents' && request.method === 'GET') return handleConsents(request, response, session);
        const consentMatch = pathname.match(/^\/oauth\/consents\/([\w-]+)$/);
        if (consentMatch && request.method === 'DELETE') return handleConsentDelete(request, response, session, consentMatch[1]);
        if (pathname === '/api/account/security' && request.method === 'GET') return handleSecurityStatus(request, response, session);
        if (pathname === '/api/account/2fa/start' && request.method === 'POST') return handleSecurityStart(request, response, session);
        if (pathname === '/api/account/2fa/confirm' && request.method === 'POST') return handleSecurityConfirm(request, response, session);
        if (pathname === '/api/account/2fa/disable' && request.method === 'POST') return handleSecurityDisable(request, response, session);
        if (pathname === '/api/rates/predictive' && request.method === 'GET') return handlePredictiveRates(request, response, session, url);
        if (pathname === '/api/rates' && request.method === 'GET') return handleRates(request, response, session);
        if (pathname === '/api/sailings' && request.method === 'GET') return handleSailings(request, response, session, url);
        if (pathname === '/api/admin/companies' && request.method === 'GET') return handleAdminCompanies(request, response, session);
        if (pathname === '/api/admin/users' && request.method === 'GET') return handleAdminUsers(request, response, session);
        if (pathname === '/api/admin/oauth-clients' && request.method === 'GET') return handleAdminClients(request, response, session);
        if (pathname === '/api/admin/oauth-clients' && request.method === 'POST') return handleAdminClientCreate(request, response, session);
        if (pathname === '/api/admin/pull-forward/rates' && request.method === 'POST') return handlePullForwardRates(request, response, session);
        if (pathname === '/api/admin/pull-forward/sailings' && request.method === 'POST') return handlePullForwardSailings(request, response, session);
        const companyMatch = pathname.match(/^\/api\/admin\/companies\/([\w-]+)$/);
        if (companyMatch && request.method === 'PATCH') return handleAdminCompanyUpdate(request, response, session, companyMatch[1]);
        const userPasswordMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)\/password$/);
        if (userPasswordMatch && request.method === 'POST') return handleAdminPassword(request, response, session, userPasswordMatch[1]);
        const userMfaMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)\/two-factor$/);
        if (userMfaMatch && request.method === 'DELETE') return handleAdminClearMfa(request, response, session, userMfaMatch[1]);
        const userMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
        if (userMatch && request.method === 'PATCH') return handleAdminUserUpdate(request, response, session, userMatch[1]);
        const clientRotateMatch = pathname.match(/^\/api\/admin\/oauth-clients\/([\w-]+)\/rotate-secret$/);
        if (clientRotateMatch && request.method === 'POST') return handleAdminClientRotate(request, response, session, clientRotateMatch[1]);
        const clientMatch = pathname.match(/^\/api\/admin\/oauth-clients\/([\w-]+)$/);
        if (clientMatch && request.method === 'PATCH') return handleAdminClientUpdate(request, response, session, clientMatch[1]);
        if (session && await dispatchModuleRoute(request, response, pathname, 'session', session)) return;
        if (pathname.startsWith('/api/') || pathname.startsWith('/oauth/')) return sendError(response, 404, 'API route not found.');
        if (await serveExactDocument(response, staticPathFromRequest(request.url))) return;
        if (pathname === '/login') return serveStatic(request, response, '/login.html');
        // Raw path: the WHATWG parser rewrites "//server.js" to "/" and would serve the index.
        return serveStatic(request, response, staticPathFromRequest(request.url));
    } catch (error) {
        const message = error.message === 'Request body must be valid JSON.' || error.message === 'Request body is too large.'
            ? error.message
            : 'Something went wrong. Please try again.';
        const status = message === 'Something went wrong. Please try again.' ? 500 : 400;
        if (status === 500) console.error(`Request failed ${request.method} ${pathname}: ${error.message}`);
        if (!response.headersSent) sendError(response, status, message);
    }
});

if (require.main === module) {
    ensureFoundation();
    startSessionSweep();
    server.listen(PORT, HOST, () => {
        console.log(`Rate Ninja is running at http://${HOST}:${PORT}`);
    });
}

module.exports = { server };
