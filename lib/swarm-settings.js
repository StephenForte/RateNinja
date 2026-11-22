'use strict';

const { db, transaction } = require('./db');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { getCompanyByRecordId } = require('./store');
const { recordAudit, EVENT_SWARM_SETTINGS_UPDATED } = require('./audit');
const { encryptBbsToken, tokenIsReadable } = require('./swarm-secrets');

const PROJECT = /^[a-z0-9._-]{1,64}$/;

function companyTypeOf(company) {
    return company?.fields?.CompanyType || '';
}

class SettingsError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function present(companyId, name, row) {
    return {
        companyId,
        name: name || '',
        enabled: row?.enabled === 1,
        bbsProject: row?.bbs_project || null,
        hasBbsToken: tokenIsReadable(row?.bbs_token_enc),
        updatedAt: row?.updated_at || null
    };
}

function listCompanies() {
    const rows = db.prepare(`
        SELECT c.id, c.company_name, s.enabled, s.bbs_project, s.bbs_token_enc, s.updated_at
        FROM companies c
        LEFT JOIN company_types ct ON ct.id = c.company_type_id
        LEFT JOIN company_swarm_settings s ON s.company_id = c.id
        WHERE COALESCE(NULLIF(ct.name, ''), c.company_type) = ?
        ORDER BY c.company_name COLLATE NOCASE, c.id
    `).all(COMPANY_TYPE_CUSTOMER);
    return rows.map(row => present(row.id, row.company_name, row));
}

function parseProject(value) {
    if (value === null) return null;
    if (typeof value !== 'string') {
        throw new SettingsError(400, 'Provide bbsProject as a project name or null.');
    }
    const project = value.trim();
    if (!PROJECT.test(project)) {
        throw new SettingsError(400, 'Provide bbsProject as 1 to 64 characters of lowercase letters, digits, dot, underscore or hyphen, or null.');
    }
    return project;
}

function nextToken(existingEnc, body) {
    if (!Object.prototype.hasOwnProperty.call(body, 'bbsToken')) {
        return { enc: existingEnc, tokenChanged: false };
    }
    if (body.bbsToken === null) {
        return { enc: null, tokenChanged: existingEnc != null };
    }
    if (typeof body.bbsToken !== 'string' || body.bbsToken.length === 0) {
        throw new SettingsError(400, 'Provide bbsToken as a non-empty string or null, or omit it.');
    }
    try {
        return { enc: encryptBbsToken(body.bbsToken), tokenChanged: true };
    } catch {
        throw new SettingsError(500, 'Server configuration is incomplete. Set SESSION_SECRET.');
    }
}

function updateCompany(actor, companyId, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new SettingsError(400, 'Send swarm settings as a JSON object.');
    }
    const company = getCompanyByRecordId(companyId);
    if (!company) throw new SettingsError(404, 'Company not found.');
    if (companyTypeOf(company) !== COMPANY_TYPE_CUSTOMER) {
        throw new SettingsError(422, 'Swarm settings apply only to a customer company.', 'customer_only');
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'enabled') || typeof body.enabled !== 'boolean') {
        throw new SettingsError(400, 'Provide enabled as true or false.');
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'bbsProject')) {
        throw new SettingsError(400, 'Provide bbsProject as a project name or null.');
    }
    const project = parseProject(body.bbsProject);
    return transaction(() => {
        const existing = db.prepare('SELECT * FROM company_swarm_settings WHERE company_id = ?').get(companyId);
        const token = nextToken(existing ? existing.bbs_token_enc : null, body);
        if (body.enabled && (!project || !tokenIsReadable(token.enc))) {
            throw new SettingsError(422, 'Enabling a swarm requires a CloudBBS project and a readable token.', 'swarm_settings_incomplete');
        }
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO company_swarm_settings (
                company_id, enabled, bbs_project, bbs_token_enc, updated_at, updated_by_user_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(company_id) DO UPDATE SET
                enabled = excluded.enabled,
                bbs_project = excluded.bbs_project,
                bbs_token_enc = excluded.bbs_token_enc,
                updated_at = excluded.updated_at,
                updated_by_user_id = excluded.updated_by_user_id
        `).run(companyId, body.enabled ? 1 : 0, project, token.enc, now, actor.id);
        recordAudit(EVENT_SWARM_SETTINGS_UPDATED, {
            actorUserId: actor.id,
            detail: {
                companyId,
                enabled: body.enabled,
                bbsProject: project,
                tokenChanged: token.tokenChanged
            }
        });
        const row = db.prepare('SELECT * FROM company_swarm_settings WHERE company_id = ?').get(companyId);
        return present(companyId, company.fields?.CompanyName, row);
    });
}

module.exports = {
    SettingsError,
    listCompanies,
    updateCompany
};
