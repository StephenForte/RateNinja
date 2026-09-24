const crypto = require('node:crypto');

function newCsrfToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function csrfMatches(request, session, body) {
    const header = request.headers['x-csrf-token'];
    const fromBody = body && typeof body.csrf_token === 'string' ? body.csrf_token : '';
    const supplied = typeof header === 'string' && header ? header : fromBody;
    const expected = session?.user?.csrfToken || '';
    if (!supplied || !expected || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

module.exports = {
    newCsrfToken,
    csrfMatches
};
