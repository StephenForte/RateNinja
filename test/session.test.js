process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createSession,
    getSession,
    destroySession,
    sessionCookie,
    sweepExpiredSessions
} = require('../lib/session');

function requestWithSession(token) {
    return { headers: { cookie: `rate_ninja_session=${encodeURIComponent(token)}` } };
}

describe('session helpers', () => {
    it('creates a signed cookie session that getSession can read', () => {
        const token = createSession({ username: 'Ada', isAdmin: true });
        const session = getSession(requestWithSession(token));
        assert.equal(session.user.username, 'Ada');
        assert.equal(session.user.isAdmin, true);
        assert.equal(session.token, token);
        destroySession(token);
    });

    it('returns null for missing or destroyed sessions', () => {
        assert.equal(getSession({ headers: {} }), null);
        assert.equal(getSession({ headers: { cookie: 'rate_ninja_session=not-a-real-token' } }), null);

        const token = createSession({ username: 'Temp' });
        destroySession(token);
        assert.equal(getSession(requestWithSession(token)), null);
    });

    it('sweepExpiredSessions is safe to call', () => {
        const token = createSession({ username: 'Alive' });
        assert.doesNotThrow(() => sweepExpiredSessions());
        assert.ok(getSession(requestWithSession(token)));
        destroySession(token);
    });

    it('builds an HttpOnly session cookie', () => {
        const cookie = sessionCookie('abc.def', 120);
        assert.match(cookie, /^rate_ninja_session=abc\.def;/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.match(cookie, /Max-Age=120/);
    });
});
