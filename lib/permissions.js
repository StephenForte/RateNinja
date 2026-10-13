'use strict';

const { db } = require('./db');
const { COMPANY_TYPE_CONTRACT_OWNER, COMPANY_TYPE_CUSTOMER } = require('./constants');
const { companyForUser, getCompanyByRecordId, getUserById } = require('./store');
const { passwordChangeRequired } = require('./accounts');

const COMPANY_ROLE_ADMIN = 'company_admin';

function companyTypeOf(company) {
    return company?.fields?.CompanyType || '';
}

function loadActor(userId) {
    if (!userId) return null;
    const row = db.prepare('SELECT company_role, is_system_admin FROM users WHERE id = ?').get(userId);
    const user = getUserById(userId);
    if (!row || !user) return null;
    const company = companyForUser(user);
    return {
        ...user,
        companyRole: row.company_role || 'member',
        isSystemAdmin: row.is_system_admin === 1,
        isCompanyAdmin: row.company_role === COMPANY_ROLE_ADMIN,
        company
    };
}

function isSystemAdmin(user) {
    return Boolean(user && user.isSystemAdmin);
}

function isCompanyAdmin(user) {
    return Boolean(user && user.isCompanyAdmin);
}

function isContractOwnerAdmin(user, company) {
    if (!isCompanyAdmin(user) || !company) return false;
    if (companyTypeOf(company) !== COMPANY_TYPE_CONTRACT_OWNER) return false;
    const home = user.company || companyForUser(user);
    return Boolean(home && home.id === company.id);
}

function contextCompany(company) {
    if (!company) return null;
    return { id: company.id, name: company.fields?.CompanyName || '' };
}

// System admins never fall back to their own company. Company admins always
// resolve to their own company and cannot select another.
function resolveCompanyContext(session) {
    if (!session?.user?.id) {
        return { ok: false, status: 401, error: 'Please sign in to continue.' };
    }
    const actor = loadActor(session.user.id);
    if (!actor || actor.disabled) {
        return { ok: false, status: 401, error: 'Please sign in to continue.' };
    }
    if (isSystemAdmin(actor)) {
        if (!session.companyContextId) {
            return {
                ok: false,
                status: 409,
                code: 'company_context_required',
                error: 'Select a company before administering it.'
            };
        }
        const company = getCompanyByRecordId(session.companyContextId);
        if (!company) {
            return {
                ok: false,
                status: 409,
                code: 'company_context_required',
                error: 'Select a company before administering it.'
            };
        }
        return { ok: true, actor, company };
    }
    if (isCompanyAdmin(actor)) {
        if (!actor.company) {
            return { ok: false, status: 403, error: 'Administrator access is required.' };
        }
        return { ok: true, actor, company: actor.company };
    }
    return { ok: false, status: 403, error: 'Administrator access is required.' };
}

function companyContextMismatch(body, company) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !company) return null;
    if (!Object.prototype.hasOwnProperty.call(body, 'companyId')) return null;
    if (body.companyId === company.id) return null;
    return {
        ok: false,
        status: 409,
        code: 'company_context_mismatch',
        error: 'The company in this request does not match the selected company.'
    };
}

function canManageUser(actor, target, context) {
    if (!actor || !context?.company || !target) return false;
    const managesThisCompany = isSystemAdmin(actor)
        || (isCompanyAdmin(actor) && actor.company && actor.company.id === context.company.id);
    if (!managesThisCompany) return false;
    const targetCompany = companyForUser(target);
    return Boolean(targetCompany && targetCompany.id === context.company.id);
}

function canAdministerOwnerData(actor, context) {
    if (!actor || !context?.company) return false;
    if (companyTypeOf(context.company) !== COMPANY_TYPE_CONTRACT_OWNER) return false;
    if (isSystemAdmin(actor)) return true;
    return isContractOwnerAdmin(actor, context.company);
}

function marginTargetInScope(context, targetCompany) {
    if (!context?.company || !targetCompany) return false;
    if (targetCompany.id === context.company.id) return false;
    return companyTypeOf(targetCompany) === COMPANY_TYPE_CUSTOMER;
}

function publicSessionUser(userId, companyContextId) {
    const actor = loadActor(userId);
    const company = actor?.company || null;
    const companyType = companyTypeOf(company);
    const systemAdmin = isSystemAdmin(actor);
    const companyAdmin = isCompanyAdmin(actor);
    const contractOwner = companyType === COMPANY_TYPE_CONTRACT_OWNER;
    let companyContext = null;
    if (systemAdmin) {
        if (companyContextId) companyContext = contextCompany(getCompanyByRecordId(companyContextId));
    } else if (companyAdmin) {
        companyContext = contextCompany(company);
    }
    return {
        username: actor?.displayName || actor?.username || '',
        loginName: actor?.username || '',
        companyName: company?.fields?.CompanyName || '',
        companyType,
        permissions: {
            systemAdmin,
            companyAdmin,
            contractOwner
        },
        mustChangePassword: passwordChangeRequired(userId),
        companyContext,
        isAdmin: companyAdmin,
        isContractOwner: contractOwner
    };
}

module.exports = {
    COMPANY_ROLE_ADMIN,
    loadActor,
    isSystemAdmin,
    isCompanyAdmin,
    isContractOwnerAdmin,
    resolveCompanyContext,
    companyContextMismatch,
    canManageUser,
    canAdministerOwnerData,
    marginTargetInScope,
    publicSessionUser
};
