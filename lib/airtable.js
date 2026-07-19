const { URL } = require('node:url');
const { config } = require('./config');
const { escapeFormulaString, mapSailingRecord } = require('./domain');

const RATE_FIELDS = [
    'Rate Type',
    'Origin Port',
    'Destination Port/Via Port',
    'Inland Delivery Location',
    'CommodityType',
    'Carrier',
    'Contract Owner',
    '20D Rate',
    '40D rate',
    '40HC Rate',
    'Rate Effective Date',
    'Rate Expiration Date',
    'Notes 1',
    'RateView',
    'Arrival'
];

const COMPANY_FIELDS = [
    'CompanyID',
    'CompanyName',
    'CompanyType',
    'RateView',
    'Admin',
    'MarginPercent',
    'MarginNumber'
];

const SAILING_FIELDS = [
    'Departure',
    'Arrival',
    'TransitTime',
    'Vessel',
    'Voyage',
    'Service',
    'Carrier',
    'DeparturePort'
];

const cache = new Map();
const MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function applySearchParams(url, params = {}) {
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        if (key === 'fields' && Array.isArray(value)) {
            for (const field of value) url.searchParams.append('fields[]', field);
            continue;
        }
        url.searchParams.set(key, value);
    }
}

async function airtableRequest(table, options = {}) {
    const safeTablePath = table.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://api.airtable.com/v0/${config.baseId}/${safeTablePath}`);
    applySearchParams(url, options.params);

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            const response = await fetch(url, {
                method: options.method || 'GET',
                headers: {
                    Authorization: `Bearer ${config.apiToken}`,
                    ...(options.body ? { 'Content-Type': 'application/json' } : {})
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal
            });

            if (response.status === 429 && attempt < MAX_RETRIES) {
                const retryAfter = Number(response.headers.get('retry-after'));
                await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (attempt + 1));
                continue;
            }

            if (!response.ok) {
                throw new Error(`Airtable request failed (${response.status}).`);
            }

            return response.json();
        } catch (error) {
            lastError = error;
            const aborted = error?.name === 'AbortError';
            if (aborted || attempt >= MAX_RETRIES) throw aborted ? new Error('Airtable request timed out.') : error;
            await sleep(500 * (attempt + 1));
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError;
}

async function fetchAllRecords(table, params = {}) {
    const records = [];
    let offset;
    do {
        const result = await airtableRequest(table, { params: { ...params, offset } });
        records.push(...result.records);
        offset = result.offset;
    } while (offset);
    return records;
}

function setCached(key, value, ttlMs = config.cacheTtlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function invalidateCache(key) {
    if (key) cache.delete(key);
    else cache.clear();
}

async function cachedLoad(key, loader, ttlMs = config.cacheTtlMs) {
    const entry = cache.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && entry.expiresAt > Date.now() && 'value' in entry) return entry.value;
    if (entry) cache.delete(key);

    const pending = loader()
        .then(value => {
            setCached(key, value, ttlMs);
            return value;
        })
        .catch(error => {
            cache.delete(key);
            throw error;
        });

    cache.set(key, { pending, expiresAt: Date.now() + ttlMs });
    return pending;
}

function getAllRates() {
    return cachedLoad('rates:all', () => fetchAllRecords(config.tables.rates, { fields: RATE_FIELDS }));
}

function getAllCompanies() {
    return cachedLoad('companies:all', () => fetchAllRecords(config.tables.companies, { fields: COMPANY_FIELDS }));
}

function invalidateCompaniesCache() {
    invalidateCache('companies:all');
}

async function fetchSailings({ carrier, originPort, after }) {
    const cacheKey = `sailings:${carrier}\u0000${originPort}\u0000${after}`;
    return cachedLoad(cacheKey, async () => {
        const formula = `AND({Carrier} = "${escapeFormulaString(carrier)}", {DeparturePort} = "${escapeFormulaString(originPort)}", {Departure} > "${escapeFormulaString(after)}")`;
        const records = await fetchAllRecords(config.tables.sailings, {
            filterByFormula: formula,
            fields: SAILING_FIELDS,
            maxRecords: config.sailingsMaxRecords,
            'sort[0][field]': 'Departure',
            'sort[0][direction]': 'asc'
        });
        return records.map(mapSailingRecord);
    }, Math.min(config.cacheTtlMs, 30_000));
}

module.exports = {
    airtableRequest,
    fetchAllRecords,
    getAllRates,
    getAllCompanies,
    invalidateCompaniesCache,
    fetchSailings,
    RATE_FIELDS,
    COMPANY_FIELDS,
    SAILING_FIELDS
};
