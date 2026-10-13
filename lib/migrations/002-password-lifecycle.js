'use strict';

// Temporary-password flag for R1-04. up() runs inside the runner's transaction.
// Do not BEGIN, COMMIT, ROLLBACK, or call lib/db.js transaction().

function columnExists(db, table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function up(db) {
    if (!columnExists(db, 'users', 'must_change_password')) {
        db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'users', 'password_changed_at')) {
        db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
    }
}

module.exports = {
    id: '002',
    description: 'Record temporary passwords and when a user last chose their own password.',
    up
};
