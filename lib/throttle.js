const { LOGIN_MAX_FAILURES, LOGIN_IP_MAX_FAILURES, LOGIN_WINDOW_MS } = require('./config');

const attempts = new Map();

function prune(list, now) {
    return list.filter(timestamp => now - timestamp < LOGIN_WINDOW_MS);
}

function userKey(username) {
    return `u:${String(username || '').trim().toLowerCase()}`;
}

function sourceKey(source) {
    return `s:${source || 'unknown'}`;
}

function isLimited(username, source) {
    const now = Date.now();
    const userHits = prune(attempts.get(userKey(username)) || [], now);
    const sourceHits = prune(attempts.get(sourceKey(source)) || [], now);
    attempts.set(userKey(username), userHits);
    attempts.set(sourceKey(source), sourceHits);
    return userHits.length >= LOGIN_MAX_FAILURES || sourceHits.length >= LOGIN_IP_MAX_FAILURES;
}

function recordFailure(username, source) {
    const now = Date.now();
    for (const key of [userKey(username), sourceKey(source)]) {
        const list = prune(attempts.get(key) || [], now);
        list.push(now);
        attempts.set(key, list);
    }
}

function clearFailures(username, source) {
    attempts.delete(userKey(username));
    attempts.delete(sourceKey(source));
}

function mfaUserKey(username) {
    return `mfa:u:${String(username || '').trim().toLowerCase()}`;
}

function mfaSourceKey(source) {
    return `mfa:s:${source || 'unknown'}`;
}

function mfaLimited(username, source) {
    const now = Date.now();
    const userHits = prune(attempts.get(mfaUserKey(username)) || [], now);
    const sourceHits = prune(attempts.get(mfaSourceKey(source)) || [], now);
    attempts.set(mfaUserKey(username), userHits);
    attempts.set(mfaSourceKey(source), sourceHits);
    return userHits.length >= LOGIN_MAX_FAILURES || sourceHits.length >= LOGIN_IP_MAX_FAILURES;
}

function recordMfaFailure(username, source) {
    const now = Date.now();
    for (const key of [mfaUserKey(username), mfaSourceKey(source)]) {
        const list = prune(attempts.get(key) || [], now);
        list.push(now);
        attempts.set(key, list);
    }
}

function clearMfaFailures(username, source) {
    attempts.delete(mfaUserKey(username));
    attempts.delete(mfaSourceKey(source));
}

function clearMfaUserFailures(username) {
    attempts.delete(mfaUserKey(username));
}

module.exports = {
    isLimited,
    recordFailure,
    clearFailures,
    mfaLimited,
    recordMfaFailure,
    clearMfaFailures,
    clearMfaUserFailures
};
