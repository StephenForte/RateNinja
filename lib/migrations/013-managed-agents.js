'use strict';

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS managed_agents (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            created_by_user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            rate_type TEXT NOT NULL,
            origin_port TEXT NOT NULL,
            destination_port TEXT NOT NULL,
            sailing_date TEXT NOT NULL,
            saved_query_id TEXT,
            container_type TEXT NOT NULL CHECK (container_type IN ('20D', '40D', '40HC')),
            allow_alternative_routes INTEGER NOT NULL CHECK (allow_alternative_routes IN (0, 1)),
            allow_booking_request INTEGER NOT NULL CHECK (allow_booking_request IN (0, 1)),
            price_min REAL,
            price_max REAL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            result_summary TEXT,
            CHECK (
                (allow_booking_request = 0 AND price_min IS NULL AND price_max IS NULL)
                OR (allow_booking_request = 1 AND price_min IS NOT NULL AND price_max IS NOT NULL
                    AND price_min >= 0 AND price_min <= price_max)
            )
        );
        CREATE INDEX IF NOT EXISTS managed_agents_company_created
            ON managed_agents (company_id, created_at);
    `);
}

module.exports = { id: '013', description: 'Add managed agent requests.', up };
