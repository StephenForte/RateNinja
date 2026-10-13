'use strict';

const { PASSWORD } = require('./r1-12');

function ymd(offsetDays) {
    const now = new Date();
    const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
    return utc.toISOString().slice(0, 10);
}

function cookieHeader(response) {
    return (response.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
}

async function login(baseUrl, username, password = PASSWORD) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    if (response.status !== 200) {
        throw new Error(`Login failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return { cookie: cookieHeader(response), csrf: body.csrfToken, user: body.user };
}

async function authed(baseUrl, session, path, options = {}) {
    const method = options.method || 'GET';
    const headers = new Headers(options.headers || {});
    if (session?.cookie) headers.set('cookie', session.cookie);
    if (options.body) headers.set('content-type', 'application/json');
    const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (unsafe && options.csrf !== false && session?.csrf) headers.set('x-csrf-token', session.csrf);
    const response = await fetch(new URL(path, baseUrl), {
        method,
        headers,
        body: options.body
    });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: response.status, body, text };
}

function ratePatch(companyId, version, extra = {}) {
    return {
        originPort: 'SHA',
        destinationPort: 'LAX',
        carrier: 'MSC',
        rateEffectiveDate: '2026-04-01',
        rateExpirationDate: '2026-10-01',
        rate20D: null,
        rate40D: null,
        rate40HC: 100,
        expectedRowVersion: version,
        companyId,
        ...extra
    };
}

module.exports = {
    PASSWORD,
    ymd,
    cookieHeader,
    login,
    authed,
    ratePatch
};
