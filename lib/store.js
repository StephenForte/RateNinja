const { db } = require('./db');
const { mapSailingRecord } = require('./domain');

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

function getAllRates() {
    const rows = db.prepare('SELECT * FROM rates').all();
    return rows.map(rateRecord);
}

function getAllCompanies() {
    const rows = db.prepare('SELECT * FROM companies').all();
    return rows.map(companyRecord);
}

function getUserByUsername(username) {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row ? userRecord(row) : null;
}

function getCompanyByRecordId(id) {
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    return row ? companyRecord(row) : null;
}

function getSailings({ carrier, originPort, after }) {
    const rows = db
        .prepare('SELECT * FROM sailings WHERE carrier = ? AND departure_port = ? AND departure > ? ORDER BY departure ASC')
        .all(carrier, originPort, after);
    return rows.map(row => mapSailingRecord({ fields: sailingFields(row) }));
}

function updateCompanyMargins(id, { marginPercent, marginNumber }) {
    db.prepare('UPDATE companies SET margin_percent = ?, margin_number = ? WHERE id = ?').run(marginPercent, marginNumber, id);
}

module.exports = {
    getAllRates,
    getAllCompanies,
    getUserByUsername,
    getCompanyByRecordId,
    getSailings,
    updateCompanyMargins
};
