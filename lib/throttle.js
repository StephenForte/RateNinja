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

module.exports = {
    isLimited,
    recordFailure,
    clearFailures
};
