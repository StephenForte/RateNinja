const crypto = require('node:crypto');
const { db } = require('./db');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CUSTOMER_ID,
    KNOWN_COMPANIES
} = require('./constants');
const { clearPlaintextPasswords } = require('./store');
const { ensureCapacityExchangeClient } = require('./oauth');

function ensureCompany({ id, name, typeId, typeName, matchNames, forceName = false }) {
    const byId = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (byId) {
        db.prepare(`
            UPDATE companies
            SET company_type = ?, company_type_id = ?,
                company_name = CASE WHEN ? = 1 OR company_name IS NULL OR trim(company_name) = '' THEN ? ELSE company_name END
            WHERE id = ?
        `).run(typeName, typeId, forceName ? 1 : 0, name, id);
        return id;
    }
    for (const candidate of matchNames) {
        const byName = db.prepare('SELECT * FROM companies WHERE lower(company_name) = lower(?)').get(candidate);
        if (byName) {
            db.prepare('UPDATE companies SET company_type = ?, company_type_id = ? WHERE id = ?').run(typeName, typeId, byName.id);
            return byName.id;
        }
    }
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, id, name, typeName, typeId, id, typeId === COMPANY_TYPE_CONTRACT_OWNER_ID ? 1 : 0);
    return id;
}

function ensureUser({ username, displayName, companyRecordId, admin }) {
    const company = db.prepare('SELECT company_id, rate_view FROM companies WHERE id = ?').get(companyRecordId);
    const existing = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username);
    if (existing) {
        db.prepare(`
            UPDATE users
            SET display_name = ?, company_record_id = ?, company_id = ?, company_reference = ?, admin_screen = ?, rate_view = ?
            WHERE id = ?
        `).run(displayName, companyRecordId, company?.company_id || companyRecordId, companyRecordId, admin ? 1 : 0, company?.rate_view || null, existing.id);
        return existing.id;
    }
    const id = `user-${username.toLowerCase()}`;
    db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen,
            password_hash, password_hash_version, disabled, session_epoch, company_record_id
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)
    `).run(id, username, displayName, company?.rate_view || null, company?.company_id || companyRecordId, companyRecordId, admin ? 1 : 0, companyRecordId);
    return id;
}

function ensureMargin(ownerCompanyId, customerCompanyId, marginPercent, marginNumber) {
    const existing = db.prepare('SELECT id FROM company_margins WHERE owner_company_id = ? AND customer_company_id = ?').get(ownerCompanyId, customerCompanyId);
    if (existing) return;
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO company_margins (id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), ownerCompanyId, customerCompanyId, marginPercent || 0, marginNumber || 0, now, now);
}

function backfillOwners(kingsId) {
    const owners = db.prepare(`SELECT id, rate_view, company_name FROM companies WHERE company_type = ?`).all(COMPANY_TYPE_CONTRACT_OWNER);
    const rates = db.prepare(`SELECT id, rate_view FROM rates WHERE owner_company_id IS NULL OR owner_company_id = ''`).all();
    const assignRate = db.prepare('UPDATE rates SET owner_company_id = ? WHERE id = ?');
    for (const rate of rates) {
        const views = String(rate.rate_view || '').split(', ').map(value => value.trim()).filter(Boolean);
        const matched = owners.find(owner => owner.rate_view && views.includes(owner.rate_view));
        const owner = matched || (owners.length === 1 ? owners[0] : owners.find(owner => owner.id === kingsId));
        if (owner) assignRate.run(owner.id, rate.id);
    }
    if (kingsId) {
        db.prepare(`UPDATE sailings SET owner_company_id = ? WHERE owner_company_id IS NULL OR owner_company_id = ''`).run(kingsId);
    }
}

function ensureFoundation() {
    const kingsId = ensureCompany({
        ...KNOWN_COMPANIES.kings,
        typeId: COMPANY_TYPE_CONTRACT_OWNER_ID,
        typeName: COMPANY_TYPE_CONTRACT_OWNER
    });
    const blackwaterId = ensureCompany({
        ...KNOWN_COMPANIES.blackwater,
        typeId: COMPANY_TYPE_CUSTOMER_ID,
        typeName: COMPANY_TYPE_CUSTOMER
    });
    const blueSkyId = ensureCompany({
        ...KNOWN_COMPANIES.blueSky,
        typeId: COMPANY_TYPE_CUSTOMER_ID,
        typeName: COMPANY_TYPE_CUSTOMER,
        forceName: true
    });
    ensureUser({ username: 'SteveF', displayName: 'SteveF', companyRecordId: kingsId, admin: true });
    ensureUser({ username: 'Alan', displayName: 'Alan', companyRecordId: blackwaterId, admin: false });
    ensureUser({ username: 'Bob', displayName: 'Bob', companyRecordId: blueSkyId, admin: false });
    clearPlaintextPasswords();
    backfillOwners(kingsId);

    const namedCustomers = new Set([blackwaterId, blueSkyId]);
    const customers = db.prepare(`SELECT id, margin_percent, margin_number FROM companies WHERE company_type = ?`).all(COMPANY_TYPE_CUSTOMER);
    for (const customer of customers) {
        const hasLegacyMargin = customer.margin_percent !== null || customer.margin_number !== null;
        if (!namedCustomers.has(customer.id) && !hasLegacyMargin) continue;
        ensureMargin(kingsId, customer.id, Number(customer.margin_percent) || 0, Number(customer.margin_number) || 0);
    }
    ensureCapacityExchangeClient();
    return { kingsId, blackwaterId, blueSkyId };
}

module.exports = {
    ensureFoundation
};
