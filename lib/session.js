const crypto = require('node:crypto');
const { SESSION_TTL_MS, config } = require('./config');

const sessions = new Map();
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function getCookies(request) {
    return Object.fromEntries((request.headers.cookie || '').split(';').map(value => {
        const separator = value.indexOf('=');
        return separator === -1 ? [] : [value.slice(0, separator).trim(), decodeURIComponent(value.slice(separator + 1))];
    }).filter(entry => entry.length));
}

function getSession(request) {
    const token = getCookies(request).rate_ninja_session;
    const session = token && sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return null;
    }
    return { token, ...session };
}

function createSession(user) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(nonce).digest('base64url');
    const token = `${nonce}.${signature}`;
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function sessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `rate_ninja_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function sweepExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (session.expiresAt < now) sessions.delete(token);
    }
}

function startSessionSweep() {
    const timer = setInterval(sweepExpiredSessions, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = {
    getSession,
    createSession,
    destroySession,
    sessionCookie,
    sweepExpiredSessions,
    startSessionSweep
};
