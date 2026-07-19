/**
 * One-time migration: copy all Airtable records into the local SQLite database.
 *
 * Run with `npm run migrate`. This is a standalone script — the server never
 * imports or triggers it. It reuses the Airtable client (lib/airtable.js) for
 * paginated fetching and writes through lib/db.js.
 *
 * Idempotent: records upsert by their Airtable id (INSERT OR REPLACE), so
 * re-running never duplicates rows.
 */
const { config } = require('../lib/config');
const { db } = require('../lib/db');
const { fetchAllRecords, RATE_FIELDS } = require('../lib/airtable');

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
