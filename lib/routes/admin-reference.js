'use strict';

const { sendJson, securityHeaders } = require('../http');
const { requireAdminApiAccess } = require('../admin-api-key');
const { pageArgs } = require('../partner-http');
const { getCompanyByRecordId, getAllCompanies } = require('../store');
const { partnerAudienceError } = require('../permissions');
const { ALLOCATION_NOTICE } = require('../visibility');
const {
    recordAudit,
    EVENT_ADMIN_REFERENCE_RATE_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_ORIGIN_PORTS_READ,
    EVENT_ADMIN_REFERENCE_DESTINATION_PORTS_READ,
    EVENT_ADMIN_REFERENCE_CONTRACT_OWNERS_READ,
    EVENT_ADMIN_REFERENCE_SAILING_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_PREDICTIVE_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_COMPANIES_READ
} = require('../audit');
const {
    accessFromCompany,
    listRateDateRanges,
    listValidOriginPorts,
    listValidDestinationPorts,
    listValidContractOwners,
    listSailingDateRanges,
    listPredictiveDateRanges,
    listRateDateRangesAllOwners,
    listValidOriginPortsAllOwners,
    listValidDestinationPortsAllOwners,
    listValidContractOwnersAllOwners,
    listSailingDateRangesAllOwners,
    listPredictiveDateRangesAllOwners
} = require('../reference-ranges');

function compareText(left, right) {
    return String(left ?? '').localeCompare(String(right ?? ''));
}

function paginate(rows, page, pageSize) {
    const start = (page - 1) * pageSize;
    const data = rows.slice(start, start + pageSize);
    return {
        data,
        meta: {
            total: rows.length,
            page,
            pageSize,
            returned: data.length,
            notice: ALLOCATION_NOTICE
        }
    };
}

function listCompanies(query) {
    const rows = getAllCompanies()
        .map(company => ({
            id: company.id,
            name: company.fields?.CompanyName || '',
            companyType: company.fields?.CompanyType || ''
        }))
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
    return paginate(rows, query.page, query.pageSize);
}

function sendAdminError(response, status, error) {
    sendJson(response, status, { error }, securityHeaders());
}

function parseAdminQuery(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const query = pageArgs(url.searchParams);
    if (query.error) {
        sendAdminError(response, 400, 'invalid_request');
        return null;
    }
    const company = (url.searchParams.get('company') || '').trim();
    return { ...query, company: company || null };
}

function resolveCompanyAccess(companyId, audience) {
    const company = getCompanyByRecordId(companyId);
    if (!company) return { error: 'not_found', status: 404 };
    const access = accessFromCompany(company);
    const audienceError = partnerAudienceError(access.companyType, audience);
    if (audienceError) return { error: audienceError, status: 403 };
    return { access, company };
}

function handleAdminReference(request, response, {
    eventType,
    audience = 'either',
    companyLoader,
    allOwnersLoader
}) {
    if (!requireAdminApiAccess(request, response)) return;
    const query = parseAdminQuery(request, response);
    if (!query) return;

    let payload;
    if (query.company) {
        const resolved = resolveCompanyAccess(query.company, audience);
        if (resolved.error) {
            sendAdminError(response, resolved.status, resolved.error);
            return;
        }
        payload = companyLoader(resolved.access, query);
    } else {
        payload = allOwnersLoader(query);
    }

    recordAudit(eventType, {
        detail: { count: payload.data.length, company: query.company }
    });
    sendJson(response, 200, payload, securityHeaders());
}

function handleCompanies(request, response) {
    if (!requireAdminApiAccess(request, response)) return;
    const query = parseAdminQuery(request, response);
    if (!query) return;
    const payload = listCompanies(query);
    recordAudit(EVENT_ADMIN_REFERENCE_COMPANIES_READ, {
        detail: { count: payload.data.length, company: query.company }
    });
    sendJson(response, 200, payload, securityHeaders());
}

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/admin/v1/reference/rate-date-ranges',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_RATE_DATE_RANGES_READ,
                audience: 'either',
                companyLoader: listRateDateRanges,
                allOwnersLoader: listRateDateRangesAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/origin-ports',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_ORIGIN_PORTS_READ,
                audience: 'either',
                companyLoader: listValidOriginPorts,
                allOwnersLoader: listValidOriginPortsAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/destination-ports',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_DESTINATION_PORTS_READ,
                audience: 'either',
                companyLoader: listValidDestinationPorts,
                allOwnersLoader: listValidDestinationPortsAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/contract-owners',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_CONTRACT_OWNERS_READ,
                audience: 'either',
                companyLoader: listValidContractOwners,
                allOwnersLoader: listValidContractOwnersAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/sailing-date-ranges',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_SAILING_DATE_RANGES_READ,
                audience: 'owner',
                companyLoader: listSailingDateRanges,
                allOwnersLoader: listSailingDateRangesAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/predictive-date-ranges',
            access: 'public',
            handler: (request, response) => handleAdminReference(request, response, {
                eventType: EVENT_ADMIN_REFERENCE_PREDICTIVE_DATE_RANGES_READ,
                audience: 'owner',
                companyLoader: listPredictiveDateRanges,
                allOwnersLoader: listPredictiveDateRangesAllOwners
            })
        },
        {
            method: 'GET',
            path: '/api/admin/v1/reference/companies',
            access: 'public',
            handler: handleCompanies
        }
    ]
};
