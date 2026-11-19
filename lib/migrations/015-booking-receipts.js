'use strict';

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS booking_receipts (
            request_id TEXT NOT NULL PRIMARY KEY REFERENCES booking_requests(id),
            status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
            receipt_hash TEXT NOT NULL,
            raw_transaction TEXT,
            tx_hash TEXT,
            sender_address TEXT,
            chain_id INTEGER,
            nonce INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            submitted_at INTEGER,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_booking_receipts_queue
            ON booking_receipts (status, next_attempt_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_booking_receipts_sender_nonce
            ON booking_receipts (sender_address, chain_id, nonce);
    `);
}

module.exports = { id: '015', description: 'Add the approval receipt queue.', up };
