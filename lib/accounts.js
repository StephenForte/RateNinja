const { db, transaction } = require('./db');
const { PASSWORD_HASH_VERSION } = require('./constants');
const { hashPassword, validatePassword, verifyPassword } = require('./passwords');
const { companyForUser, getUserById, getUserCredentials, savePasswordHash, setUserDisabled, setUserEmail } = require('./store');
const { destroyUserSessions } = require('./session');
const { invalidateLoginChallenges } = require('./mfa');
const { recordAudit } = require('./audit');
const { isLimited, recordFailure, clearFailures } = require('./throttle');

function targetInScope(user, scopeCompanyId) {
    if (!user || !scopeCompanyId) return false;
    const company = companyForUser(user);
    return Boolean(company && company.id === scopeCompanyId);
}

function roleRow(userId) {
    return db.prepare('SELECT company_role, is_system_admin, company_record_id, disabled FROM users WHERE id = ?').get(userId);
}

function lastActiveSystemAdmin(row) {
    if (!row || row.is_system_admin !== 1 || row.disabled === 1) return false;
    const count = db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE is_system_admin = 1 AND disabled = 0
    `).get().count;
    return count <= 1;
}

function lastActiveCompanyAdmin(row) {
    if (!row || row.company_role !== 'company_admin' || row.disabled === 1) return false;
    if (!row.company_record_id) return true;
    const count = db.prepare(`
        SELECT COUNT(*) AS count FROM users
        WHERE company_record_id = ? AND company_role = 'company_admin' AND disabled = 0
    `).get(row.company_record_id).count;
    return count <= 1;
}

function applyPassword(user, password, actorUserId) {
    const problem = validatePassword(password);
    if (problem) return { ok: false, status: 400, error: problem };
    const sessionEpoch = savePasswordHash(user.id, hashPassword(password), PASSWORD_HASH_VERSION);
    invalidateLoginChallenges(user.id);
    destroyUserSessions(user.id);
    recordAudit('password_set', { actorUserId: actorUserId || user.id, detail: { targetUserId: user.id } });
    return { ok: true, sessionEpoch };
}

function setPasswordById(userId, password, actorUserId, scopeCompanyId) {
    const user = getUserById(userId);
    if (!user || !targetInScope(user, scopeCompanyId)) return { ok: false, status: 404, error: 'User was not found.' };
    return applyPassword(user, password, actorUserId);
}

function setPasswordByUsername(username, password) {
    const user = getUserCredentials(username);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    return applyPassword(user, password, user.id);
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return { error: 'Enter a valid email address.' };
    const email = value.trim().toLowerCase();
    if (!email) return { email: '' };
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: 'Enter a valid email address.' };
    }
    return { email };
}

function setEmailById(userId, value, actorUserId, scopeCompanyId) {
    const user = getUserById(userId);
    if (!user || !targetInScope(user, scopeCompanyId)) return { ok: false, status: 404, error: 'User was not found.' };
    const parsed = normalizeEmail(value);
    if (parsed.error) return { ok: false, status: 400, error: parsed.error };
    setUserEmail(userId, parsed.email);
    recordAudit('user_email_set', { actorUserId, detail: { targetUserId: userId, emailSet: Boolean(parsed.email) } });
    return { ok: true };
}

function passwordChangeRequired(userId) {
    if (!userId) return false;
    const row = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(userId);
    return row?.must_change_password === 1;
}

function markTemporaryPassword(userId, actorUserId) {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(userId);
    recordAudit('temporary_password_set', {
        actorUserId: actorUserId || null,
        detail: { targetUserId: userId }
    });
}

function changeOwnPassword(userId, input, context = {}) {
    const username = typeof context.username === 'string' ? context.username : '';
    const source = context.source || 'unknown';
    const loginName = username || getUserById(userId)?.username || '';
    if (loginName && isLimited(loginName, source)) {
        recordAudit('login_throttled', { actorUserId: userId, detail: { username: loginName } });
        return { ok: false, status: 429, error: 'Too many attempts. Try again later.' };
    }
    const user = getUserById(userId);
    if (!user || user.disabled) return { ok: false, status: 401, error: 'Please sign in to continue.' };
    const currentPassword = input && input.currentPassword;
    const currentOk = typeof currentPassword === 'string'
        && Boolean(user.passwordHash)
        && verifyPassword(user.passwordHash, currentPassword);
    if (!currentOk) {
        recordFailure(loginName || user.username, source);
        return {
            ok: false,
            status: 400,
            field: 'currentPassword',
            error: 'Current password is incorrect.'
        };
    }
    const newPassword = input && input.newPassword;
    const confirmPassword = input && input.confirmPassword;
    if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string' || newPassword !== confirmPassword) {
        return {
            ok: false,
            status: 400,
            field: 'confirmPassword',
            error: 'New password and confirmation do not match.'
        };
    }
    const problem = validatePassword(newPassword);
    if (problem) return { ok: false, status: 400, field: 'newPassword', error: problem };
    if (newPassword === currentPassword) {
        return {
            ok: false,
            status: 400,
            field: 'newPassword',
            error: 'Password must be different from the password you are replacing.'
        };
    }
    const changedAt = new Date().toISOString();
    transaction(() => {
        savePasswordHash(user.id, hashPassword(newPassword), PASSWORD_HASH_VERSION);
        db.prepare('UPDATE users SET must_change_password = 0, password_changed_at = ? WHERE id = ?').run(changedAt, user.id);
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), user.id);
        invalidateLoginChallenges(user.id);
    });
    destroyUserSessions(user.id);
    clearFailures(loginName || user.username, source);
    recordAudit('password_changed', { actorUserId: user.id, detail: { targetUserId: user.id } });
    return { ok: true, signInAgain: true };
}

function setDisabled(userId, disabled, actorUserId, scopeCompanyId) {
    const user = getUserById(userId);
    if (!user || !targetInScope(user, scopeCompanyId)) return { ok: false, status: 404, error: 'User was not found.' };
    if (userId === actorUserId && disabled) return { ok: false, status: 400, error: 'You cannot disable your own account.' };
    if (disabled) {
        const row = roleRow(userId);
        if (lastActiveSystemAdmin(row)) {
            return { ok: false, status: 409, error: 'The last active system administrator cannot be deactivated.' };
        }
        if (lastActiveCompanyAdmin(row)) {
            return { ok: false, status: 409, error: 'The last active company administrator cannot be deactivated.' };
        }
    }
    setUserDisabled(userId, disabled);
    destroyUserSessions(userId);
    recordAudit('user_disabled', { actorUserId, detail: { targetUserId: userId, disabled: Boolean(disabled) } });
    return { ok: true };
}

module.exports = {
    setPasswordById,
    setPasswordByUsername,
    setEmailById,
    setDisabled,
    passwordChangeRequired,
    markTemporaryPassword,
    changeOwnPassword
};
