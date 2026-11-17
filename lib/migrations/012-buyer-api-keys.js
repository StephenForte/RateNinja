'use strict';

// D-037: additive, applied inside the migration runner's transaction.
function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS buyer_api_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            label TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            revoked_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS buyer_api_keys_hash_unique ON buyer_api_keys (key_hash);
        CREATE INDEX IF NOT EXISTS buyer_api_keys_user ON buyer_api_keys (user_id);
    `);
}

module.exports = { id: '012', description: 'Add per-buyer API keys.', up };
