'use strict';

const { freezeClock } = require('./r1-12');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    insertCompany,
    insertUser,
    insertMargin,
    activate,
    login,
    call
} = require('./r1-19');
const { authorizeAndToken, partnerGet, mcpCall, REDIRECT_URI } = require('./r1-12');

// Worked-example day from the R1-24 brief.
const FIXED_MS = Date.parse('2026-11-14T12:00:00.000Z');

function freezeToday() {
    return freezeClock(FIXED_MS);
}

function insertRate(db, {
    id,
    owner,
    carrier = 'MSC',
    origin,
    destination,
    contractOwner = 'Kings',
    rate20 = 1000,
    rate40 = 1800,
    rate40hc = 1900,
    effective,
    expiration = null,
    deletedAt = null
}) {
    db.prepare(`
        INSERT INTO rates (
            id, carrier, origin_port, destination_port, contract_owner,
            rate_20d, rate_40d, rate_40hc, rate_effective_date, rate_expiration_date,
            owner_company_id, deleted_at, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        id,
        carrier,
        origin,
        destination,
        contractOwner,
        rate20,
        rate40,
        rate40hc,
        effective,
        expiration,
        owner,
        deletedAt
    );
}

function insertSailing(db, {
    id,
    owner,
    carrier = 'MSC',
    departurePort,
    arrivalPort = null,
    departure,
    deletedAt = null
}) {
    db.prepare(`
        INSERT INTO sailings (
            id, carrier, departure, departure_port, arrival_port,
            owner_company_id, deleted_at, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, carrier, departure, departurePort, arrivalPort, owner, deletedAt);
}

function insertPort(db, { id, code, name }) {
    db.prepare(`
        INSERT INTO ports (id, code, name, created_at, updated_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(id, code, name);
}

function dayBefore(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    date.setUTCDate(date.getUTCDate() - 1);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

const SHARED_REFERENCE_TOOLS = [
    'rateninja_list_rate_date_ranges',
    'rateninja_list_valid_origin_ports',
    'rateninja_list_valid_destination_ports',
    'rateninja_list_valid_contract_owners'
];

const OWNER_ONLY_REFERENCE_TOOLS = [
    'rateninja_list_sailing_date_ranges',
    'rateninja_list_predictive_date_ranges'
];

const CUSTOMER_TOOLS = [
    'rateninja_get_my_profile',
    ...SHARED_REFERENCE_TOOLS,
    'rateninja_list_my_booking_requests',
    'rateninja_get_my_booking_request',
    'rateninja_list_available_rates',
    'rateninja_create_booking_request'
];

module.exports = {
    FIXED_MS,
    freezeToday,
    insertRate,
    insertSailing,
    insertPort,
    insertCompany,
    insertUser,
    insertMargin,
    activate,
    login,
    call,
    dayBefore,
    SHARED_REFERENCE_TOOLS,
    OWNER_ONLY_REFERENCE_TOOLS,
    CUSTOMER_TOOLS,
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    REDIRECT_URI
};
