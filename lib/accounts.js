const { PASSWORD_HASH_VERSION } = require('./constants');
const { hashPassword, validatePassword } = require('./passwords');
const { getUserById, getUserCredentials, savePasswordHash, setUserDisabled } = require('./store');
const { destroyUserSessions } = require('./session');
const { recordAudit } = require('./audit');

function applyPassword(user, password, actorUserId) {
    const problem = validatePassword(password);
    if (problem) return { ok: false, status: 400, error: problem };
    const sessionEpoch = savePasswordHash(user.id, hashPassword(password), PASSWORD_HASH_VERSION);
    destroyUserSessions(user.id);
    recordAudit('password_set', { actorUserId: actorUserId || user.id, detail: { targetUserId: user.id } });
    return { ok: true, sessionEpoch };
}

function setPasswordById(userId, password, actorUserId) {
    const user = getUserById(userId);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    return applyPassword(user, password, actorUserId);
}

function setPasswordByUsername(username, password) {
    const user = getUserCredentials(username);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    return applyPassword(user, password, user.id);
}

function setDisabled(userId, disabled, actorUserId) {
    const user = getUserById(userId);
    if (!user) return { ok: false, status: 404, error: 'User was not found.' };
    if (userId === actorUserId && disabled) return { ok: false, status: 400, error: 'You cannot disable your own account.' };
    setUserDisabled(userId, disabled);
    destroyUserSessions(userId);
    recordAudit('user_disabled', { actorUserId, detail: { targetUserId: userId, disabled: Boolean(disabled) } });
    return { ok: true };
}

module.exports = {
    setPasswordById,
    setPasswordByUsername,
    setDisabled
};
