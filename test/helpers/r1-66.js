'use strict';

const {
    activate, insertCompany, insertMargin, insertUser, COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER
} = require('./r1-19');

const STARTED = '2026-11-23T01:00:00.000Z';
const LATEST = '2026-11-23T02:00:00.000Z';
const INSTRUCTIONS = 'Synthetic confidential swarm instructions';
const PROJECT = 'synthetic.private.project';
const TOKEN = 'synthetic-token-value';
const THREAD = 'synthetic-private-thread';
const REPORT = '<script>synthetic report</script>';
const CUSTOMERS = { c1: 'Alpha Synthetic', c2: 'Bravo Synthetic', c3: 'Charlie Synthetic', c4: 'Delta Synthetic' };

function seedRun(db, companyId, id, { startedAt = STARTED, status = 'completed' } = {}) {
    const snapshot = JSON.stringify({ name: `Swarm ${id}`, instructions: INSTRUCTIONS, totalSpendCap: 150, totalSlotsCap: 4 });
    db.prepare(`
        INSERT INTO swarm_runs (
            id, swarm_id, company_id, started_by_user_id, status, snapshot, started_at, finished_at,
            input_tokens, output_tokens, bbs_thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 111, 222, ?)
    `).run(id, `definition-${id}`, companyId, `starter-${companyId}`, status, snapshot, startedAt,
        status === 'running' ? null : LATEST, THREAD);
    db.prepare(`
        INSERT INTO swarm_run_agents (
            id, run_id, role, lane_position, attempt, status, started_at, report, rate_id, price, slots, booking_request_id
        ) VALUES (?, ?, 'booking', 1, 1, 'completed', ?, ?, 'synthetic-rate', 42.5, 2, 'synthetic-booking')
    `).run(`agent-${id}`, id, startedAt, REPORT);
}

function seed(db, { smoke = false, password } = {}) {
    insertCompany(db, { id: 'owner-a', name: 'Synthetic Owner A', type: COMPANY_TYPE_CONTRACT_OWNER });
    insertCompany(db, { id: 'owner-b', name: 'Synthetic Owner B', type: COMPANY_TYPE_CONTRACT_OWNER });
    for (const [id, name] of Object.entries(CUSTOMERS).slice(0, smoke ? 2 : undefined).reverse()) {
        insertCompany(db, { id, name, type: COMPANY_TYPE_CUSTOMER });
    }
    insertMargin(db, { id: 'link-a-1', owner: 'owner-a', customer: 'c1', percent: 10 });

    const users = [
        { id: 'r166-system', companyId: null, systemAdmin: true },
        { id: 'r166-owner-a', companyId: 'owner-a', role: 'company_admin' },
        { id: 'r166-customer-admin', companyId: 'c1', role: 'company_admin' }
    ];
    if (!smoke) {
        users.push(
            { id: 'r166-owner-b', companyId: 'owner-b', role: 'company_admin' },
            { id: 'r166-customer-member', companyId: 'c1' },
            { id: 'r166-owner-member', companyId: 'owner-a' }
        );
        insertMargin(db, { id: 'link-a-2', owner: 'owner-a', customer: 'c2', percent: 10, status: 'revoked' });
        db.prepare(`
            INSERT INTO company_swarm_settings (company_id, bbs_project, bbs_token_enc, updated_at, updated_by_user_id)
            VALUES ('c1', ?, ?, ?, 'r166-system')
        `).run(PROJECT, TOKEN, STARTED);
        for (let i = 1; i <= 51; i++) seedRun(db, 'c1', `old-${i}`);
        seedRun(db, 'c3', 'run-c3');
        seedRun(db, 'owner-a', 'run-owner');
    }
    for (const user of users) {
        insertUser(db, { ...user, username: user.id });
        activate(user.id, password);
    }
    seedRun(db, 'c1', 'run-c1', { startedAt: LATEST, status: 'running' });
    seedRun(db, 'c2', 'run-c2');
}

module.exports = { seed, STARTED, LATEST, INSTRUCTIONS, PROJECT, TOKEN, THREAD, REPORT, CUSTOMERS };
