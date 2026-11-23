'use strict';

const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { db } = require('./db');
const { COMPANY_ROLE_ADMIN, isContractOwnerAdmin, isSystemAdmin } = require('./permissions');
const { companyForUser, getUserById } = require('./store');
const { presentRun } = require('./swarm-runs');
const { SwarmError } = require('./swarms');

function loadReadActor(userId) {
    const roles = db.prepare('SELECT company_role, is_system_admin FROM users WHERE id = ?').get(userId);
    if (!roles) return null;
    const isCompanyAdmin = roles.company_role === COMPANY_ROLE_ADMIN;
    const isSystemAdmin = roles.is_system_admin === 1;
    let company = null;
    if (isCompanyAdmin && !isSystemAdmin) {
        // Resolve legacy references without backfilling users.company_record_id on a GET.
        company = companyForUser({ ...getUserById(userId), id: undefined });
    }
    return { isCompanyAdmin, isSystemAdmin, company };
}

function visibleCustomers(actor) {
    const systemAdmin = isSystemAdmin(actor);
    if (!systemAdmin && !isContractOwnerAdmin(actor, actor?.company)) {
        throw new SwarmError(403, 'Administrator access is required.');
    }
    return [COMPANY_TYPE_CUSTOMER, systemAdmin ? 1 : 0, systemAdmin ? null : actor.company.id];
}

const VISIBLE_CUSTOMERS = `
    WITH visible_customers AS (
        SELECT c.id, c.company_name AS name
        FROM companies c
        LEFT JOIN company_types ct ON ct.id = c.company_type_id
        WHERE COALESCE(NULLIF(ct.name, ''), c.company_type) = ?
          AND (? = 1 OR EXISTS (
              SELECT 1 FROM company_margins m
              WHERE m.owner_company_id = ? AND m.customer_company_id = c.id AND m.status = 'active'
          ))
    )
`;

function listCompanies(actor) {
    return db.prepare(`${VISIBLE_CUSTOMERS}
        SELECT c.id AS companyId, c.name, count(*) AS runCount,
               max(r.started_at) AS lastStartedAt, max(r.status = 'running') AS running
        FROM visible_customers c JOIN swarm_runs r ON r.company_id = c.id
        GROUP BY c.id, c.name
        ORDER BY c.name COLLATE NOCASE, c.id
    `).all(...visibleCustomers(actor)).map(row => ({ ...row, running: row.running === 1 }));
}

function presentAdminRun(row, includeAgents = false) {
    return { ...presentRun(row, includeAgents), companyId: row.company_id, companyName: row.company_name };
}

function listRuns(actor, companyId) {
    const scope = visibleCustomers(actor);
    if (!companyId?.trim()) throw new SwarmError(400, 'Provide companyId.');
    const rows = db.prepare(`${VISIBLE_CUSTOMERS}
        SELECT r.*, c.name AS company_name
        FROM visible_customers c LEFT JOIN swarm_runs r ON r.company_id = c.id
        WHERE c.id = ?
        ORDER BY r.started_at DESC, r.rowid DESC LIMIT 50
    `).all(...scope, companyId);
    if (!rows.length) throw new SwarmError(404, 'Customer company not found.');
    // The left join distinguishes a visible company with no runs from an unknown company.
    return rows.filter(row => row.id !== null).map(row => presentAdminRun(row));
}

function getRun(actor, id) {
    const row = db.prepare(`${VISIBLE_CUSTOMERS}
        SELECT r.*, c.name AS company_name
        FROM swarm_runs r JOIN visible_customers c ON c.id = r.company_id
        WHERE r.id = ?
    `).get(...visibleCustomers(actor), id);
    if (!row) throw new SwarmError(404, 'Swarm run not found.');
    return presentAdminRun(row, true);
}

module.exports = { loadReadActor, listCompanies, listRuns, getRun };
