/**
 * One-time migration: copy all Airtable records into the local SQLite database.
 *
 * Run with `npm run migrate`. This is a standalone script — the server never
 * imports or triggers it. It talks to Airtable directly (the only remaining
 * Airtable reference in the codebase) and writes through lib/db.js.
 *
 * Idempotent: records upsert by their Airtable id (INSERT OR REPLACE), so
 * re-running never duplicates rows.
 */
const { URL } = require('node:url');
const { db } = require('../lib/db');

try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional when the host already injects environment variables.
}

// Migration-only Airtable settings. The live server no longer reads these.
const config = {
    apiToken: process.env.AIRTABLE_PAT,
    baseId: process.env.AIRTABLE_BASE_ID || 'appBLegnJMAienppq',
    timeoutMs: Number(process.env.AIRTABLE_TIMEOUT_MS) || 15_000,
    tables: {
        rates: process.env.AIRTABLE_RATE_TABLE_ID || 'tbl5OpIdW2kyRRWLp',
        users: process.env.AIRTABLE_USER_TABLE_ID || 'tblwtjp73CaWe3GKy',
        companies: process.env.AIRTABLE_COMPANY_TABLE_ID || 'CompanyReference',
        sailings: process.env.AIRTABLE_SAILINGS_TABLE_ID || 'Sailings'
    }
};

const RATE_FIELDS = [
    'Rate Type',
    'Origin Port',
    'Destination Port/Via Port',
    'Inland Delivery Location',
    'CommodityType',
    'Carrier',
    'Contract Owner',
    '20D Rate',
    '40D rate',
    '40HC Rate',
    'Rate Effective Date',
    'Rate Expiration Date',
    'Notes 1',
    'RateView'
];

const MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function applySearchParams(url, params = {}) {
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        if (key === 'fields' && Array.isArray(value)) {
            for (const field of value) url.searchParams.append('fields[]', field);
            continue;
        }
        url.searchParams.set(key, value);
    }
}

async function airtableRequest(table, options = {}) {
    const safeTablePath = table.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://api.airtable.com/v0/${config.baseId}/${safeTablePath}`);
    applySearchParams(url, options.params);

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            const response = await fetch(url, {
                method: options.method || 'GET',
                headers: { Authorization: `Bearer ${config.apiToken}` },
                signal: controller.signal
            });

            if (response.status === 429 && attempt < MAX_RETRIES) {
                const retryAfter = Number(response.headers.get('retry-after'));
                await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (attempt + 1));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Airtable request failed (${response.status}).`);
            }

            return response.json();
        } catch (error) {
            lastError = error;
            const aborted = error?.name === 'AbortError';
            if (aborted || attempt >= MAX_RETRIES) throw aborted ? new Error('Airtable request timed out.') : error;
            await sleep(500 * (attempt + 1));
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError;
}

async function fetchAllRecords(table, params = {}) {
    const records = [];
    let offset;
    do {
        const result = await airtableRequest(table, { params: { ...params, offset } });
        records.push(...result.records);
        offset = result.offset;
    } while (offset);
    return records;
}

// Array field values (e.g. RateView, CompanyReference) are joined with ', ' to
// match lib/domain.js normalizeValue behavior. undefined/null become NULL.
function joinValue(value) {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.join(', ');
    return value;
}

// Airtable checkbox fields arrive as true/undefined; store 1/0.
function boolValue(value) {
    return value ? 1 : 0;
}

// Numeric columns: coerce to a number, leaving blanks/invalid values as NULL.
function numValue(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(Array.isArray(value) ? value[0] : value);
    return Number.isNaN(number) ? null : number;
}

// Run inserts for one table inside a transaction so a failure leaves the DB
// unchanged. Returns the number of rows written.
function insertAll(records, sql, toParams) {
    const statement = db.prepare(sql);
    db.exec('BEGIN');
    try {
        for (const record of records) {
            statement.run(...toParams(record));
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return records.length;
}

// Rates: request RATE_FIELDS plus Arrival, but gracefully retry without Arrival
// if that field does not exist in the base (projection rejected).
async function fetchRates() {
    try {
        return await fetchAllRecords(config.tables.rates, { fields: [...RATE_FIELDS, 'Arrival'] });
    } catch (error) {
        console.warn(`Retrying rates fetch without Arrival field: ${error.message}`);
        return fetchAllRecords(config.tables.rates, { fields: RATE_FIELDS });
    }
}

function migrateRates(records) {
    return insertAll(
        records,
        `INSERT OR REPLACE INTO rates
            (id, rate_type, origin_port, destination_port, inland_delivery_location,
             commodity_type, carrier, contract_owner, rate_20d, rate_40d, rate_40hc,
             rate_effective_date, rate_expiration_date, notes_1, rate_view)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        record => {
            const f = record.fields;
            return [
                record.id,
                joinValue(f['Rate Type']),
                joinValue(f['Origin Port']),
                joinValue(f['Destination Port/Via Port']),
                joinValue(f['Inland Delivery Location']),
                joinValue(f.CommodityType),
                joinValue(f.Carrier),
                joinValue(f['Contract Owner']),
                numValue(f['20D Rate']),
                numValue(f['40D rate']),
                numValue(f['40HC Rate']),
                joinValue(f['Rate Effective Date']),
                joinValue(f['Rate Expiration Date']),
                joinValue(f['Notes 1']),
                joinValue(f.RateView)
            ];
        }
    );
}

function migrateUsers(records) {
    return insertAll(
        records,
        `INSERT OR REPLACE INTO users
            (id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen)
         VALUES (?,?,?,?,?,?,?,?)`,
        record => {
            const f = record.fields;
            return [
                record.id,
                joinValue(f.UserName),
                joinValue(f.Pwd),
                joinValue(f.DisplayName),
                joinValue(f.RateView),
                joinValue(f['CompanyID (from CompanyReference)']),
                joinValue(f.CompanyReference),
                boolValue(f.AdminScreen)
            ];
        }
    );
}

function migrateCompanies(records) {
    return insertAll(
        records,
        `INSERT OR REPLACE INTO companies
            (id, company_id, company_name, company_type, rate_view, admin, margin_percent, margin_number)
         VALUES (?,?,?,?,?,?,?,?)`,
        record => {
            const f = record.fields;
            return [
                record.id,
                joinValue(f.CompanyID),
                joinValue(f.CompanyName),
                joinValue(f.CompanyType),
                joinValue(f.RateView),
                boolValue(f.Admin),
                numValue(f.MarginPercent),
                numValue(f.MarginNumber)
            ];
        }
    );
}

function migrateSailings(records) {
    return insertAll(
        records,
        `INSERT OR REPLACE INTO sailings
            (id, departure, arrival, transit_time, vessel, voyage, service, carrier, departure_port)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        record => {
            const f = record.fields;
            return [
                record.id,
                joinValue(f.Departure),
                joinValue(f.Arrival),
                joinValue(f.TransitTime),
                joinValue(f.Vessel),
                joinValue(f.Voyage),
                joinValue(f.Service),
                joinValue(f.Carrier),
                joinValue(f.DeparturePort)
            ];
        }
    );
}

async function main() {
    if (!config.apiToken) {
        throw new Error('AIRTABLE_PAT is required to run the migration.');
    }

    const rates = await fetchRates();
    const ratesCount = migrateRates(rates);

    const users = await fetchAllRecords(config.tables.users);
    const usersCount = migrateUsers(users);

    const companies = await fetchAllRecords(config.tables.companies);
    const companiesCount = migrateCompanies(companies);

    const sailings = await fetchAllRecords(config.tables.sailings);
    const sailingsCount = migrateSailings(sailings);

    console.log('Migration complete. Records migrated:');
    console.log(`  rates:     ${ratesCount}`);
    console.log(`  users:     ${usersCount}`);
    console.log(`  companies: ${companiesCount}`);
    console.log(`  sailings:  ${sailingsCount}`);
}

main().catch(error => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
});
