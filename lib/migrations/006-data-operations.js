'use strict';

// Soft delete, row versions, and operation history for R1-08.
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
    addColumn(db, 'rates', 'deleted_at', 'TEXT');
    addColumn(db, 'rates', 'deleted_operation_id', 'TEXT');
    addColumn(db, 'rates', 'row_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'sailings', 'deleted_at', 'TEXT');
    addColumn(db, 'sailings', 'deleted_operation_id', 'TEXT');
    addColumn(db, 'sailings', 'row_version', 'INTEGER NOT NULL DEFAULT 1');

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_rates_deleted_at ON rates (deleted_at);
        CREATE INDEX IF NOT EXISTS idx_sailings_deleted_at ON sailings (deleted_at);

        CREATE TABLE IF NOT EXISTS data_operations (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            dataset TEXT NOT NULL,
            owner_company_id TEXT NOT NULL,
            actor_user_id TEXT NOT NULL,
            status TEXT NOT NULL,
            affected_count INTEGER NOT NULL,
            submission_id TEXT UNIQUE,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            detail_json TEXT
        );

        CREATE TABLE IF NOT EXISTS data_operation_items (
            operation_id TEXT NOT NULL,
            dataset TEXT NOT NULL,
            record_id TEXT NOT NULL,
            action TEXT NOT NULL,
            prior_json TEXT,
            PRIMARY KEY (operation_id, dataset, record_id)
        );

        CREATE INDEX IF NOT EXISTS idx_data_operations_owner_created
            ON data_operations (owner_company_id, created_at);
    `);
}

module.exports = {
    id: '006',
    description: 'Add soft delete, row versions, and data operation history for rates and sailings.',
    up
};
