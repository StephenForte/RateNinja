'use strict';

function up(db) {
    // History retains the snapshot even after the saved swarm is deleted.
    db.exec(`
        CREATE TABLE swarm_runs (
            id TEXT PRIMARY KEY,
            swarm_id TEXT NOT NULL,
            company_id TEXT NOT NULL,
            started_by_user_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
            snapshot TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            summary TEXT,
            failure_reason TEXT,
            spend_booked REAL NOT NULL DEFAULT 0,
            slots_booked INTEGER NOT NULL DEFAULT 0,
            master_turns INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
            bbs_thread_id TEXT
        );
        CREATE UNIQUE INDEX swarm_runs_one_running ON swarm_runs(company_id) WHERE status = 'running';
        CREATE INDEX swarm_runs_company_start ON swarm_runs(company_id, started_at DESC);

        CREATE TABLE swarm_run_agents (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('master','search','booking')),
            lane_position INTEGER,
            attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
            status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
            origin_port TEXT,
            destination_port TEXT,
            sailing_date TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            report TEXT,
            rate_id TEXT,
            price REAL,
            slots INTEGER,
            booking_request_id TEXT,
            UNIQUE (run_id, role, lane_position, attempt)
        );
        CREATE INDEX swarm_run_agents_start ON swarm_run_agents(run_id, started_at);
    `);
}

module.exports = { id: '021', description: 'Add swarm runs and their agents.', up };
