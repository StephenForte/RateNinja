const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { PASSWORD_HASH_VERSION } = require('./constants');
const { hashPassword, validatePassword, verifyPassword } = require('./passwords');
const {
    companyForUser,
    getUserById,
    getUserCredentials,
    savePasswordHash,
    setUserDisabled,
    setUserEmail,
    insertUserRow,
    updateUserDisplayName,
    setUserCompanyRole,
    userIdForLogin
} = require('./store');
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

function parseDisplayName(value) {
    if (typeof value !== 'string') return { error: 'Enter a display name.' };
    const text = value.trim();
    if (!text) return { error: 'Enter a display name.' };
    if (text.length > 200) return { error: 'Display name must be 200 characters or fewer.' };
    return { text };
}

function parseLoginName(value) {
    if (typeof value !== 'string') return { error: 'Enter a login name.' };
    const text = value.trim();
    if (!text) return { error: 'Enter a login name.' };
    if (text.length > 254) return { error: 'Login name must be 254 characters or fewer.' };
    if (/[\s\u0000-\u001f]/.test(text)) return { error: 'Login name cannot contain spaces.' };
    return { text };
}

function loginConflict(error) {
    const message = String(error && error.message || '');
    return /UNIQUE/i.test(message);
}

function setDisplayNameById(userId, value, actorUserId, scopeCompanyId) {
    const user = getUserById(userId);
    if (!user || !targetInScope(user, scopeCompanyId)) return { ok: false, status: 404, error: 'User was not found.' };
    const parsed = parseDisplayName(value);
    if (parsed.error) return { ok: false, status: 400, error: parsed.error };
    updateUserDisplayName(userId, parsed.text);
    recordAudit('user_display_name_set', { actorUserId, detail: { targetUserId: userId } });
    return { ok: true, displayName: parsed.text };
}

function setCompanyRole(userId, role, actorUserId, scopeCompanyId) {
    const user = getUserById(userId);
    if (!user || !targetInScope(user, scopeCompanyId)) return { ok: false, status: 404, error: 'User was not found.' };
    if (role !== 'member' && role !== 'company_admin') {
        return { ok: false, status: 400, error: 'Role must be member or company administrator.' };
    }
    const row = roleRow(userId);
    if (!row) return { ok: false, status: 404, error: 'User was not found.' };
    if (row.company_role === role) return { ok: true, role };
    if (row.company_role === 'company_admin' && lastActiveCompanyAdmin(row)) {
        return { ok: false, status: 409, error: 'The last active company administrator cannot be demoted.' };
    }
    setUserCompanyRole(userId, role);
    destroyUserSessions(userId);
    recordAudit('user_role_changed', { actorUserId, detail: { targetUserId: userId, role } });
    return { ok: true, role };
}

function createCompanyUser(input, actorUserId, company) {
    if (!company?.id) return { ok: false, status: 409, code: 'company_context_required', error: 'Select a company before administering it.' };
    const name = parseDisplayName(input && input.displayName);
    if (name.error) return { ok: false, status: 400, error: name.error };
    const parsedEmail = normalizeEmail(input && input.email);
    if (parsedEmail.error || !parsedEmail.email) {
        return { ok: false, status: 400, error: parsedEmail.error || 'Enter a valid email address.' };
    }
    const loginSource = input && typeof input.loginName === 'string' && input.loginName.trim()
        ? input.loginName
        : parsedEmail.email;
    const login = parseLoginName(loginSource);
    if (login.error) return { ok: false, status: 400, error: login.error };
    const role = input && input.role;
    if (role !== 'member' && role !== 'company_admin') {
        return { ok: false, status: 400, error: 'Role must be member or company administrator.' };
    }
    const problem = validatePassword(input && input.temporaryPassword);
    if (problem) return { ok: false, status: 400, error: problem };
    const passwordHash = hashPassword(input.temporaryPassword);
    try {
        const created = transaction(() => {
            if (userIdForLogin(login.text)) {
                const error = new Error('That login name is already in use.');
                error.refusal = true;
                error.status = 400;
                throw error;
            }
            const id = crypto.randomUUID();
            insertUserRow({
                id,
                username: login.text,
                displayName: name.text,
                companyRecordId: company.id,
                companyBusinessId: company.fields?.CompanyID || company.id,
                rateView: company.fields?.RateView || company.id,
                adminScreen: role === 'company_admin',
                companyRole: role,
                email: parsedEmail.email,
                passwordHash,
                passwordHashVersion: PASSWORD_HASH_VERSION,
                mustChangePassword: true
            });
            markTemporaryPassword(id, actorUserId);
            recordAudit('user_created', { actorUserId, detail: { targetUserId: id, role } });
            return {
                id,
                displayName: name.text,
                loginName: login.text,
                email: parsedEmail.email,
                role,
                active: true,
                twoFactorEnrolled: false
            };
        });
        return { ok: true, user: created };
    } catch (error) {
        if (error.refusal) return { ok: false, status: error.status, error: error.message };
        if (loginConflict(error)) return { ok: false, status: 400, error: 'That login name is already in use.' };
        throw error;
    }
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
        const revokedAt = Date.now();
        transaction(() => {
            setUserDisabled(userId, true);
            invalidateLoginChallenges(userId);
            db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(revokedAt, userId);
            require('./oauth').revokeAllCredentialsForUser(userId, revokedAt);
        });
    } else {
        // Reactivation restores the login flag only. Grants, refresh tokens, and reset links stay revoked.
        setUserDisabled(userId, false);
    }
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
    changeOwnPassword,
    normalizeEmail,
    setDisplayNameById,
    setCompanyRole,
    createCompanyUser
};
