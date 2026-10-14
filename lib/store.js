const crypto = require('node:crypto');
const { db } = require('./db');
const { mapSailingRecord } = require('./domain');
const { copyWithoutOperation } = require('./pull-forward');

// Data-access layer over SQLite. Every read returns Airtable-shaped records
// ({ id, fields: { ...exact Airtable field names } }) so lib/domain.js mappers
// and the server response shapes keep working unchanged. NULL columns are left
// out of `fields` so normalizeValue fallbacks ('N/A', '') still apply.

function assign(fields, name, value) {
    if (value !== null && value !== undefined) fields[name] = value;
}

function splitRateView(value) {
    if (value === null || value === undefined) return undefined;
    // Migration joins Airtable's multi-value RateView with ', '; rebuild the
    // array so rateVisibleToView's asArray().some() matching works unchanged.
    return String(value).split(', ');
}

function rateRecord(row) {
    const fields = {};
    assign(fields, 'Rate Type', row.rate_type);
    assign(fields, 'Origin Port', row.origin_port);
    assign(fields, 'Destination Port/Via Port', row.destination_port);
    assign(fields, 'Inland Delivery Location', row.inland_delivery_location);
    assign(fields, 'CommodityType', row.commodity_type);
    assign(fields, 'Carrier', row.carrier);
    assign(fields, 'Contract Owner', row.contract_owner);
    assign(fields, '20D Rate', row.rate_20d);
    assign(fields, '40D rate', row.rate_40d);
    assign(fields, '40HC Rate', row.rate_40hc);
    assign(fields, 'Rate Effective Date', row.rate_effective_date);
    assign(fields, 'Rate Expiration Date', row.rate_expiration_date);
    assign(fields, 'Notes 1', row.notes_1);
    assign(fields, 'RateView', splitRateView(row.rate_view));
    return { id: row.id, ownerCompanyId: row.owner_company_id || null, fields };
}

function companyTypeName(typeId) {
    if (!typeId) return null;
    const row = db.prepare('SELECT name FROM company_types WHERE id = ?').get(typeId);
    return row ? row.name : null;
}

function companyRecord(row) {
    const fields = {};
    assign(fields, 'CompanyID', row.company_id);
    assign(fields, 'CompanyName', row.company_name);
    assign(fields, 'CompanyType', companyTypeName(row.company_type_id) || row.company_type);
    assign(fields, 'RateView', row.rate_view);
    if (row.admin !== null && row.admin !== undefined) fields.Admin = row.admin === 1;
    assign(fields, 'MarginPercent', row.margin_percent);
    assign(fields, 'MarginNumber', row.margin_number);
    return { id: row.id, fields };
}

function userRecord(row) {
    const fields = {};
    assign(fields, 'UserName', row.username);
    assign(fields, 'DisplayName', row.display_name);
    assign(fields, 'RateView', row.rate_view);
    assign(fields, 'CompanyID (from CompanyReference)', row.company_id);
    assign(fields, 'CompanyReference', row.company_reference);
    fields.AdminScreen = row.admin_screen === 1;
    fields.Disabled = row.disabled === 1;
    return { id: row.id, companyRecordId: row.company_record_id || null, fields };
}

function credentialsFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        passwordHash: row.password_hash || null,
        disabled: row.disabled === 1,
        sessionEpoch: Number(row.session_epoch) || 0,
        rateView: row.rate_view,
        companyId: row.company_id,
        companyReference: row.company_reference || null,
        companyRecordId: row.company_record_id || null,
        adminScreen: row.admin_screen === 1,
        email: row.email || '',
        totpEnabled: row.totp_enabled === 1
    };
}

function resolveCompanyForCredentials(user) {
    if (!user) return null;
    const seen = new Set();
    const candidates = [user.companyRecordId, user.companyReference, user.companyId];
    for (const value of candidates) {
        for (const part of String(value || '').split(',')) {
            const key = part.trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const byRecord = getCompanyByRecordId(key);
            if (byRecord) return byRecord;
            const byBusinessId = getCompanyByCompanyId(key);
            if (byBusinessId) return byBusinessId;
        }
    }
    return null;
}

function companyForUser(user) {
    const company = resolveCompanyForCredentials(user);
    if (company && user?.id && !user.companyRecordId) {
        db.prepare(`
            UPDATE users
            SET company_record_id = ?
            WHERE id = ? AND (company_record_id IS NULL OR company_record_id = '')
        `).run(company.id, user.id);
    }
    return company;
}

function linkUserCompanies() {
    const rows = db.prepare('SELECT * FROM users WHERE company_record_id IS NULL OR company_record_id = \'\'').all();
    for (const row of rows) companyForUser(credentialsFromRow(row));
}

function sailingFields(row) {
    const fields = {};
    assign(fields, 'Departure', row.departure);
    assign(fields, 'Arrival', row.arrival);
    assign(fields, 'TransitTime', row.transit_time);
    assign(fields, 'Vessel', row.vessel);
    assign(fields, 'Voyage', row.voyage);
    assign(fields, 'Service', row.service);
    return fields;
}

// Hot statements prepared once and reused for every request.
const statements = {
    allRates: db.prepare('SELECT * FROM rates WHERE deleted_at IS NULL'),
    ratesForView: db.prepare(`
        SELECT * FROM rates
        WHERE deleted_at IS NULL
          AND (
            rate_view = ?
            OR rate_view LIKE ? || ', %'
            OR rate_view LIKE '%, ' || ?
            OR rate_view LIKE '%, ' || ? || ', %'
          )
    `),
    ratesByCarrierOrigin: db.prepare('SELECT * FROM rates WHERE carrier = ? AND origin_port = ? AND deleted_at IS NULL'),
    allCompanies: db.prepare('SELECT * FROM companies'),
    userByUsername: db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    companyByRecordId: db.prepare('SELECT * FROM companies WHERE id = ?'),
    companyByCompanyId: db.prepare('SELECT * FROM companies WHERE company_id = ?'),
    sailings: db.prepare(`
        SELECT * FROM sailings
        WHERE carrier = ? AND departure_port = ? AND departure > ? AND deleted_at IS NULL
        ORDER BY departure ASC
    `),
    updateMargins: db.prepare('UPDATE companies SET margin_percent = ?, margin_number = ? WHERE id = ?')
};

function getAllRates() {
    return statements.allRates.all().map(rateRecord);
}

function getRatesForView(rateView) {
    const view = String(rateView ?? '');
    return statements.ratesForView.all(view, view, view, view).map(rateRecord);
}

function getRatesByCarrierOrigin(carrier, originPort) {
    return statements.ratesByCarrierOrigin.all(carrier, originPort).map(rateRecord);
}

function getAllCompanies() {
    return statements.allCompanies.all().map(companyRecord);
}

function getUserByUsername(username) {
    const row = statements.userByUsername.get(username);
    return row ? userRecord(row) : null;
}

function getUserCredentials(username) {
    return credentialsFromRow(statements.userByUsername.get(username));
}

function getUserById(id) {
    return credentialsFromRow(statements.userById.get(id));
}

function getCompanyByRecordId(id) {
    const row = statements.companyByRecordId.get(id);
    return row ? companyRecord(row) : null;
}

function getCompanyByCompanyId(companyId) {
    const row = statements.companyByCompanyId.get(String(companyId ?? ''));
    return row ? companyRecord(row) : null;
}

function getSailings({ carrier, originPort, after }) {
    return statements.sailings.all(carrier, originPort, after).map(row => mapSailingRecord({ id: row.id, fields: sailingFields(row) }));
}

function getSailingsForOwners(ownerIds, { carrier = '', originPort = '', after = '' } = {}) {
    if (!ownerIds.length) return [];
    const placeholders = ownerIds.map(() => '?').join(', ');
    const clauses = [`owner_company_id IN (${placeholders})`, 'deleted_at IS NULL'];
    const params = [...ownerIds];
    if (carrier) {
        clauses.push('lower(carrier) = lower(?)');
        params.push(carrier);
    }
    if (originPort) {
        clauses.push('lower(departure_port) = lower(?)');
        params.push(originPort);
    }
    if (after) {
        clauses.push('departure > ?');
        params.push(after);
    }
    const rows = db.prepare(`SELECT * FROM sailings WHERE ${clauses.join(' AND ')} ORDER BY departure ASC`).all(...params);
    return rows.map(row => mapSailingRecord({ id: row.id, ownerCompanyId: row.owner_company_id, fields: sailingFields(row) }));
}

function updateCompanyMargins(id, { marginPercent, marginNumber }) {
    statements.updateMargins.run(marginPercent, marginNumber, id);
}

function likePattern(value) {
    return `%${String(value).toLowerCase()}%`;
}

// Case-insensitive substring filters matching the previous JS matchesSearch()
// semantics, with COUNT + LIMIT/OFFSET so pagination does not scan/map all rows.
function queryPublicRates({ carrier = '', originPort = '', destinationPort = '', page = 1, pageSize = 50 }) {
    const clauses = ['deleted_at IS NULL'];
    const params = [];
    if (carrier) {
        clauses.push('lower(carrier) LIKE ?');
        params.push(likePattern(carrier));
    }
    if (originPort) {
        clauses.push('lower(origin_port) LIKE ?');
        params.push(likePattern(originPort));
    }
    if (destinationPort) {
        clauses.push('lower(destination_port) LIKE ?');
        params.push(likePattern(destinationPort));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM rates ${where}`).get(...params).count);
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(`SELECT * FROM rates ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return {
        rates: rows.map(rateRecord),
        total
    };
}

// Historical entry point used by the store unit test. HTTP pull-forward records
// a data operation in lib/pull-forward.js. deleteExisting soft-deletes live rows
// in the target window; it does not remove them from the table.
function pullForwardRates({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, priceIncreasePercent, deleteExisting, ownerCompanyId }) {
    return copyWithoutOperation({
        dataset: 'rates',
        ownerCompanyId: ownerCompanyId || null,
        sourceStart,
        sourceEnd,
        targetStart,
        targetEnd,
        offsetDays,
        priceIncreasePercent,
        conflict: deleteExisting === true ? 'replace' : 'keep'
    });
}

function pullForwardSailings({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, deleteExisting, ownerCompanyId }) {
    return copyWithoutOperation({
        dataset: 'sailings',
        ownerCompanyId: ownerCompanyId || null,
        sourceStart,
        sourceEnd,
        targetStart,
        targetEnd,
        offsetDays,
        conflict: deleteExisting === true ? 'replace' : 'keep'
    });
}

function getRatesByOwner(ownerCompanyId) {
    return db.prepare('SELECT * FROM rates WHERE owner_company_id = ? AND deleted_at IS NULL').all(ownerCompanyId).map(rateRecord);
}

function queryPartnerRates(ownerCompanyId, { carrier = '', originPort = '', destinationPort = '', effectiveDate = '', page = 1, pageSize = 50 } = {}) {
    const clauses = ['owner_company_id = ?', 'deleted_at IS NULL'];
    const params = [ownerCompanyId];
    if (carrier) {
        clauses.push('lower(carrier) = lower(?)');
        params.push(carrier);
    }
    if (originPort) {
        clauses.push('lower(origin_port) = lower(?)');
        params.push(originPort);
    }
    if (destinationPort) {
        clauses.push('lower(destination_port) = lower(?)');
        params.push(destinationPort);
    }
    if (effectiveDate) {
        clauses.push(`rate_effective_date <= ? AND (rate_expiration_date IS NULL OR rate_expiration_date = '' OR rate_expiration_date >= ?)`);
        params.push(effectiveDate, effectiveDate);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM rates ${where}`).get(...params).count);
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(`SELECT * FROM rates ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return { rates: rows.map(rateRecord), total };
}

function getPartnerRate(ownerCompanyId, rateId) {
    const row = db.prepare('SELECT * FROM rates WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL').get(rateId, ownerCompanyId);
    return row ? rateRecord(row) : null;
}

function queryPartnerSailings(ownerCompanyId, { carrier = '', originPort = '', after = '', page = 1, pageSize = 50 } = {}) {
    const clauses = ['owner_company_id = ?', 'deleted_at IS NULL'];
    const params = [ownerCompanyId];
    if (carrier) {
        clauses.push('lower(carrier) = lower(?)');
        params.push(carrier);
    }
    if (originPort) {
        clauses.push('lower(departure_port) = lower(?)');
        params.push(originPort);
    }
    if (after) {
        clauses.push('departure > ?');
        params.push(after);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM sailings ${where}`).get(...params).count);
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(`SELECT * FROM sailings ${where} ORDER BY departure ASC, id LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    return { sailings: rows.map(partnerSailingRow), total };
}

function partnerSailingRow(row) {
    return {
        id: row.id,
        ownerCompanyId: row.owner_company_id,
        departure: row.departure,
        arrival: row.arrival,
        transitTime: row.transit_time,
        vessel: row.vessel,
        voyage: row.voyage,
        service: row.service,
        carrier: row.carrier,
        departurePort: row.departure_port
    };
}

function getPartnerSailing(ownerCompanyId, sailingId) {
    const row = db.prepare('SELECT * FROM sailings WHERE id = ? AND owner_company_id = ? AND deleted_at IS NULL').get(sailingId, ownerCompanyId);
    return row ? partnerSailingRow(row) : null;
}

function listMarginsForCustomer(customerCompanyId) {
    return db.prepare(`
        SELECT m.owner_company_id, m.customer_company_id, m.margin_percent, m.margin_number, c.company_name
        FROM company_margins m
        JOIN companies c ON c.id = m.owner_company_id
        WHERE m.customer_company_id = ? AND m.status = 'active'
        ORDER BY c.company_name
    `).all(customerCompanyId).map(row => ({
        ownerCompanyId: row.owner_company_id,
        ownerCompanyName: row.company_name,
        customerCompanyId: row.customer_company_id,
        marginPercent: Number(row.margin_percent) || 0,
        marginNumber: Number(row.margin_number) || 0
    }));
}

function listCustomerMarginTargets(ownerCompanyId) {
    return db.prepare(`
        SELECT c.id, c.company_name, c.company_type, m.margin_percent, m.margin_number, m.id AS margin_id
        FROM companies c
        LEFT JOIN company_margins m ON m.customer_company_id = c.id AND m.owner_company_id = ?
        WHERE c.company_type = 'Freight Forwarder/Customer'
        ORDER BY c.company_name
    `).all(ownerCompanyId).map(row => ({
        id: row.id,
        name: row.company_name,
        marginPercent: row.margin_id ? Number(row.margin_percent) || 0 : 0,
        marginNumber: row.margin_id ? Number(row.margin_number) || 0 : 0,
        linked: Boolean(row.margin_id)
    }));
}

function upsertCompanyMargin(ownerCompanyId, customerCompanyId, { marginPercent, marginNumber }) {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id FROM company_margins WHERE owner_company_id = ? AND customer_company_id = ?').get(ownerCompanyId, customerCompanyId);
    if (existing) {
        db.prepare('UPDATE company_margins SET margin_percent = ?, margin_number = ?, updated_at = ? WHERE id = ?')
            .run(marginPercent, marginNumber, now, existing.id);
        return existing.id;
    }
    const id = crypto.randomUUID();
    db.prepare(`
        INSERT INTO company_margins (
            id, owner_company_id, customer_company_id, margin_percent, margin_number,
            created_at, updated_at, status, authorized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(id, ownerCompanyId, customerCompanyId, marginPercent, marginNumber, now, now, now);
    return id;
}

function savePasswordHash(userId, passwordHash, passwordHashVersion) {
    const row = statements.userById.get(userId);
    const nextEpoch = (Number(row?.session_epoch) || 0) + 1;
    db.prepare(`
        UPDATE users
        SET password_hash = ?, password_hash_version = ?, pwd = NULL, session_epoch = ?
        WHERE id = ?
    `).run(passwordHash, passwordHashVersion, nextEpoch, userId);
    return nextEpoch;
}

function setUserDisabled(userId, disabled) {
    const row = statements.userById.get(userId);
    const nextEpoch = (Number(row?.session_epoch) || 0) + 1;
    db.prepare('UPDATE users SET disabled = ?, session_epoch = ? WHERE id = ?').run(disabled ? 1 : 0, nextEpoch, userId);
    return nextEpoch;
}

function setUserEmail(userId, email) {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, userId);
}

function listUsersForAdmin(companyRecordId) {
    if (!companyRecordId) return [];
    return db.prepare(`
        SELECT u.id, u.username, u.display_name, u.disabled, u.company_role, u.email, u.totp_enabled,
               CASE WHEN u.password_hash IS NOT NULL AND u.password_hash != '' THEN 1 ELSE 0 END AS has_password,
               c.company_name, c.company_type
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_record_id
        WHERE u.company_record_id = ?
        ORDER BY u.username
    `).all(companyRecordId).map(row => ({
        id: row.id,
        username: row.username,
        loginName: row.username || '',
        displayName: row.display_name || row.username,
        email: row.email || '',
        role: row.company_role === 'company_admin' ? 'company_admin' : 'member',
        active: row.disabled !== 1,
        disabled: row.disabled === 1,
        hasPassword: row.has_password === 1,
        isAdmin: row.company_role === 'company_admin',
        totpEnabled: row.totp_enabled === 1,
        twoFactorEnrolled: row.totp_enabled === 1,
        companyName: row.company_name || '',
        companyType: row.company_type || ''
    }));
}

function insertCompanyRow({ id, name, typeName, typeId, admin }) {
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, id, name, typeName, typeId, id, admin ? 1 : 0);
    return id;
}

function insertUserRow({
    id,
    username,
    displayName,
    companyRecordId,
    companyBusinessId,
    rateView,
    adminScreen,
    companyRole,
    email,
    passwordHash,
    passwordHashVersion,
    mustChangePassword
}) {
    db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen,
            password_hash, password_hash_version, disabled, session_epoch, company_record_id,
            company_role, is_system_admin, email, must_change_password
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?)
    `).run(
        id,
        username,
        displayName,
        rateView || null,
        companyBusinessId || companyRecordId,
        companyRecordId,
        adminScreen ? 1 : 0,
        passwordHash,
        passwordHashVersion,
        companyRecordId,
        companyRole,
        email || null,
        mustChangePassword ? 1 : 0
    );
    return id;
}

function updateUserDisplayName(userId, displayName) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
}

function setUserCompanyRole(userId, role) {
    const row = statements.userById.get(userId);
    const nextEpoch = (Number(row?.session_epoch) || 0) + 1;
    db.prepare('UPDATE users SET company_role = ?, session_epoch = ? WHERE id = ?').run(role, nextEpoch, userId);
    return nextEpoch;
}

function userIdForLogin(username) {
    if (typeof username !== 'string' || !username) return null;
    const row = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username);
    return row ? row.id : null;
}

function companyByName(name) {
    if (typeof name !== 'string' || !name) return null;
    return db.prepare(`
        SELECT id, company_name FROM companies WHERE lower(company_name) = lower(?)
    `).get(name) || null;
}

function clearPlaintextPasswords() {
    db.prepare('UPDATE users SET pwd = NULL WHERE pwd IS NOT NULL').run();
}

module.exports = {
    getAllRates,
    getRatesForView,
    getRatesByCarrierOrigin,
    getRatesByOwner,
    queryPartnerRates,
    getPartnerRate,
    getAllCompanies,
    getUserByUsername,
    getUserCredentials,
    getUserById,
    getCompanyByRecordId,
    getCompanyByCompanyId,
    companyForUser,
    linkUserCompanies,
    getSailings,
    getSailingsForOwners,
    queryPartnerSailings,
    getPartnerSailing,
    updateCompanyMargins,
    listMarginsForCustomer,
    listCustomerMarginTargets,
    upsertCompanyMargin,
    savePasswordHash,
    setUserDisabled,
    setUserEmail,
    listUsersForAdmin,
    insertCompanyRow,
    insertUserRow,
    updateUserDisplayName,
    setUserCompanyRole,
    userIdForLogin,
    companyByName,
    clearPlaintextPasswords,
    queryPublicRates,
    pullForwardRates,
    pullForwardSailings
};
