'use strict';

const { COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER } = require('../../lib/constants');

const PASSWORD = 'sail-the-ocean';

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

async function login(baseUrl, username, password = PASSWORD) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    if (response.status !== 200 || !body.csrfToken) {
        throw new Error(`Login failed for ${username} (${response.status}): ${JSON.stringify(body)}`);
    }
    return { cookie: cookieHeader(response), csrf: body.csrfToken, user: body.user, username };
}

async function call(baseUrl, session, method, urlPath, body, options = {}) {
    const headers = {};
    if (session) headers.cookie = session.cookie;
    if (session && options.csrf !== false) headers['x-csrf-token'] = session.csrf;
    const init = { method, headers };
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(urlPath, baseUrl), init);
    const text = await response.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { raw: text };
        }
    }
    return { status: response.status, json, text };
}

function insertCompany(db, { id, name, type }) {
    const owner = type === COMPANY_TYPE_CONTRACT_OWNER;
    const typeId = owner ? 'contract_owner' : 'freight_forwarder_customer';
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, id, name, type, typeId, id, owner ? 1 : 0);
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
        companyId,
        companyId,
        companyId,
        role === 'company_admin' ? 1 : 0,
        role,
        systemAdmin ? 1 : 0
    );
}

function insertRate(db, { id, owner, origin, destination, deletedAt = null }) {
    db.prepare(`
        INSERT INTO rates (
            id, carrier, origin_port, destination_port, rate_20d, owner_company_id, deleted_at, row_version
        ) VALUES (?, 'MSC', ?, ?, 1000, ?, ?, 1)
    `).run(id, origin, destination, owner, deletedAt);
}

function insertSailing(db, { id, owner, departurePort, arrivalPort, deletedAt = null }) {
    db.prepare(`
        INSERT INTO sailings (
            id, carrier, departure_port, arrival_port, owner_company_id, deleted_at, row_version
        ) VALUES (?, 'MSC', ?, ?, ?, ?, 1)
    `).run(id, departurePort, arrivalPort, owner, deletedAt);
}

function activate(username, password = PASSWORD) {
    const { setPasswordByUsername } = require('../../lib/accounts');
    const set = setPasswordByUsername(username, password);
    if (!set.ok) throw new Error(set.error || `Could not set a password for ${username}.`);
}

function ratesSailingsChecksum(database) {
    const rates = database.prepare(`
        SELECT id, origin_port, destination_port, deleted_at, row_version
        FROM rates ORDER BY id
    `).all();
    const sailings = database.prepare(`
        SELECT id, departure_port, arrival_port, deleted_at, row_version
        FROM sailings ORDER BY id
    `).all();
    return JSON.stringify({ rates, sailings });
}

module.exports = {
    PASSWORD,
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    insertCompany,
    insertUser,
    insertRate,
    insertSailing,
    activate,
    ratesSailingsChecksum
};
