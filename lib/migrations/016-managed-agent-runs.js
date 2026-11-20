'use strict';

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS managed_agent_runs (
            id TEXT PRIMARY KEY,
            started_by_user_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
            exit_code INTEGER,
            started_agent_ids TEXT NOT NULL DEFAULT '[]',
            summary TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_managed_agent_runs_started
            ON managed_agent_runs (started_at, id);

        CREATE UNIQUE INDEX IF NOT EXISTS managed_agent_runs_one_running
            ON managed_agent_runs (status) WHERE status = 'running';
    `);
}

module.exports = { id: '016', description: 'Record managed agent runs started from the website.', up };
