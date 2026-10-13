'use strict';

const crypto = require('node:crypto');

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, state: crypto.randomBytes(12).toString('base64url') };
}

function insertMember(db, { id, username, companyId, email = null, adminScreen = 0 }) {
    db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen,
            password_hash, password_hash_version, disabled, session_epoch, company_record_id, email
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
    `).run(id, username, username, companyId, companyId, companyId, adminScreen, companyId, email);
}

async function login(baseUrl, username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    return {
        response,
        body,
        cookie: cookieHeader(response),
        csrf: body.csrfToken || ''
    };
}

async function call(baseUrl, auth, method, urlPath, body) {
    const headers = {};
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth?.csrf && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = auth.csrf;
    const response = await fetch(new URL(urlPath, baseUrl), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return { status: response.status, json, text, headers: response.headers };
}

function auditContainsSecret(db, secrets) {
    const rows = db.prepare('SELECT detail FROM audit_events').all();
    return secrets.some(secret => secret && rows.some(row => String(row.detail || '').includes(secret)));
}

module.exports = {
    cookieHeader,
    pkce,
    insertMember,
    login,
    call,
    auditContainsSecret
};
