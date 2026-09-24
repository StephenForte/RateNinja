const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { PASSWORD_HASH_VERSION } = require('./constants');
const { hashPassword, validatePassword } = require('./passwords');
const { getUserCredentials } = require('./store');
const { destroyUserSessions } = require('./session');
const { recordAudit } = require('./audit');
const { resendSettings, sendEmail } = require('./resend');

const RESET_TTL_MS = 30 * 60 * 1000;
const GENERIC_MESSAGE = 'If that account can receive mail, a reset link is on its way.';
const MAIL_NOT_SENT = 'Password reset mail was not sent.';

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function logMailNotSent() {
    console.warn(MAIL_NOT_SENT);
}

async function requestPasswordReset({ username, origin }) {
    const response = { ok: true, message: GENERIC_MESSAGE };
    if (!resendSettings().configured) {
        logMailNotSent();
        return response;
    }
    const user = typeof username === 'string' ? getUserCredentials(username.trim()) : null;
    const email = user && !user.disabled ? String(user.email || '').trim() : '';
    if (!user || user.disabled || !email) return response;

    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    transaction(() => {
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, user.id);
        db.prepare(`
            INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), user.id, sha256(token), now + RESET_TTL_MS, now);
    });
    const link = `${origin}/login?reset=${encodeURIComponent(token)}`;
    const sent = await sendEmail({
        to: email,
        subject: 'Reset your Rate Ninja password',
        text: [
            'A password reset was requested for your Rate Ninja account.',
            '',
            'Open this link to choose a new password. It expires in 30 minutes and can be used once:',
            link,
            '',
            'If you did not ask for this, ignore this message.'
        ].join('\n')
    });
    if (!sent?.sent) logMailNotSent();
    recordAudit('password_reset_requested', { actorUserId: user.id });
    return response;
}

function completePasswordReset({ token, password }) {
    const problem = validatePassword(password);
    if (problem) return { ok: false, status: 400, error: problem };
    if (typeof token !== 'string' || !token) {
        return { ok: false, status: 400, error: 'This reset link is invalid or expired.' };
    }
    const tokenHash = sha256(token);
    const userId = transaction(() => {
        const now = Date.now();
        const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);
        if (!row || row.used_at || row.expires_at <= now) return null;
        const consumed = db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id);
        if (Number(consumed.changes) !== 1) return null;
        const user = db.prepare('SELECT id, disabled, session_epoch FROM users WHERE id = ?').get(row.user_id);
        if (!user || user.disabled === 1) return null;
        const nextEpoch = (Number(user.session_epoch) || 0) + 1;
        db.prepare(`
            UPDATE users
            SET password_hash = ?, password_hash_version = ?, pwd = NULL, session_epoch = ?
            WHERE id = ?
        `).run(hashPassword(password), PASSWORD_HASH_VERSION, nextEpoch, user.id);
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, user.id);
        return user.id;
    });
    if (!userId) return { ok: false, status: 400, error: 'This reset link is invalid or expired.' };
    destroyUserSessions(userId);
    recordAudit('password_reset_completed', { actorUserId: userId });
    return { ok: true };
}

module.exports = {
    RESET_TTL_MS,
    GENERIC_MESSAGE,
    MAIL_NOT_SENT,
    requestPasswordReset,
    completePasswordReset
};
