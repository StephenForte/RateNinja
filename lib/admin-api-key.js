'use strict';

const crypto = require('node:crypto');
const {
    config,
    ADMIN_API_RATE_LIMIT,
    ADMIN_API_WINDOW_MS
} = require('./config');
const { sendJson, securityHeaders } = require('./http');

let adminApiWindow = { startedAt: 0, requests: 0 };

function configuredAdminKey() {
    const key = config.adminApiKey;
    if (typeof key !== 'string' || key.length < 32) return null;
    if (typeof config.publicApiKey === 'string' && key === config.publicApiKey) return null;
    return key;
}

function adminApiEnabled() {
    return configuredAdminKey() !== null;
}

function adminApiKeyIsValid(request) {
    const expectedKey = configuredAdminKey();
    if (!expectedKey) return false;
    const suppliedKey = request.headers['x-admin-api-key'];
    if (typeof suppliedKey !== 'string') return false;
    const supplied = Buffer.from(suppliedKey);
    const expected = Buffer.from(expectedKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function consumeAdminApiRequest() {
    const now = Date.now();
    if (now - adminApiWindow.startedAt >= ADMIN_API_WINDOW_MS) {
        adminApiWindow = { startedAt: now, requests: 0 };
    }
    if (adminApiWindow.requests >= ADMIN_API_RATE_LIMIT) return false;
    adminApiWindow.requests += 1;
    return true;
}

function requireAdminApiAccess(request, response) {
    if (!adminApiEnabled()) {
        sendJson(response, 503, { error: 'admin_api_disabled' }, securityHeaders());
        return false;
    }
    if (!adminApiKeyIsValid(request)) {
        sendJson(response, 401, { error: 'invalid_admin_key' }, securityHeaders());
        return false;
    }
    if (!consumeAdminApiRequest()) {
        sendJson(response, 429, { error: 'rate_limited' }, securityHeaders());
        return false;
    }
    return true;
}

function resetAdminApiWindowForTests() {
    adminApiWindow = { startedAt: 0, requests: 0 };
}

module.exports = {
    adminApiEnabled,
    adminApiKeyIsValid,
    requireAdminApiAccess,
    resetAdminApiWindowForTests
};
