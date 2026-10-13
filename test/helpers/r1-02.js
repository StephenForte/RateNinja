'use strict';

const { COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER } = require('../../lib/constants');

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

function sessionToken(cookie) {
    const pair = String(cookie || '').split(';')[0];
    const separator = pair.indexOf('=');
    return separator === -1 ? '' : decodeURIComponent(pair.slice(separator + 1));
}

async function login(baseUrl, username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    if (response.status !== 200 || !body.csrfToken) {
        throw new Error(`Login failed for ${username} (${response.status}): ${JSON.stringify(body)}`);
    }
    return { cookie: cookieHeader(response), csrf: body.csrfToken, user: body.user };
}

async function call(baseUrl, session, method, urlPath, body) {
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };
    const options = { method, headers };
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(urlPath, baseUrl), options);
    const text = await response.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { raw: text };
        }
    }
    return { status: response.status, json };
}

function utcDay(offset) {
    const date = new Date();
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
}

function insertCompany(db, { id, name, type }) {
    const owner = type === COMPANY_TYPE_CONTRACT_OWNER;
    const typeId = owner ? 'contract_owner' : 'freight_forwarder_customer';
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, `${id}-biz`, name, type, typeId, id, owner ? 1 : 0);
}

function insertUser(db, { id, username, companyId, role = 'member', systemAdmin = false, displayName }) {
    db.prepare(`
        INSERT INTO users (
            id, username, display_name, company_id, company_reference, company_record_id,
            admin_screen, company_role, is_system_admin, disabled, session_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
        id,
        username,
        displayName || username,
        `${companyId}-biz`,
        companyId,
        companyId,
        role === 'company_admin' ? 1 : 0,
        role,
        systemAdmin ? 1 : 0
    );
}

function userRow(db, id) {
    return db.prepare(`
        SELECT email, disabled, session_epoch, password_hash, totp_enabled, totp_secret,
               company_role, is_system_admin, admin_screen, company_record_id
        FROM users WHERE id = ?
    `).get(id);
}

module.exports = {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    cookieHeader,
    sessionToken,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    userRow
};
