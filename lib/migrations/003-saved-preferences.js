'use strict';

// Personal saved queries and saved views (R1-05). Id 003 is pre-assigned.
// up() runs inside the runner's transaction. Do not BEGIN, COMMIT, ROLLBACK,
// or call lib/db.js transaction().

function columnExists(db, table, name) {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (!tables) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function addColumn(db, table, name, definition) {
    if (!columnExists(db, table, name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS saved_queries (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            config_version INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS saved_views (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            config_version INTEGER NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    addColumn(db, 'saved_queries', 'user_id', 'TEXT');
    addColumn(db, 'saved_queries', 'name', 'TEXT');
    addColumn(db, 'saved_queries', 'payload', 'TEXT');
    addColumn(db, 'saved_queries', 'config_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'saved_queries', 'created_at', 'TEXT');
    addColumn(db, 'saved_queries', 'updated_at', 'TEXT');

    addColumn(db, 'saved_views', 'user_id', 'TEXT');
    addColumn(db, 'saved_views', 'name', 'TEXT');
    addColumn(db, 'saved_views', 'payload', 'TEXT');
    addColumn(db, 'saved_views', 'config_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'saved_views', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'saved_views', 'created_at', 'TEXT');
    addColumn(db, 'saved_views', 'updated_at', 'TEXT');

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS saved_queries_user_name
            ON saved_queries (user_id, name COLLATE NOCASE);
        CREATE UNIQUE INDEX IF NOT EXISTS saved_views_user_name
            ON saved_views (user_id, name COLLATE NOCASE);
        CREATE UNIQUE INDEX IF NOT EXISTS saved_views_one_default
            ON saved_views (user_id) WHERE is_default = 1;
    `);
}

module.exports = {
    id: '003',
    description: 'Add per-user saved queries and saved display views.',
    up
};
