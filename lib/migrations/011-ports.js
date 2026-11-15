'use strict';

// Port reference table (R1-23 / D-030). up() runs inside the runner's transaction.
// Do not BEGIN, COMMIT, or ROLLBACK.

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ports (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ports_code_unique
            ON ports (lower(code));
    `);
}

module.exports = {
    id: '011',
    description: 'Add ports reference table.',
    up
};
