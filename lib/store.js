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
    return { id: row.id, fields };
}

function companyRecord(row) {
    const fields = {};
    assign(fields, 'CompanyID', row.company_id);
    assign(fields, 'CompanyName', row.company_name);
    assign(fields, 'CompanyType', row.company_type);
    assign(fields, 'RateView', row.rate_view);
    if (row.admin !== null && row.admin !== undefined) fields.Admin = row.admin === 1;
    assign(fields, 'MarginPercent', row.margin_percent);
    assign(fields, 'MarginNumber', row.margin_number);
    return { id: row.id, fields };
}

function userRecord(row) {
    const fields = {};
    assign(fields, 'UserName', row.username);
    assign(fields, 'Pwd', row.pwd);
    assign(fields, 'DisplayName', row.display_name);
    assign(fields, 'RateView', row.rate_view);
    assign(fields, 'CompanyID (from CompanyReference)', row.company_id);
    assign(fields, 'CompanyReference', row.company_reference);
    fields.AdminScreen = row.admin_screen === 1;
    return { id: row.id, fields };
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
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
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
            rate_effective_date, rate_expiration_date, notes_1, rate_view
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            id, departure, arrival, transit_time, vessel, voyage, service, carrier, departure_port
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function getCompanyByRecordId(id) {
    const row = statements.companyByRecordId.get(id);
    return row ? companyRecord(row) : null;
}

function getCompanyByCompanyId(companyId) {
    const row = statements.companyByCompanyId.get(String(companyId ?? ''));
    return row ? companyRecord(row) : null;
}

function getSailings({ carrier, originPort, after }) {
    return statements.sailings.all(carrier, originPort, after).map(row => mapSailingRecord({ fields: sailingFields(row) }));
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
function pullForwardRates({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, priceIncreasePercent, deleteExisting }) {
    const multiplier = 1 + priceIncreasePercent / 100;
    db.exec('BEGIN');
    try {
        const sources = statements.ratesInEffectiveRange.all(sourceStart, sourceEnd);
        let deleted = 0;
        if (deleteExisting) {
            deleted = Number(statements.deleteRatesInEffectiveRange.run(targetStart, targetEnd).changes);
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
                row.rate_view
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
function pullForwardSailings({ sourceStart, sourceEnd, targetStart, targetEnd, offsetDays, deleteExisting }) {
    db.exec('BEGIN');
    try {
        const sources = statements.sailingsInDepartureRange.all(sourceStart, sourceEnd);
        let deleted = 0;
        if (deleteExisting) {
            deleted = Number(statements.deleteSailingsInDepartureRange.run(targetStart, targetEnd).changes);
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
                row.departure_port
            );
        }
        db.exec('COMMIT');
        return { copied: sources.length, deleted };
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = {
    getAllRates,
    getRatesForView,
    getRatesByCarrierOrigin,
    getAllCompanies,
    getUserByUsername,
    getCompanyByRecordId,
    getCompanyByCompanyId,
    getSailings,
    updateCompanyMargins,
    queryPublicRates,
    pullForwardRates,
    pullForwardSailings
};
