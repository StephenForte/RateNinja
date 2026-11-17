'use strict';

const crypto = require('node:crypto');
const { config } = require('./config');
const { getUserById, companyForUser } = require('./store');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');

// Credential verification only. The caller must apply partner limits, audiences and scopes.
function verifyBuyerApiKey(suppliedKey) {
    const key = config.buyerApiKey;
    if (typeof key !== 'string' || key.length < 32 || key === config.publicApiKey
        || key === config.adminApiKey || typeof config.buyerUserId !== 'string' || !config.buyerUserId.trim()) {
        return { ok: false, status: 503, error: 'buyer_api_disabled', description: 'Buyer API key access is not configured.' };
    }
    const supplied = Buffer.from(typeof suppliedKey === 'string' ? suppliedKey : '');
    const expected = Buffer.from(key);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return { ok: false, status: 401, error: 'invalid_token', description: 'Buyer API key is invalid.' };
    }
    const user = getUserById(config.buyerUserId);
    const company = user && companyForUser(user);
    if (!user || user.disabled || company?.fields?.CompanyType !== COMPANY_TYPE_CUSTOMER) {
        return { ok: false, status: 403, error: 'buyer_access_denied', description: 'The bound buyer account is unavailable.' };
    }
    return {
        ok: true,
        access: {
            sub: user.id,
            username: user.displayName || user.username,
            loginName: user.username,
            clientId: 'buyer-api-key',
            scopes: ['profile:read', 'rates:read', 'sailings:read'],
            grantId: null,
            companyRecordId: company.id,
            companyId: company.fields.CompanyID || user.companyId || '',
            companyName: company.fields.CompanyName || '',
            companyType: company.fields.CompanyType,
            active: true
        }
    };
}

module.exports = { verifyBuyerApiKey };
