const { securityHeaders, sendJson } = require('../http');
const { recordAudit } = require('../audit');
const { requirePartnerAccess, pageArgs, sendOAuthError } = require('../partner-http');
const { listOwnerPredictive } = require('../predictive');

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

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/partner/v1/me/predictive-pricing',
            access: 'public',
            handler: handlePartnerPredictive
        }
    ]
};
