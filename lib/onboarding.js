'use strict';

const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CUSTOMER_ID,
    PASSWORD_HASH_VERSION
} = require('./constants');
const { hashPassword, validatePassword } = require('./passwords');
const { normalizeEmail, markTemporaryPassword } = require('./accounts');
const { insertCompanyRow, insertUserRow, userIdForLogin, companyByName } = require('./store');
const { recordAudit } = require('./audit');

const HANDOFF = 'Give the temporary password to this administrator yourself. Rate Ninja will not email it. They must replace it before they can use the account.';

const COMPANY_TYPES = {
    [COMPANY_TYPE_CONTRACT_OWNER]: COMPANY_TYPE_CONTRACT_OWNER_ID,
    [COMPANY_TYPE_CUSTOMER]: COMPANY_TYPE_CUSTOMER_ID
};

function refusal(status, error) {
    const failure = new Error(error);
    failure.refusal = true;
    failure.status = status;
    return failure;
}

function requiredText(value, label, max) {
    if (typeof value !== 'string') return { error: `Enter a ${label}.` };
    const text = value.trim();
    if (!text) return { error: `Enter a ${label}.` };
    if (text.length > max) return { error: `${label} must be ${max} characters or fewer.` };
    return { text };
}

function parseSubmissionId(value) {
    if (typeof value !== 'string') return { error: 'submissionId is required.' };
    const text = value.trim();
    if (!text || text.length > 200 || /\s/.test(text)) return { error: 'submissionId is required.' };
    return { text };
}

function parseLoginName(value) {
    if (typeof value !== 'string') return { error: 'Enter a login name.' };
    const text = value.trim();
    if (!text) return { error: 'Enter a login name.' };
    if (text.length > 254) return { error: 'Login name must be 254 characters or fewer.' };
    if (/[\s\u0000-\u001f]/.test(text)) return { error: 'Login name cannot contain spaces.' };
    return { text };
}

function loginConflict(error) {
    return /UNIQUE/i.test(String(error && error.message || ''));
}

function storedSubmission(submissionId) {
    const row = db.prepare('SELECT result_json FROM onboarding_submissions WHERE submission_id = ?').get(submissionId);
    if (!row) return null;
    return JSON.parse(row.result_json);
}

function validateOnboarding(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, status: 400, error: 'Company details are required.' };
    }
    const submission = parseSubmissionId(body.submissionId);
    if (submission.error) return { ok: false, status: 400, error: submission.error };
    const companyName = requiredText(body.companyName, 'company name', 200);
    if (companyName.error) return { ok: false, status: 400, error: companyName.error };
    const companyType = typeof body.companyType === 'string' ? body.companyType.trim() : '';
    const typeId = COMPANY_TYPES[companyType];
    if (!typeId) {
        return { ok: false, status: 400, error: 'Company type must be Contract Owner or Freight Forwarder/Customer.' };
    }
    const admin = body.admin;
    if (!admin || typeof admin !== 'object' || Array.isArray(admin)) {
        return { ok: false, status: 400, error: 'Initial administrator details are required.' };
    }
    const displayName = requiredText(admin.displayName, 'display name', 200);
    if (displayName.error) return { ok: false, status: 400, error: displayName.error };
    const parsedEmail = normalizeEmail(admin.email);
    if (parsedEmail.error || !parsedEmail.email) {
        return { ok: false, status: 400, error: parsedEmail.error || 'Enter a valid email address.' };
    }
    const loginSource = typeof admin.loginName === 'string' && admin.loginName.trim()
        ? admin.loginName
        : parsedEmail.email;
    const loginName = parseLoginName(loginSource);
    if (loginName.error) return { ok: false, status: 400, error: loginName.error };
    const problem = validatePassword(admin.temporaryPassword);
    if (problem) return { ok: false, status: 400, error: problem };
    return {
        ok: true,
        submissionId: submission.text,
        companyName: companyName.text,
        companyType,
        typeId,
        displayName: displayName.text,
        email: parsedEmail.email,
        loginName: loginName.text,
        temporaryPassword: admin.temporaryPassword
    };
}

function successResult({ companyId, companyName, companyType, userId, displayName, loginName, email }) {
    return {
        ok: true,
        summary: `${companyName} was created as a ${companyType}. ${displayName} (${loginName}) is the company administrator.`,
        company: { id: companyId, name: companyName, companyType },
        admin: {
            id: userId,
            displayName,
            loginName,
            email,
            role: 'company_admin'
        },
        handoff: HANDOFF
    };
}

function nameCheck(query) {
    const parsed = requiredText(query, 'company name', 200);
    if (parsed.error) return { ok: false, status: 400, error: parsed.error };
    const existing = companyByName(parsed.text);
    return {
        ok: true,
        q: parsed.text,
        match: Boolean(existing),
        warning: existing ? `A company named "${existing.company_name}" already exists.` : ''
    };
}

function onboardCompany(body, actorUserId) {
    const submissionId = body && typeof body.submissionId === 'string' ? body.submissionId.trim() : '';
    if (submissionId && !/\s/.test(submissionId)) {
        const prior = storedSubmission(submissionId);
        if (prior) return { ok: true, result: prior };
    }
    const parsed = validateOnboarding(body);
    if (!parsed.ok) return parsed;
    const passwordHash = hashPassword(parsed.temporaryPassword);
    try {
        const result = transaction(() => {
            const prior = storedSubmission(parsed.submissionId);
            if (prior) return prior;
            if (userIdForLogin(parsed.loginName)) {
                throw refusal(400, 'That login name is already in use.');
            }
            const companyId = crypto.randomUUID();
            const userId = crypto.randomUUID();
            insertCompanyRow({
                id: companyId,
                name: parsed.companyName,
                typeName: parsed.companyType,
                typeId: parsed.typeId,
                admin: parsed.typeId === COMPANY_TYPE_CONTRACT_OWNER_ID
            });
            insertUserRow({
                id: userId,
                username: parsed.loginName,
                displayName: parsed.displayName,
                companyRecordId: companyId,
                companyBusinessId: companyId,
                rateView: companyId,
                adminScreen: true,
                companyRole: 'company_admin',
                email: parsed.email,
                passwordHash,
                passwordHashVersion: PASSWORD_HASH_VERSION,
                mustChangePassword: true
            });
            markTemporaryPassword(userId, actorUserId);
            const created = successResult({
                companyId,
                companyName: parsed.companyName,
                companyType: parsed.companyType,
                userId,
                displayName: parsed.displayName,
                loginName: parsed.loginName,
                email: parsed.email
            });
            db.prepare(`
                INSERT INTO onboarding_submissions (submission_id, company_id, user_id, result_json, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(parsed.submissionId, companyId, userId, JSON.stringify(created), new Date().toISOString());
            recordAudit('company_onboarded', {
                actorUserId,
                detail: { companyId, userId, companyType: parsed.companyType }
            });
            return created;
        });
        return { ok: true, result };
    } catch (error) {
        if (error.refusal) return { ok: false, status: error.status, error: error.message };
        if (loginConflict(error)) return { ok: false, status: 400, error: 'That login name is already in use.' };
        throw error;
    }
}

module.exports = {
    HANDOFF,
    nameCheck,
    onboardCompany
};
