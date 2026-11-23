'use strict';

const { MAX_BOOKING_SLOTS } = require('../limits');

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS company_swarm_settings (
            company_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            bbs_project TEXT,
            bbs_token_enc TEXT,
            updated_at TEXT NOT NULL,
            updated_by_user_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS swarms (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            created_by_user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            instructions TEXT NOT NULL DEFAULT '',
            total_spend_cap REAL,
            total_slots_cap INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (length(name) BETWEEN 1 AND 100),
            CHECK (length(instructions) <= 20000),
            CHECK (total_spend_cap IS NULL OR total_spend_cap > 0),
            CHECK (
                total_slots_cap IS NULL OR (
                    typeof(total_slots_cap) = 'integer' AND total_slots_cap >= 1
                )
            )
        );

        CREATE INDEX IF NOT EXISTS swarms_company_created
            ON swarms (company_id, created_at);

        CREATE TABLE IF NOT EXISTS swarm_lanes (
            id TEXT PRIMARY KEY,
            swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            rate_type TEXT NOT NULL,
            origin_port TEXT NOT NULL,
            destination_port TEXT NOT NULL,
            sailing_date TEXT NOT NULL,
            container_type TEXT NOT NULL CHECK (container_type IN ('20D', '40D', '40HC')),
            allow_alternative_routes INTEGER NOT NULL CHECK (allow_alternative_routes IN (0, 1)),
            allow_booking_request INTEGER NOT NULL CHECK (allow_booking_request IN (0, 1)),
            price_min REAL,
            price_max REAL,
            booking_slots INTEGER,
            accept_max_slots INTEGER NOT NULL DEFAULT 0 CHECK (accept_max_slots IN (0, 1)),
            priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
            date_flex_days INTEGER NOT NULL DEFAULT 0 CHECK (
                typeof(date_flex_days) = 'integer' AND date_flex_days BETWEEN 0 AND 14
            ),
            UNIQUE (swarm_id, position),
            CHECK (
                booking_slots IS NULL OR (
                    typeof(booking_slots) = 'integer' AND booking_slots BETWEEN 1 AND ${MAX_BOOKING_SLOTS}
                )
            ),
            CHECK (
                (allow_booking_request = 0 AND price_min IS NULL AND price_max IS NULL)
                OR (allow_booking_request = 1 AND price_min IS NOT NULL AND price_max IS NOT NULL
                    AND price_min >= 0 AND price_min <= price_max)
            )
        );
    `);
}

module.exports = {
    id: '020',
    description: 'Add company swarm settings, swarms, and swarm lanes.',
    up
};
