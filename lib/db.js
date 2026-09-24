const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CUSTOMER_ID
} = require('./constants');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'rateninja.db');
const dbPath = process.env.SQLITE_DB_PATH || DEFAULT_DB_PATH;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

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
        rate_view TEXT,
        owner_company_id TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        pwd TEXT,
        display_name TEXT,
        rate_view TEXT,
        company_id TEXT,
        company_reference TEXT,
        admin_screen INTEGER,
        password_hash TEXT,
        password_hash_version TEXT,
        disabled INTEGER NOT NULL DEFAULT 0,
        session_epoch INTEGER NOT NULL DEFAULT 0,
        company_record_id TEXT
    );

    CREATE TABLE IF NOT EXISTS company_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        company_name TEXT,
        company_type TEXT,
        company_type_id TEXT,
        rate_view TEXT,
        admin INTEGER,
        margin_percent REAL,
        margin_number REAL
    );

    CREATE TABLE IF NOT EXISTS company_margins (
        id TEXT PRIMARY KEY,
        owner_company_id TEXT NOT NULL,
        customer_company_id TEXT NOT NULL,
        margin_percent REAL NOT NULL DEFAULT 0,
        margin_number REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_company_id, customer_company_id)
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
        departure_port TEXT,
        owner_company_id TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        secret_hash TEXT,
        client_type TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        allowed_scopes TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_grants (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        consent_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        family_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_user_id TEXT,
        client_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rates_carrier_origin ON rates (carrier, origin_port);
    CREATE INDEX IF NOT EXISTS idx_rates_rate_view ON rates (rate_view);
    CREATE INDEX IF NOT EXISTS idx_rates_owner ON rates (owner_company_id);
    CREATE INDEX IF NOT EXISTS idx_sailings_carrier_port_departure ON sailings (carrier, departure_port, departure);
    CREATE INDEX IF NOT EXISTS idx_sailings_owner ON sailings (owner_company_id);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
    CREATE INDEX IF NOT EXISTS idx_companies_company_id ON companies (company_id);
    CREATE INDEX IF NOT EXISTS idx_company_margins_customer ON company_margins (customer_company_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens (family_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at);
`);

function addColumn(table, name, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(column => column.name === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

addColumn('rates', 'owner_company_id', 'TEXT');
addColumn('sailings', 'owner_company_id', 'TEXT');
addColumn('users', 'password_hash', 'TEXT');
addColumn('users', 'password_hash_version', 'TEXT');
addColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'company_record_id', 'TEXT');
addColumn('companies', 'company_type_id', 'TEXT');

db.prepare('INSERT OR IGNORE INTO company_types (id, name) VALUES (?, ?)').run(
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CONTRACT_OWNER
);
db.prepare('INSERT OR IGNORE INTO company_types (id, name) VALUES (?, ?)').run(
    COMPANY_TYPE_CUSTOMER_ID,
    COMPANY_TYPE_CUSTOMER
);

db.exec(`
    UPDATE companies SET company_type = '${COMPANY_TYPE_CONTRACT_OWNER}', company_type_id = '${COMPANY_TYPE_CONTRACT_OWNER_ID}'
    WHERE lower(trim(company_type)) IN ('contract owner', 'contract_owner', 'owner');
    UPDATE companies SET company_type = '${COMPANY_TYPE_CUSTOMER}', company_type_id = '${COMPANY_TYPE_CUSTOMER_ID}'
    WHERE lower(trim(company_type)) IN ('customer', 'freight forwarder', 'freight forwarder/customer', 'ff');
    UPDATE companies SET company_type_id = '${COMPANY_TYPE_CONTRACT_OWNER_ID}'
    WHERE company_type = '${COMPANY_TYPE_CONTRACT_OWNER}' AND (company_type_id IS NULL OR company_type_id = '');
    UPDATE companies SET company_type_id = '${COMPANY_TYPE_CUSTOMER_ID}'
    WHERE company_type = '${COMPANY_TYPE_CUSTOMER}' AND (company_type_id IS NULL OR company_type_id = '');
`);

function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // The transaction may already be closed.
        }
        throw error;
    }
}

module.exports = {
    db,
    dbPath,
    transaction
};
