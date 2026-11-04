'use strict';

// Booking requests (R1-19). up() runs inside the runner's transaction.
// Do not BEGIN, COMMIT, or ROLLBACK.

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS booking_requests (
            id TEXT PRIMARY KEY,
            rate_id TEXT NOT NULL,
            status TEXT NOT NULL,
            container_size TEXT NOT NULL,
            slots INTEGER NOT NULL,
            customer_price INTEGER NOT NULL,
            carrier TEXT,
            origin_port TEXT,
            destination_port TEXT,
            inland_delivery_location TEXT,
            commodity_type TEXT,
            contract_owner TEXT,
            contract_number TEXT,
            owner_company_name TEXT,
            rate_effective_date TEXT,
            rate_expiration_date TEXT,
            notes TEXT,
            requesting_user_id TEXT NOT NULL,
            requesting_user_name TEXT,
            requesting_company_id TEXT NOT NULL,
            owner_company_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            decided_by_user_id TEXT,
            decided_by_user_name TEXT,
            owner_read_at TEXT,
            customer_read_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_booking_requests_owner
            ON booking_requests (owner_company_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_booking_requests_customer
            ON booking_requests (requesting_company_id, created_at);
    `);
}

module.exports = {
    id: '010',
    description: 'Add booking requests.',
    up
};
