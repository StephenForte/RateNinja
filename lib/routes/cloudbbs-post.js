'use strict';

const { sendJson, securityHeaders } = require('../http');
const { isSystemAdmin, loadActor } = require('../permissions');
const { clientAgentSettings } = require('../client-agent');
const { cloudBbsSettings, postCloudBbs } = require('../cloudbbs-post');
const { clearBookingCodeCache } = require('../booking-code');
const { EVENT_CLOUDBBS_ANNOUNCEMENT_POSTED, recordAudit } = require('../audit');
const runs = require('../managed-agent-runs');

function reject(response, status, code, error) {
    sendJson(response, status, { error, code }, securityHeaders());
}

async function post(request, response, session) {
    const actor = loadActor(session.user.id);
    if (!actor || !isSystemAdmin(actor)) {
        return reject(response, 403, 'forbidden', 'System admin access is required.');
    }

    const { cloudBbsPost, windowClosed, runInProgress } = runs.readiness();
    if (!cloudBbsPost.configured) {
        return reject(response, 503, 'cloudbbs_not_configured', cloudBbsPost.disabledReason);
    }
    if (windowClosed) return reject(response, 423, 'post_window', cloudBbsPost.disabledReason);
    if (runInProgress) return reject(response, 409, 'run_in_progress', cloudBbsPost.disabledReason);
    if (cloudBbsPost.inProgress) return reject(response, 409, 'post_in_progress', cloudBbsPost.disabledReason);

    // The checks and lock acquisition are synchronous, as is run start through insertRun.
    const settings = cloudBbsSettings();
    return runs.withCloudBbsPost(async () => {
        let result;
        try {
            result = await postCloudBbs({
                settings,
                adminKey: process.env.RATE_NINJA_ADMIN_API_KEY,
                source: clientAgentSettings().baseUrl,
                fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' })
            });
        } catch {
            return reject(response, 502, 'cloudbbs_post_failed', 'Could not post the CloudBBS announcement.');
        }
        if (!result.ok) return reject(response, 502, 'cloudbbs_post_failed', result.reason);

        clearBookingCodeCache();
        // Forward only typed announcement metadata, never arbitrary upstream strings or objects.
        const version = Number.isSafeInteger(result.version) ? result.version : null;
        const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
        const updatedAt = typeof result.updatedAt === 'string' && isoTimestamp.test(result.updatedAt)
            ? result.updatedAt : null;
        recordAudit(EVENT_CLOUDBBS_ANNOUNCEMENT_POSTED, {
            actorUserId: session.user.id,
            detail: { project: settings.project, version }
        });
        return sendJson(response, 200, { version, updatedAt, byteLength: result.byteLength }, securityHeaders());
    });
}

module.exports = {
    routes: [
        { method: 'POST', path: '/api/managed-agents/cloudbbs-post', access: 'session', handler: post }
    ]
};
