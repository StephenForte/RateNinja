const crypto = require('node:crypto');

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

async function login(baseUrl, username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const json = await response.json();
    return { status: response.status, json, cookie: cookieHeader(response), csrf: json.csrfToken || '' };
}

async function call(baseUrl, session, method, path, body) {
    const headers = {};
    if (session && session.cookie) headers.cookie = session.cookie;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        if (session && session.csrf) headers['x-csrf-token'] = session.csrf;
    }
    const response = await fetch(new URL(path, baseUrl), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text };
    }
    return { status: response.status, json, text };
}

function counts(db) {
    return {
        companies: db.prepare('SELECT COUNT(*) AS count FROM companies').get().count,
        users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
        margins: db.prepare('SELECT COUNT(*) AS count FROM company_margins').get().count,
        rates: db.prepare('SELECT COUNT(*) AS count FROM rates').get().count
    };
}

function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, state: crypto.randomBytes(12).toString('base64url') };
}

async function authorizeAndToken({ baseUrl, cookie, csrf, clientId, clientSecret, redirectUri, scope }) {
    const proof = pkce();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256'
    });
    const approved = await fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: csrf }),
        redirect: 'manual'
    });
    const location = approved.headers.get('location') || '';
    const code = location ? new URL(location).searchParams.get('code') : '';
    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
            code_verifier: proof.verifier
        })
    });
    const token = await tokenResponse.json();
    return { status: approved.status, tokenStatus: tokenResponse.status, token };
}

function nestedKeys(value, found = []) {
    if (Array.isArray(value)) {
        for (const item of value) nestedKeys(item, found);
        return found;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            found.push(key);
            nestedKeys(child, found);
        }
    }
    return found;
}

module.exports = {
    login,
    call,
    counts,
    authorizeAndToken,
    nestedKeys
};
