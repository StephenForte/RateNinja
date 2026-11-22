'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const { config } = require('./config');

// Own label, own key. MFA keeps `mfa:` in lib/mfa.js and is not reused here.
function encryptionKey() {
    if (!config.sessionSecret) return null;
    return crypto.createHash('sha256').update(`swarm-bbs:${config.sessionSecret}`).digest();
}

function encryptBbsToken(plain) {
    const key = encryptionKey();
    if (!key) throw new Error('Session secret is not configured.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function decryptBbsToken(payload) {
    const key = encryptionKey();
    if (!key || typeof payload !== 'string' || !payload) return null;
    try {
        const buffer = Buffer.from(payload, 'base64url');
        if (buffer.length < 28) return null;
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        if (tag.length !== 16) return null;
        const ciphertext = buffer.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return plain.length > 0 ? plain : null;
    } catch {
        return null;
    }
}

function tokenIsReadable(payload) {
    return decryptBbsToken(payload) !== null;
}

// Engine entry point (R1-64). Null when the row is missing, the company is
// disabled, the project is blank, or the token cannot be decrypted.
function readBbsCredentials(companyId) {
    if (!companyId) return null;
    const row = db.prepare(`
        SELECT enabled, bbs_project, bbs_token_enc
        FROM company_swarm_settings
        WHERE company_id = ?
    `).get(companyId);
    if (!row || row.enabled !== 1 || !row.bbs_project) return null;
    const bbsToken = decryptBbsToken(row.bbs_token_enc);
    if (!bbsToken) return null;
    return { bbsProject: row.bbs_project, bbsToken };
}

module.exports = {
    encryptBbsToken,
    decryptBbsToken,
    tokenIsReadable,
    readBbsCredentials
};
