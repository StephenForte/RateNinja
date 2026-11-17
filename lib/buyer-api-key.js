'use strict';

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { recordAudit, EVENT_BUYER_API_KEY_CREATED, EVENT_BUYER_API_KEY_REVOKED } = require('./audit');
const { getUserById, companyForUser } = require('./store');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');

// Credential verification only. The caller must apply partner limits, audiences and scopes.
function verifyBuyerApiKey(suppliedKey) {
    const hash = crypto.createHash('sha256').update(typeof suppliedKey === 'string' ? suppliedKey : '').digest('hex');
    const key = db.prepare('SELECT id, user_id FROM buyer_api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(hash);
    if (!key) {
        return { ok: false, status: 401, error: 'invalid_token', description: 'Buyer API key is invalid.' };
    }
    const user = getUserById(key.user_id);
    const company = user && companyForUser(user);
    if (!user || user.disabled || company?.fields?.CompanyType !== COMPANY_TYPE_CUSTOMER) {
        return { ok: false, status: 403, error: 'buyer_access_denied', description: 'The bound buyer account is unavailable.' };
    }
    db.prepare('UPDATE buyer_api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), key.id);
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

// Explicit projection: hashes and the full key must never enter list/create metadata.
const KEY_COLUMNS = 'id, label, key_prefix, created_at, last_used_at, revoked_at';

function isActiveBuyer(userId) {
    const user = getUserById(userId);
    return !!(user && !user.disabled && companyForUser(user)?.fields?.CompanyType === COMPANY_TYPE_CUSTOMER);
}

function listBuyerApiKeys(userId) {
    return db.prepare(`SELECT ${KEY_COLUMNS} FROM buyer_api_keys WHERE user_id = ? ORDER BY created_at, id`).all(userId);
}

function createBuyerApiKey(userId, label) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) {
        return { status: 400, error: 'A label of 1–80 characters is required.' };
    }
    return transaction(() => {
        if (!isActiveBuyer(userId)) return { status: 403, error: 'buyer_access_denied' };
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM buyer_api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId);
        if (count >= 5) return { status: 409, error: 'active_key_limit' };
        const key = 'rnb_' + crypto.randomBytes(32).toString('base64url');
        const id = crypto.randomUUID();
        const prefix = key.slice(4, 12);
        db.prepare(`INSERT INTO buyer_api_keys (id, user_id, label, key_prefix, key_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, label.trim(), prefix,
            crypto.createHash('sha256').update(key).digest('hex'), new Date().toISOString());
        recordAudit(EVENT_BUYER_API_KEY_CREATED, { actorUserId: userId, detail: { keyId: id, prefix } });
        return { status: 201, key, apiKey: db.prepare(`SELECT ${KEY_COLUMNS} FROM buyer_api_keys WHERE id = ?`).get(id) };
    });
}

function revokeBuyerApiKey(userId, id) {
    return transaction(() => {
        if (!isActiveBuyer(userId)) return { status: 403, error: 'buyer_access_denied' };
        const key = db.prepare('SELECT key_prefix, revoked_at FROM buyer_api_keys WHERE id = ? AND user_id = ?').get(id, userId);
        if (!key) return { status: 404, error: 'key_not_found' };
        if (!key.revoked_at) {
            db.prepare('UPDATE buyer_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ?').run(new Date().toISOString(), id, userId);
            recordAudit(EVENT_BUYER_API_KEY_REVOKED, { actorUserId: userId, detail: { keyId: id, prefix: key.key_prefix } });
        }
        return { status: 200, ok: true };
    });
}

module.exports = { verifyBuyerApiKey, isActiveBuyer, listBuyerApiKeys, createBuyerApiKey, revokeBuyerApiKey };
