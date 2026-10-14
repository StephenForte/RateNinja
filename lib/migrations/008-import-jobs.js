'use strict';

// Import jobs, plus the columns D-025 stores on rates and sailings.
// up() runs inside the runner's transaction. Do not BEGIN, COMMIT, or ROLLBACK.

function columnExists(db, table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function addColumn(db, table, name, definition) {
    if (!columnExists(db, table, name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

function up(db) {
    addColumn(db, 'rates', 'contract_number', 'TEXT');
    addColumn(db, 'sailings', 'arrival_port', 'TEXT');

    db.exec(`
        CREATE TABLE IF NOT EXISTS import_jobs (
            id TEXT PRIMARY KEY,
            owner_company_id TEXT NOT NULL,
            actor_user_id TEXT NOT NULL,
            dataset TEXT NOT NULL,
            filename TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            sheet_name TEXT,
            status TEXT NOT NULL,
            accepted_count INTEGER,
            rejected_count INTEGER,
            submission_id TEXT UNIQUE,
            operation_id TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            expires_at TEXT NOT NULL
        );
    `);
}

module.exports = {
    id: '008',
    description: 'Add import jobs and store contract number and arrival port.',
    up
};
