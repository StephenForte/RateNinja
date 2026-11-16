'use strict';

const BODY_SIZE_CAP = 262144;
const ANNOUNCEMENT_TITLE = 'RateNinja reference data';
const REFERENCE_SCHEMA = 'rateninja.reference.v1';
const DEFAULT_CLOUDBBS_URL = 'https://cloudbbs.ai';
const DEFAULT_CLOUDBBS_PROJECT = 'rn';
const ADMIN_PAGE_SIZE = 100;

const REFERENCE_READS = [
    {
        key: 'rateDateRanges',
        name: 'rate-date-ranges',
        path: '/api/admin/v1/reference/rate-date-ranges'
    },
    {
        key: 'originPorts',
        name: 'origin-ports',
        path: '/api/admin/v1/reference/origin-ports'
    },
    {
        key: 'destinationPorts',
        name: 'destination-ports',
        path: '/api/admin/v1/reference/destination-ports'
    },
    {
        key: 'contractOwners',
        name: 'contract-owners',
        path: '/api/admin/v1/reference/contract-owners'
    },
    {
        key: 'sailingDateRanges',
        name: 'sailing-date-ranges',
        path: '/api/admin/v1/reference/sailing-date-ranges'
    },
    {
        key: 'predictiveDateRanges',
        name: 'predictive-date-ranges',
        path: '/api/admin/v1/reference/predictive-date-ranges'
    }
];

function normalizeBaseUrl(value, fallback) {
    if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\/$/, '');
    }
    return fallback;
}

function cloudBbsSettings(env = process.env) {
    return {
        url: normalizeBaseUrl(env.CLOUDBBS_URL, DEFAULT_CLOUDBBS_URL),
        project: (typeof env.CLOUDBBS_PROJECT === 'string' && env.CLOUDBBS_PROJECT.trim())
            ? env.CLOUDBBS_PROJECT.trim()
            : DEFAULT_CLOUDBBS_PROJECT,
        token: typeof env.CLOUDBBS_TOKEN === 'string' ? env.CLOUDBBS_TOKEN : ''
    };
}

function announcementPutUrl(settings) {
    return `${settings.url}/api/v1/projects/${encodeURIComponent(settings.project)}/announcement`;
}

function buildReferencePayload({ generatedAt, source, reads }) {
    return {
        schema: REFERENCE_SCHEMA,
        generatedAt,
        source,
        reads: {
            rateDateRanges: reads.rateDateRanges,
            originPorts: reads.originPorts,
            destinationPorts: reads.destinationPorts,
            contractOwners: reads.contractOwners,
            sailingDateRanges: reads.sailingDateRanges,
            predictiveDateRanges: reads.predictiveDateRanges
        }
    };
}

function buildAnnouncementBody({ generatedAt, source, reads }) {
    const payload = buildReferencePayload({ generatedAt, source, reads });
    const json = JSON.stringify(payload);
    return [
        `Generated ${generatedAt} from ${source}.`,
        `Schema ${REFERENCE_SCHEMA}; the JSON block below is the data.`,
        '```json',
        json,
        '```'
    ].join('\n');
}

function buildAnnouncement({ generatedAt, source, reads }) {
    const body = buildAnnouncementBody({ generatedAt, source, reads });
    return {
        title: ANNOUNCEMENT_TITLE,
        body,
        byteLength: Buffer.byteLength(body, 'utf8')
    };
}

function extractJsonBlock(body) {
    const match = /```json\n([\s\S]*?)\n```/.exec(body);
    if (!match) return null;
    return JSON.parse(match[1]);
}

async function fetchAdminJson(url, adminKey, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { 'X-Admin-API-Key': adminKey }
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const err = new Error(`Network failure contacting admin API: ${message}`);
        err.code = 'network_failure';
        throw err;
    }
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = { error: text || 'invalid_response' };
    }
    if (!response.ok) {
        const err = new Error(
            `${response.status} ${body && body.error != null ? body.error : 'request_failed'}`
        );
        err.code = 'admin_read_failed';
        err.status = response.status;
        err.error = body && body.error != null ? body.error : 'request_failed';
        throw err;
    }
    return body;
}

async function fetchAllPages(read, { baseUrl, adminKey, fetchImpl }) {
    const items = [];
    let page = 1;
    while (true) {
        const url = new URL(read.path, `${baseUrl}/`);
        url.searchParams.set('page', String(page));
        url.searchParams.set('pageSize', String(ADMIN_PAGE_SIZE));
        const payload = await fetchAdminJson(url, adminKey, fetchImpl);
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        for (const row of rows) items.push(row);
        const meta = payload?.meta || {};
        const total = Number(meta.total);
        const pageSize = Number(meta.pageSize) || ADMIN_PAGE_SIZE;
        if (!Number.isFinite(total) || page * pageSize >= total || rows.length === 0) {
            break;
        }
        page += 1;
    }
    return items;
}

async function collectReferenceReads({ baseUrl, adminKey, fetchImpl = fetch }) {
    const reads = {};
    for (const read of REFERENCE_READS) {
        reads[read.key] = await fetchAllPages(read, { baseUrl, adminKey, fetchImpl });
    }
    return reads;
}

async function putAnnouncement({ settings, title, body, fetchImpl = fetch }) {
    const url = announcementPutUrl(settings);
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${settings.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, body })
        });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const err = new Error(`Network failure contacting CloudBBS: ${message}`);
        err.code = 'network_failure';
        throw err;
    }
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { error: text && !text.includes('\n') ? text : 'invalid_response' };
    }
    return { status: response.status, ok: response.ok, payload, text };
}

module.exports = {
    BODY_SIZE_CAP,
    ANNOUNCEMENT_TITLE,
    REFERENCE_SCHEMA,
    DEFAULT_CLOUDBBS_URL,
    DEFAULT_CLOUDBBS_PROJECT,
    ADMIN_PAGE_SIZE,
    REFERENCE_READS,
    cloudBbsSettings,
    announcementPutUrl,
    buildReferencePayload,
    buildAnnouncementBody,
    buildAnnouncement,
    extractJsonBlock,
    collectReferenceReads,
    putAnnouncement
};
