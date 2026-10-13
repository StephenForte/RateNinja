const { PORT, PARTNER_RATE_LIMIT, PARTNER_WINDOW_MS } = require('./config');
const { parseDateOnly, parsePageNumber } = require('./domain');
const { sendJson } = require('./http');
const oauth = require('./oauth');

const partnerWindows = new Map();

function sendOAuthError(response, status, error, description, headers = {}) {
    sendJson(response, status, { error, error_description: description }, headers);
}

function externalOrigin(request) {
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = forwarded ? String(forwarded).split(',')[0].trim() : 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${PORT}`;
    return `${proto}://${host}`;
}

function bearerToken(request) {
    const header = request.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : '';
}

function consumePartnerRequest(clientId, subject) {
    const key = `${clientId}:${subject}`;
    const now = Date.now();
    const current = partnerWindows.get(key);
    if (!current || now - current.startedAt >= PARTNER_WINDOW_MS) {
        partnerWindows.set(key, { startedAt: now, requests: 1 });
        return true;
    }
    if (current.requests >= PARTNER_RATE_LIMIT) return false;
    current.requests += 1;
    return true;
}

function requirePartnerAccess(request, response, scope) {
    const origin = externalOrigin(request);
    const headers = {
        'WWW-Authenticate': `Bearer realm="rateninja", resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    };
    const token = bearerToken(request);
    if (!token) {
        sendOAuthError(response, 401, 'invalid_token', 'A bearer access token is required.', headers);
        return null;
    }
    const verified = oauth.verifyAccessToken(token, scope);
    if (!verified.ok) {
        sendOAuthError(response, verified.status, verified.error, verified.description, verified.status === 401 ? headers : {});
        return null;
    }
    if (!consumePartnerRequest(verified.access.clientId, verified.access.sub)) {
        sendOAuthError(response, 429, 'rate_limited', 'Partner API rate limit exceeded. Try again in a minute.');
        return null;
    }
    return verified.access;
}

function pageArgs(source) {
    const read = name => (typeof source.get === 'function' ? source.get(name) : source[name]) || '';
    const effectiveDate = read('effectiveDate');
    if (effectiveDate && !parseDateOnly(effectiveDate)) return { error: 'effectiveDate must be YYYY-MM-DD.' };
    return {
        carrier: read('carrier'),
        originPort: read('originPort'),
        destinationPort: read('destinationPort'),
        after: read('after'),
        effectiveDate,
        page: parsePageNumber(read('page'), 1, 10_000),
        pageSize: parsePageNumber(read('pageSize'), 50, 100)
    };
}

module.exports = {
    sendOAuthError,
    bearerToken,
    consumePartnerRequest,
    requirePartnerAccess,
    pageArgs
};
