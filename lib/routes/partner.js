const { securityHeaders, sendJson } = require('../http');
const {
    recordAudit,
    EVENT_PARTNER_RATE_DATE_RANGES_READ,
    EVENT_PARTNER_ORIGIN_PORTS_READ,
    EVENT_PARTNER_DESTINATION_PORTS_READ,
    EVENT_PARTNER_CONTRACT_OWNERS_READ,
    EVENT_PARTNER_SAILING_DATE_RANGES_READ,
    EVENT_PARTNER_PREDICTIVE_DATE_RANGES_READ
} = require('../audit');
const { requirePartnerAccess, pageArgs, sendOAuthError } = require('../partner-http');
const { listOwnerPredictive } = require('../predictive');
const {
    listRateDateRanges,
    listValidOriginPorts,
    listValidDestinationPorts,
    listValidContractOwners,
    listSailingDateRanges,
    listPredictiveDateRanges
} = require('../reference-ranges');

function handlePartnerPredictive(request, response) {
    const access = requirePartnerAccess(request, response, 'rates:read');
    if (!access) return;
    const url = new URL(request.url, 'http://localhost');
    const query = pageArgs(url.searchParams);
    if (query.error) return sendOAuthError(response, 400, 'invalid_request', query.error);
    if (!query.after) return sendOAuthError(response, 400, 'invalid_request', 'after query parameter is required.');
    const payload = listOwnerPredictive(access, query);
    if (payload.error) return sendOAuthError(response, 400, 'invalid_request', payload.error);
    recordAudit('partner_predictive_read', {
        actorUserId: access.sub,
        clientId: access.clientId,
        detail: { count: payload.data.length }
    });
    sendJson(response, 200, payload, securityHeaders());
}

function handleReferenceList(request, response, {
    scope,
    audience = 'owner',
    eventType,
    loader
}) {
    const access = requirePartnerAccess(request, response, scope, audience);
    if (!access) return;
    const url = new URL(request.url, 'http://localhost');
    const query = pageArgs(url.searchParams);
    if (query.error) return sendOAuthError(response, 400, 'invalid_request', query.error);
    const payload = loader(access, query);
    recordAudit(eventType, {
        actorUserId: access.sub,
        clientId: access.clientId,
        detail: { count: payload.data.length }
    });
    sendJson(response, 200, payload, securityHeaders());
}

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/partner/v1/me/predictive-pricing',
            access: 'public',
            handler: handlePartnerPredictive
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/rate-date-ranges',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'rates:read',
                audience: 'either',
                eventType: EVENT_PARTNER_RATE_DATE_RANGES_READ,
                loader: listRateDateRanges
            })
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/origin-ports',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'rates:read',
                audience: 'either',
                eventType: EVENT_PARTNER_ORIGIN_PORTS_READ,
                loader: listValidOriginPorts
            })
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/destination-ports',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'rates:read',
                audience: 'either',
                eventType: EVENT_PARTNER_DESTINATION_PORTS_READ,
                loader: listValidDestinationPorts
            })
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/contract-owners',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'rates:read',
                audience: 'either',
                eventType: EVENT_PARTNER_CONTRACT_OWNERS_READ,
                loader: listValidContractOwners
            })
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/sailing-date-ranges',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'sailings:read',
                audience: 'owner',
                eventType: EVENT_PARTNER_SAILING_DATE_RANGES_READ,
                loader: listSailingDateRanges
            })
        },
        {
            method: 'GET',
            path: '/api/partner/v1/me/predictive-date-ranges',
            access: 'public',
            handler: (request, response) => handleReferenceList(request, response, {
                scope: 'rates:read',
                audience: 'owner',
                eventType: EVENT_PARTNER_PREDICTIVE_DATE_RANGES_READ,
                loader: listPredictiveDateRanges
            })
        }
    ]
};
