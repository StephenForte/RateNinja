'use strict';

const KEYS = {
    admin: 'distinctive-r145-synthetic-admin-key',
    claude: 'distinctive-r145-synthetic-claude-key',
    cloud: 'distinctive-r145-synthetic-cloud-token'
};

const NOON = Date.parse('2026-11-20T12:00:00.000Z');

function assertNoSecrets(text) {
    const haystack = String(text);
    for (const secret of Object.values(KEYS)) {
        if (haystack.includes(secret)) {
            throw new Error('A run summary or response contains a secret.');
        }
    }
}

function insertAgent(db, { id, companyId, userId, status = 'queued', summary = null }) {
    const finished = status === 'queued' || status === 'running' ? null : '2026-11-20T01:00:00.000Z';
    db.prepare(`
        INSERT INTO managed_agents (
            id, batch_id, company_id, created_by_user_id, status, rate_type, origin_port, destination_port,
            sailing_date, container_type, allow_alternative_routes, allow_booking_request,
            created_at, updated_at, finished_at, result_summary
        ) VALUES (?, 'batch', ?, ?, ?, 'FAK', 'SHA', 'LAX', '2026-12-01', '20D', 0, 0,
            '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', ?, ?)
    `).run(id, companyId, userId, status, finished, summary);
}

async function until(read, ms = 8000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < ms) {
        last = read();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error(`Timed out waiting for a run to finish: ${JSON.stringify(last)}`);
}

module.exports = { KEYS, NOON, assertNoSecrets, insertAgent, until };
