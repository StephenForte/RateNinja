const crypto = require('node:crypto');
const { db } = require('./db');
const { mapSailingRecord, shiftDateOnly, shiftDateTime } = require('./domain');

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
    allRates: db.prepare('SELECT * FROM rates'),
    ratesForView: db.prepare(`
        SELECT * FROM rates
        WHERE rate_view = ?
           OR rate_view LIKE ? || ', %'
           OR rate_view LIKE '%, ' || ?
           OR rate_view LIKE '%, ' || ? || ', %'
    `),
    ratesByCarrierOrigin: db.prepare('SELECT * FROM rates WHERE carrier = ? AND origin_port = ?'),
    allCompanies: db.prepare('SELECT * FROM companies'),
    userByUsername: db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    companyByRecordId: db.prepare('SELECT * FROM companies WHERE id = ?'),
    companyByCompanyId: db.prepare('SELECT * FROM companies WHERE company_id = ?'),
    sailings: db.prepare(`
        SELECT * FROM sailings
        WHERE carrier = ? AND departure_port = ? AND departure > ?
        ORDER BY departure ASC
    `),
    updateMargins: db.prepare('UPDATE companies SET margin_percent = ?, margin_number = ? WHERE id = ?'),
    ratesInEffectiveRange: db.prepare('SELECT * FROM rates WHERE rate_effective_date >= ? AND rate_effective_date <= ?'),
    deleteRatesInEffectiveRange: db.prepare('DELETE FROM rates WHERE rate_effective_date >= ? AND rate_effective_date <= ?'),
    insertRate: db.prepare(`
        INSERT INTO rates (
            id, rate_type, origin_port, destination_port, inland_delivery_location,
            commodity_type, carrier, contract_owner, rate_20d, rate_40d, rate_40hc,
            rate_effective_date, rate_expiration_date, notes_1, rate_view, owner_company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    sailingsInDepartureRange: db.prepare(`
        SELECT * FROM sailings
        WHERE substr(departure, 1, 10) >= ? AND substr(departure, 1, 10) <= ?
    `),
    deleteSailingsInDepartureRange: db.prepare(`
        DELETE FROM sailings
        WHERE substr(departure, 1, 10) >= ? AND substr(departure, 1, 10) <= ?
    `),
    insertSailing: db.prepare(`
        INSERT INTO sailings (
            id, departure, arrival, transit_time, vessel, voyage, service, carrier, departure_port, owner_company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
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
    const clauses = [`owner_company_id IN (${placeholders})`];
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
    const clauses = [];
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

function scaleRate(value, multiplier) {
    if (value === null || value === undefined) return null;
    return Math.round(Number(value) * multiplier);
}

// Copies rates whose rate_effective_date falls within [sourceStart, sourceEnd]
// into the future, shifting both date columns by offsetDays and scaling the
// container rates by (1 + priceIncreasePercent/100). When deleteExisting is set,
// rates already in the target range are removed first. Delete + inserts run in a
// single transaction so a failure leaves the DB unchanged.
function pullForwardRates({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, priceIncreasePercent, deleteExisting, ownerCompanyId }) {
    const multiplier = 1 + priceIncreasePercent / 100;
    db.exec('BEGIN');
    try {
        const sources = ownerCompanyId
            ? db.prepare('SELECT * FROM rates WHERE owner_company_id = ? AND rate_effective_date >= ? AND rate_effective_date <= ?').all(ownerCompanyId, sourceStart, sourceEnd)
            : statements.ratesInEffectiveRange.all(sourceStart, sourceEnd);
        let deleted = 0;
        if (deleteExisting) {
            deleted = ownerCompanyId
                ? Number(db.prepare('DELETE FROM rates WHERE owner_company_id = ? AND rate_effective_date >= ? AND rate_effective_date <= ?').run(ownerCompanyId, targetStart, targetEnd).changes)
                : Number(statements.deleteRatesInEffectiveRange.run(targetStart, targetEnd).changes);
        }
        for (const row of sources) {
            statements.insertRate.run(
                crypto.randomUUID(),
                row.rate_type,
                row.origin_port,
                row.destination_port,
                row.inland_delivery_location,
                row.commodity_type,
                row.carrier,
                row.contract_owner,
                scaleRate(row.rate_20d, multiplier),
                scaleRate(row.rate_40d, multiplier),
                scaleRate(row.rate_40hc, multiplier),
                shiftDateOnly(row.rate_effective_date, offsetDays),
                shiftDateOnly(row.rate_expiration_date, offsetDays),
                row.notes_1,
                row.rate_view,
                row.owner_company_id ?? ownerCompanyId ?? null
            );
        }
        db.exec('COMMIT');
        return { copied: sources.length, deleted };
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

// Copies sailings whose departure date part falls within [sourceStart, sourceEnd]
// into the future, shifting departure + arrival by offsetDays while preserving any
// time-of-day component. When deleteExisting is set, sailings already in the target
// range are removed first. Delete + inserts run in a single transaction so a failure
// leaves the DB unchanged.
function pullForwardSailings({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, deleteExisting, ownerCompanyId }) {
    db.exec('BEGIN');
    try {
        const sources = ownerCompanyId
            ? db.prepare(`SELECT * FROM sailings WHERE owner_company_id = ? AND substr(departure, 1, 10) >= ? AND substr(departure, 1, 10) <= ?`).all(ownerCompanyId, sourceStart, sourceEnd)
            : statements.sailingsInDepartureRange.all(sourceStart, sourceEnd);
        let deleted = 0;
        if (deleteExisting) {
            deleted = ownerCompanyId
                ? Number(db.prepare(`DELETE FROM sailings WHERE owner_company_id = ? AND substr(departure, 1, 10) >= ? AND substr(departure, 1, 10) <= ?`).run(ownerCompanyId, targetStart, targetEnd).changes)
                : Number(statements.deleteSailingsInDepartureRange.run(targetStart, targetEnd).changes);
        }
        for (const row of sources) {
            statements.insertSailing.run(
                crypto.randomUUID(),
                shiftDateTime(row.departure, offsetDays),
                shiftDateTime(row.arrival, offsetDays),
                row.transit_time,
                row.vessel,
                row.voyage,
                row.service,
                row.carrier,
                row.departure_port,
                row.owner_company_id ?? ownerCompanyId ?? null
            );
        }
        db.exec('COMMIT');
        return { copied: sources.length, deleted };
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function getRatesByOwner(ownerCompanyId) {
    return db.prepare('SELECT * FROM rates WHERE owner_company_id = ?').all(ownerCompanyId).map(rateRecord);
}

function queryPartnerRates(ownerCompanyId, { carrier = '', originPort = '', destinationPort = '', effectiveDate = '', page = 1, pageSize = 50 } = {}) {
    const clauses = ['owner_company_id = ?'];
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
    const row = db.prepare('SELECT * FROM rates WHERE id = ? AND owner_company_id = ?').get(rateId, ownerCompanyId);
    return row ? rateRecord(row) : null;
}

function queryPartnerSailings(ownerCompanyId, { carrier = '', originPort = '', after = '', page = 1, pageSize = 50 } = {}) {
    const clauses = ['owner_company_id = ?'];
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
    const row = db.prepare('SELECT * FROM sailings WHERE id = ? AND owner_company_id = ?').get(sailingId, ownerCompanyId);
    return row ? partnerSailingRow(row) : null;
}

function listMarginsForCustomer(customerCompanyId) {
    return db.prepare(`
        SELECT m.owner_company_id, m.customer_company_id, m.margin_percent, m.margin_number, c.company_name
        FROM company_margins m
        JOIN companies c ON c.id = m.owner_company_id
        WHERE m.customer_company_id = ?
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
            id, owner_company_id, customer_company_id, margin_percent, margin_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerCompanyId, customerCompanyId, marginPercent, marginNumber, now, now);
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

function listUsersForAdmin() {
    return db.prepare(`
        SELECT u.id, u.username, u.display_name, u.disabled, u.password_hash, u.admin_screen, u.email, u.totp_enabled,
               c.company_name, c.company_type
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_record_id
        ORDER BY u.username
    `).all().map(row => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        disabled: row.disabled === 1,
        hasPassword: Boolean(row.password_hash),
        isAdmin: row.admin_screen === 1,
        email: row.email || '',
        totpEnabled: row.totp_enabled === 1,
        companyName: row.company_name || '',
        companyType: row.company_type || ''
    }));
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
    clearPlaintextPasswords,
    queryPublicRates,
    pullForwardRates,
    pullForwardSailings
};
