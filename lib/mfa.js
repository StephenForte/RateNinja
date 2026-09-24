const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { config } = require('./config');
const { verifyPassword } = require('./passwords');
const { getUserById } = require('./store');
const { destroyUserSessions } = require('./session');
const { recordAudit } = require('./audit');
const { generateSecret, otpauthUrl, verifyTotp } = require('./totp');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_COUNT = 8;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function encryptionKey() {
    if (!config.sessionSecret) return null;
    return crypto.createHash('sha256').update(`mfa:${config.sessionSecret}`).digest();
}

function encryptSecret(plain) {
    const key = encryptionKey();
    if (!key) throw new Error('Session secret is not configured.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function decryptSecret(payload) {
    const key = encryptionKey();
    if (!key || !payload) return null;
    try {
        const buffer = Buffer.from(payload, 'base64url');
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        const ciphertext = buffer.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

function recoveryCode() {
    const bytes = crypto.randomBytes(10);
    let raw = '';
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecovery(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function mfaStatus(userId) {
    const row = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
    return { enabled: row?.totp_enabled === 1 };
}

function startEnrollment(userId) {
    const user = getUserById(userId);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    if (user.totpEnabled) return { ok: false, status: 400, error: 'Two-factor authentication is already on.' };
    if (!encryptionKey()) return { ok: false, status: 500, error: 'Server configuration is incomplete. Set SESSION_SECRET.' };
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(encryptSecret(secret), userId);
    return { ok: true, secret, otpauthUrl: otpauthUrl(user.username, secret) };
}

function confirmEnrollment(userId, code) {
    const row = db.prepare('SELECT username, totp_pending, totp_enabled FROM users WHERE id = ?').get(userId);
    if (!row) return { ok: false, status: 404, error: 'User was not found.' };
    if (row.totp_enabled === 1) return { ok: false, status: 400, error: 'Two-factor authentication is already on.' };
    const secret = decryptSecret(row.totp_pending);
    const step = secret ? verifyTotp(secret, String(code || '').trim()) : null;
    if (step === null) return { ok: false, status: 400, error: 'That authenticator code is not valid.' };
    const codes = Array.from({ length: RECOVERY_COUNT }, () => recoveryCode());
    const now = Date.now();
    transaction(() => {
        db.prepare(`
            UPDATE users
            SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?
            WHERE id = ?
        `).run(encryptSecret(secret), step, userId);
        db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
        const insert = db.prepare('INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
        for (const recovery of codes) insert.run(crypto.randomUUID(), userId, sha256(normalizeRecovery(recovery)), now);
    });
    recordAudit('mfa_enrolled', { actorUserId: userId });
    return { ok: true, recoveryCodes: codes };
}

function consumeRecoveryCode(userId, code) {
    const normalized = normalizeRecovery(code);
    if (normalized.length < 8) return false;
    const hash = sha256(normalized);
    const now = Date.now();
    const consumed = db.prepare(`
        UPDATE mfa_recovery_codes
        SET used_at = ?
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    `).run(now, userId, hash);
    return Number(consumed.changes) === 1;
}

function verifySecondFactor(userId, code) {
    const row = db.prepare('SELECT totp_enabled, totp_secret, totp_last_step FROM users WHERE id = ?').get(userId);
    if (!row || row.totp_enabled !== 1) return false;
    const token = String(code || '').trim();
    const secret = decryptSecret(row.totp_secret);
    const step = secret ? verifyTotp(secret, token, Date.now(), row.totp_last_step) : null;
    if (step !== null) {
        db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
        return true;
    }
    return consumeRecoveryCode(userId, token);
}

function disableOwnMfa(userId, password, code) {
    const user = getUserById(userId);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    if (!user.totpEnabled) return { ok: false, status: 400, error: 'Two-factor authentication is not on.' };
    if (!user.passwordHash || !verifyPassword(user.passwordHash, password)) {
        return { ok: false, status: 401, error: 'Invalid username or password.' };
    }
    if (!verifySecondFactor(userId, code)) {
        return { ok: false, status: 401, error: 'Invalid authentication code.' };
    }
    return clearMfa(userId, userId);
}

function clearMfa(userId, actorUserId) {
    const user = getUserById(userId);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    db.prepare(`
        UPDATE users
        SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = NULL
        WHERE id = ?
    `).run(userId);
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    destroyUserSessions(userId);
    recordAudit(actorUserId === userId ? 'mfa_disabled' : 'mfa_cleared', {
        actorUserId,
        detail: { targetUserId: userId }
    });
    return { ok: true };
}

function hasOpenLoginChallenge(userId) {
    const row = db.prepare(`
        SELECT id FROM login_challenges
        WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
        LIMIT 1
    `).get(userId, Date.now());
    return Boolean(row);
}

function invalidateLoginChallenges(userId) {
    if (!userId) return;
    db.prepare('UPDATE login_challenges SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), userId);
}

function createLoginChallenge(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare(`
        INSERT INTO login_challenges (id, user_id, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId, sha256(token), now + CHALLENGE_TTL_MS, now);
    return token;
}

function readLoginChallenge(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = db.prepare('SELECT * FROM login_challenges WHERE token_hash = ?').get(sha256(token));
    if (!row || row.used_at || row.expires_at <= Date.now()) return null;
    return row;
}

function consumeLoginChallenge(token) {
    const row = readLoginChallenge(token);
    if (!row) return null;
    const consumed = db.prepare('UPDATE login_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(Date.now(), row.id);
    if (Number(consumed.changes) !== 1) return null;
    return row.user_id;
}

module.exports = {
    mfaStatus,
    startEnrollment,
    confirmEnrollment,
    verifySecondFactor,
    disableOwnMfa,
    clearMfa,
    hasOpenLoginChallenge,
    invalidateLoginChallenges,
    createLoginChallenge,
    readLoginChallenge,
    consumeLoginChallenge
};
