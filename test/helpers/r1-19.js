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

function insertRate(db, {
    id,
    owner,
    carrier = 'MSC',
    origin = 'SHA',
    destination = 'LAX',
    contractOwner = 'Kings',
    contractNumber = null,
    rate20 = 1000,
    rate40 = 1800,
    rate40hc = 1900,
    effective = '2026-04-01',
    expiration = null,
    notes = null
}) {
    db.prepare(`
        INSERT INTO rates (
            id, carrier, origin_port, destination_port, contract_owner, contract_number,
            rate_20d, rate_40d, rate_40hc, rate_effective_date, rate_expiration_date, notes_1,
            owner_company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, carrier, origin, destination, contractOwner, contractNumber, rate20, rate40, rate40hc, effective, expiration, notes, owner);
}

function insertMargin(db, { id, owner, customer, percent, number = 0, status = 'active' }) {
    db.prepare(`
        INSERT INTO company_margins (
            id, owner_company_id, customer_company_id, margin_percent, margin_number,
            created_at, updated_at, status, authorized_at
        ) VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')
    `).run(id, owner, customer, percent, number, status);
}

function activate(username, password = PASSWORD) {
    const { setPasswordByUsername } = require('../../lib/accounts');
    const set = setPasswordByUsername(username, password);
    if (!set.ok) throw new Error(set.error || `Could not set a password for ${username}.`);
}

module.exports = {
    PASSWORD,
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    login,
    call,
    utcDay,
    insertCompany,
    insertUser,
    insertRate,
    insertMargin,
    activate
};
