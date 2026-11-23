'use strict';

const { createHash } = require('node:crypto');
const {
    COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER, insertCompany, insertUser,
    insertRate, insertMargin, utcDay
} = require('./r1-19');

const OWNER = 'managed-owner';
const OTHER_OWNER = 'managed-private-owner';
const BUYER = 'managed-buyer';
const OTHER_BUYER = 'managed-other-buyer';
const RATE_TYPE = 'Port to Port';
const OTHER_RATE_TYPE = 'Synthetic Inland';

function seedManagedAgents(db) {
    for (const [id, name, type] of [
        [OWNER, 'Synthetic Owner', COMPANY_TYPE_CONTRACT_OWNER],
        [OTHER_OWNER, 'Synthetic Private Owner', COMPANY_TYPE_CONTRACT_OWNER],
        [BUYER, 'Synthetic Buyer', COMPANY_TYPE_CUSTOMER],
        [OTHER_BUYER, 'Synthetic Other Buyer', COMPANY_TYPE_CUSTOMER]
    ]) {
        insertCompany(db, { id, name, type });
    }
    // Exercise the difference between companies.id and users.company_id.
    db.prepare('UPDATE companies SET company_id = ? WHERE id = ?').run('3.0', BUYER);
    const users = {
        creator: { companyId: BUYER, displayName: 'Synthetic Creator' },
        member: { companyId: BUYER },
        companyAdmin: { companyId: BUYER, role: 'company_admin' },
        otherBuyer: { companyId: OTHER_BUYER },
        owner: { companyId: OWNER },
        systemAdmin: { companyId: BUYER, systemAdmin: true },
        nonCustomerAdmin: { companyId: OTHER_OWNER, systemAdmin: true },
        companyless: { companyId: null }
    };
    for (const [key, values] of Object.entries(users)) {
        const id = `managed-${key}`;
        insertUser(db, { id, username: id, ...values });
        if (values.companyId === BUYER) {
            const legacyId = ['member', 'companyAdmin'].includes(key) ? '3' : '3.0';
            db.prepare('UPDATE users SET company_id = ? WHERE id = ?').run(legacyId, id);
        }
        users[key] = id;
    }
    for (const [index, customer] of [BUYER, OTHER_BUYER].entries()) {
        insertMargin(db, { id: `managed-margin-${index}`, owner: OWNER, customer, percent: 7 });
    }
    const rates = [
        [OWNER, 'SHA', 'LAX', RATE_TYPE, -7, -1],
        [OWNER, 'SHA', 'LAX', RATE_TYPE, 2, 30],
        [OWNER, 'SHA', 'LAX', RATE_TYPE, 33, 40],
        [OWNER, 'SHA', 'CHI', OTHER_RATE_TYPE, 2, 30],
        [OTHER_OWNER, 'SHA', 'LAX', RATE_TYPE, 31, 32],
        [OTHER_OWNER, 'SIN', 'NYC', 'Private rate type', 2, 50]
    ];
    for (const [index, [owner, origin, destination, rateType, from, until]] of rates.entries()) {
        const id = `managed-rate-${index}`;
        insertRate(db, { id, owner, origin, destination, effective: utcDay(from), expiration: utcDay(until) });
        db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(rateType, id);
    }
    return users;
}

function search(overrides = {}) {
    return {
        rateType: RATE_TYPE,
        originPort: 'SHA',
        destinationPort: 'LAX',
        sailingDate: utcDay(2),
        containerType: '40HC',
        allowAlternativeRoutes: true,
        allowBookingRequest: false,
        ...overrides
    };
}

function tableHashes(db) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => {
        const table = '"' + name.replaceAll('"', '""') + '"';
        const preExistingRows = name === 'schema_migrations' ? " WHERE id NOT IN ('013', '014', '015', '016', '017', '018', '019', '020', '021')" : '';
        const rows = db.prepare(`SELECT * FROM ${table}${preExistingRows}`).all();
        if (name === 'rates') {
            for (const row of rows) delete row.max_slots_allowed;
        }
        const hash = createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');
        return [name, hash];
    }));
}

module.exports = { seedManagedAgents, tableHashes, search, BUYER, OTHER_BUYER, OTHER_RATE_TYPE, RATE_TYPE };
