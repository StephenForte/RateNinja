const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'rateninja.db');
const dbPath = process.env.SQLITE_DB_PATH || DEFAULT_DB_PATH;

// Ensure the parent directory exists before opening the database.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

// Idempotent schema. Column names mirror the Airtable schema in snake_case so
// lib/store.js can map them back to the exact Airtable field names.
db.exec(`
    CREATE TABLE IF NOT EXISTS rates (
        id TEXT PRIMARY KEY,
        rate_type TEXT,
        origin_port TEXT,
        destination_port TEXT,
        inland_delivery_location TEXT,
        commodity_type TEXT,
        carrier TEXT,
        contract_owner TEXT,
        rate_20d REAL,
        rate_40d REAL,
        rate_40hc REAL,
        rate_effective_date TEXT,
        rate_expiration_date TEXT,
        notes_1 TEXT,
        rate_view TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        pwd TEXT,
        display_name TEXT,
        rate_view TEXT,
        company_id TEXT,
        company_reference TEXT,
        admin_screen INTEGER
    );

    CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        company_name TEXT,
        company_type TEXT,
        rate_view TEXT,
        admin INTEGER,
        margin_percent REAL,
        margin_number REAL
    );

    CREATE TABLE IF NOT EXISTS sailings (
        id TEXT PRIMARY KEY,
        departure TEXT,
        arrival TEXT,
        transit_time TEXT,
        vessel TEXT,
        voyage TEXT,
        service TEXT,
        carrier TEXT,
        departure_port TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rates_carrier_origin ON rates (carrier, origin_port);
    CREATE INDEX IF NOT EXISTS idx_rates_rate_view ON rates (rate_view);
    CREATE INDEX IF NOT EXISTS idx_sailings_carrier_port_departure ON sailings (carrier, departure_port, departure);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
    CREATE INDEX IF NOT EXISTS idx_companies_company_id ON companies (company_id);
`);

module.exports = {
    db,
    dbPath
};
