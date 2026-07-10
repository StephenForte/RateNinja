const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional; deployment platforms normally provide environment variables.
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PUBLIC_API_RATE_LIMIT = 60;
const PUBLIC_API_WINDOW_MS = 60 * 1000;
const sessions = new Map();
let publicApiWindow = { startedAt: Date.now(), requests: 0 };
const config = {
    apiToken: process.env.AIRTABLE_PAT,
    sessionSecret: process.env.SESSION_SECRET,
    publicApiKey: process.env.RATE_NINJA_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID || 'appBLegnJMAienppq',
    tables: {
        rates: process.env.AIRTABLE_RATE_TABLE_ID || 'tbl5OpIdW2kyRRWLp',
        users: process.env.AIRTABLE_USER_TABLE_ID || 'tblwtjp73CaWe3GKy',
        companies: process.env.AIRTABLE_COMPANY_TABLE_ID || 'CompanyReference',
        sailings: process.env.AIRTABLE_SAILINGS_TABLE_ID || 'Sailings'
    }
};

const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
};

function sendJson(response, status, payload, headers = {}) {
    if (status === 204) {
        response.writeHead(status, headers);
        response.end();
        return;
    }
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    });
    response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
    sendJson(response, status, { error: message });
}

function securityHeaders() {
    return {
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com; script-src 'self' https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff'
    };
}

function getCookies(request) {
    return Object.fromEntries((request.headers.cookie || '').split(';').map(value => {
        const separator = value.indexOf('=');
        return separator === -1 ? [] : [value.slice(0, separator).trim(), decodeURIComponent(value.slice(separator + 1))];
    }).filter(entry => entry.length));
}

function getSession(request) {
    const token = getCookies(request).rate_ninja_session;
    const session = token && sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return null;
    }
    return { token, ...session };
}

function createSession(user) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(nonce).digest('base64url');
    const token = `${nonce}.${signature}`;
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
}

function sessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `rate_ninja_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function readJson(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_000_000) throw new Error('Request body is too large.');
    }
    try {
        return body ? JSON.parse(body) : {};
    } catch {
        throw new Error('Request body must be valid JSON.');
    }
}

function requireConfiguration(response) {
    if (config.apiToken && config.sessionSecret) return true;
    sendError(response, 500, 'Server configuration is incomplete. Set AIRTABLE_PAT and SESSION_SECRET.');
    return false;
}

function normalizeValue(value, fallback = 'N/A') {
    if (Array.isArray(value)) return value.join(', ') || fallback;
    return value ?? fallback;
}

function sameValue(left, right) {
    return String(left ?? '') === String(right ?? '');
}

function asArray(value) {
    return Array.isArray(value) ? value : [value];
}

function calculateRate(value, company) {
    const baseRate = Number(value) || 0;
    if (!company || company.fields.Admin) return Math.round(baseRate);
    const rawPercent = Number(company.fields.MarginPercent) || 0;
    const marginPercent = rawPercent > 1 ? rawPercent / 100 : rawPercent;
    const marginNumber = Number(company.fields.MarginNumber) || 0;
    return Math.round(baseRate * (1 + marginPercent) + marginNumber);
}

function mapRateRecord(record, company) {
    const fields = record.fields;
    return {
        id: record.id,
        rateType: normalizeValue(fields['Rate Type']),
        originPort: normalizeValue(fields['Origin Port']),
        destinationPort: normalizeValue(fields['Destination Port/Via Port']),
        inlandDeliveryLocation: normalizeValue(fields['Inland Delivery Location']),
        commodityType: normalizeValue(fields.CommodityType),
        carrier: normalizeValue(fields.Carrier),
        contractOwner: normalizeValue(fields['Contract Owner']),
        rate20D: calculateRate(fields['20D Rate'], company),
        rate40D: calculateRate(fields['40D rate'], company),
        rate40HC: calculateRate(fields['40HC Rate'], company),
        rateEffectiveDate: normalizeValue(fields['Rate Effective Date']),
        rateExpirationDate: normalizeValue(fields['Rate Expiration Date']),
        notes1: normalizeValue(fields['Notes 1'], '')
    };
}

function escapeFormulaString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function airtableRequest(table, options = {}) {
    const safeTablePath = table.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`https://api.airtable.com/v0/${config.baseId}/${safeTablePath}`);
    for (const [key, value] of Object.entries(options.params || {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
            Authorization: `Bearer ${config.apiToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
        throw new Error(`Airtable request failed (${response.status}).`);
    }
    return response.json();
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

async function requireSession(request, response) {
    const session = getSession(request);
    if (!session) {
        sendError(response, 401, 'Please sign in to continue.');
        return null;
    }
    return session;
}

function publicApiKeyIsValid(request) {
    const suppliedKey = request.headers['x-api-key'];
    if (typeof suppliedKey !== 'string' || !config.publicApiKey) return false;
    const supplied = Buffer.from(suppliedKey);
    const expected = Buffer.from(config.publicApiKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function consumePublicApiRequest(response) {
    const now = Date.now();
    if (now - publicApiWindow.startedAt >= PUBLIC_API_WINDOW_MS) {
        publicApiWindow = { startedAt: now, requests: 0 };
    }
    if (publicApiWindow.requests >= PUBLIC_API_RATE_LIMIT) {
        sendError(response, 429, 'Demo API rate limit exceeded. Try again in a minute.');
        return false;
    }
    publicApiWindow.requests += 1;
    return true;
}

function requirePublicApiAccess(request, response) {
    if (!config.apiToken || !config.publicApiKey) {
        sendError(response, 500, 'Public API configuration is incomplete. Set AIRTABLE_PAT and RATE_NINJA_API_KEY.');
        return false;
    }
    if (!publicApiKeyIsValid(request)) {
        sendError(response, 401, 'A valid X-API-Key header is required.');
        return false;
    }
    return consumePublicApiRequest(response);
}

async function handleLogin(request, response) {
    if (!requireConfiguration(response)) return;
    const { username, password } = await readJson(request);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
        sendError(response, 400, 'Username and password are required.');
        return;
    }

    const users = await fetchAllRecords(config.tables.users, {
        filterByFormula: `{UserName} = "${escapeFormulaString(username.trim())}"`
    });
    const record = users.find(user => user.fields.Pwd === password);
    if (!record) {
        sendError(response, 401, 'Invalid username or password.');
        return;
    }

    const fields = record.fields;
    const user = {
        username: fields.DisplayName || fields.UserName || username.trim(),
        rateView: fields.RateView,
        companyId: normalizeValue(fields['CompanyID (from CompanyReference)'], ''),
        companyReference: normalizeValue(fields.CompanyReference, ''),
        isAdmin: fields.AdminScreen === true
    };
    const token = createSession(user);
    sendJson(response, 200, { user: { username: user.username, isAdmin: user.isAdmin } }, {
        'Set-Cookie': sessionCookie(token),
        ...securityHeaders()
    });
}

async function handleRates(request, response, session) {
    const [companies, records] = await Promise.all([
        fetchAllRecords(config.tables.companies),
        fetchAllRecords(config.tables.rates)
    ]);
    const company = companies.find(record => sameValue(record.fields.CompanyID, session.user.companyId));
    const rates = records
        .filter(record => asArray(record.fields.RateView).some(value => sameValue(value, session.user.rateView)))
        .map(record => mapRateRecord(record, company));
    sendJson(response, 200, { rates }, securityHeaders());
}

function parsePageNumber(value, fallback, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function matchesSearch(value, query) {
    return !query || String(value).toLowerCase().includes(query.toLowerCase());
}

function parseDateOnly(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
        ? date
        : null;
}

function fullDaysUntil(date) {
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.floor((date.getTime() - todayUtc) / (24 * 60 * 60 * 1000));
}

function expirationTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function calculatePredictiveRate(value, fullThirtyDayPeriods) {
    const baseRate = Number(value) || 0;
    return Math.round(baseRate * (1 + (fullThirtyDayPeriods * 0.05)));
}

function latestPredictiveRateRecords(records, carrier, originPort) {
    const latestByRoute = new Map();
    for (const record of records) {
        const fields = record.fields;
        if (!sameValue(fields.Carrier, carrier) || !sameValue(fields['Origin Port'], originPort)) continue;
        const destinationPort = normalizeValue(fields['Destination Port/Via Port']);
        const arrival = normalizeValue(fields.Arrival, '');
        const routeKey = [fields.Carrier, fields['Origin Port'], destinationPort, arrival].join('\u0000');
        const latest = latestByRoute.get(routeKey);
        if (!latest || expirationTimestamp(fields['Rate Expiration Date']) > expirationTimestamp(latest.fields['Rate Expiration Date'])) {
            latestByRoute.set(routeKey, record);
        }
    }
    return [...latestByRoute.values()];
}

async function handlePublicRates(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const destinationPort = url.searchParams.get('destinationPort') || '';
    const page = parsePageNumber(url.searchParams.get('page'), 1, 10_000);
    const pageSize = parsePageNumber(url.searchParams.get('pageSize'), 50, 100);
    const records = await fetchAllRecords(config.tables.rates);
    const rates = records
        .map(record => mapRateRecord(record, null))
        .filter(rate => matchesSearch(rate.carrier, carrier) && matchesSearch(rate.originPort, originPort) && matchesSearch(rate.destinationPort, destinationPort));
    const start = (page - 1) * pageSize;
    sendJson(response, 200, {
        data: rates.slice(start, start + pageSize),
        meta: {
            total: rates.length,
            page,
            pageSize,
            returned: Math.min(pageSize, Math.max(rates.length - start, 0))
        }
    }, securityHeaders());
}

async function handlePublicSailings(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, originPort, and after query parameters are required.');
        return;
    }
    const formula = `AND({Carrier} = "${escapeFormulaString(carrier)}", {DeparturePort} = "${escapeFormulaString(originPort)}", {Departure} > "${escapeFormulaString(after)}")`;
    const records = await fetchAllRecords(config.tables.sailings, {
        filterByFormula: formula,
        'sort[0][field]': 'Departure',
        'sort[0][direction]': 'asc'
    });
    const sailings = records.map(record => ({
        departure: normalizeValue(record.fields.Departure),
        arrival: normalizeValue(record.fields.Arrival),
        transitTime: normalizeValue(record.fields.TransitTime),
        vessel: normalizeValue(record.fields.Vessel),
        voyage: normalizeValue(record.fields.Voyage),
        service: normalizeValue(record.fields.Service)
    }));
    sendJson(response, 200, { data: sailings, meta: { total: sailings.length } }, securityHeaders());
}

async function handlePredictivePricing(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, originPort, and after query parameters are required.');
        return;
    }

    const departureDate = parseDateOnly(after);
    const daysUntilDeparture = departureDate && fullDaysUntil(departureDate);
    if (!departureDate || daysUntilDeparture <= 90) {
        sendError(response, 400, 'Departing after must be more than 90 days in the future.');
        return;
    }

    const fullThirtyDayPeriods = Math.floor(daysUntilDeparture / 30);
    const records = latestPredictiveRateRecords(await fetchAllRecords(config.tables.rates), carrier, originPort);
    const predictions = records.map(record => {
        const fields = record.fields;
        return {
            carrier: normalizeValue(fields.Carrier),
            originPort: normalizeValue(fields['Origin Port']),
            destinationPort: normalizeValue(fields['Destination Port/Via Port']),
            arrival: normalizeValue(fields.Arrival, ''),
            departingAfter: after,
            rate20D: calculatePredictiveRate(fields['20D Rate'], fullThirtyDayPeriods),
            rate40D: calculatePredictiveRate(fields['40D rate'], fullThirtyDayPeriods),
            rate40HC: calculatePredictiveRate(fields['40HC Rate'], fullThirtyDayPeriods)
        };
    });
    sendJson(response, 200, { data: predictions, meta: { total: predictions.length } }, securityHeaders());
}

async function handleSailings(request, response, session, url) {
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const after = url.searchParams.get('after') || '';
    if (!carrier || !originPort || !after) {
        sendError(response, 400, 'Carrier, origin port, and effective date are required.');
        return;
    }
    const formula = `AND({Carrier} = "${escapeFormulaString(carrier)}", {DeparturePort} = "${escapeFormulaString(originPort)}", {Departure} > "${escapeFormulaString(after)}")`;
    const records = await fetchAllRecords(config.tables.sailings, {
        filterByFormula: formula,
        'sort[0][field]': 'Departure',
        'sort[0][direction]': 'asc'
    });
    const sailings = records.map(record => ({
        departure: normalizeValue(record.fields.Departure),
        arrival: normalizeValue(record.fields.Arrival),
        transitTime: normalizeValue(record.fields.TransitTime),
        vessel: normalizeValue(record.fields.Vessel),
        voyage: normalizeValue(record.fields.Voyage),
        service: normalizeValue(record.fields.Service)
    }));
    sendJson(response, 200, { sailings }, securityHeaders());
}

async function handleAdminCompanies(request, response, session) {
    if (!session.user.isAdmin) {
        sendError(response, 403, 'Administrator access is required.');
        return;
    }
    const records = await fetchAllRecords(config.tables.companies);
    const companies = records
        .filter(record => record.fields.CompanyType && sameValue(record.fields.RateView, session.user.rateView) && !sameValue(record.fields.CompanyID, session.user.companyId))
        .map(record => ({
            id: record.id,
            name: normalizeValue(record.fields.CompanyName),
            marginPercent: Number(record.fields.MarginPercent) || 0,
            marginNumber: Number(record.fields.MarginNumber) || 0
        }));
    sendJson(response, 200, { companies }, securityHeaders());
}

async function handleAdminCompanyUpdate(request, response, session, recordId) {
    if (!session.user.isAdmin) {
        sendError(response, 403, 'Administrator access is required.');
        return;
    }
    const { marginPercent, marginNumber } = await readJson(request);
    if (![marginPercent, marginNumber].every(value => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
        sendError(response, 400, 'Margins must be non-negative numbers no greater than 1,000,000.');
        return;
    }
    const records = await fetchAllRecords(config.tables.companies, { filterByFormula: `RECORD_ID() = "${escapeFormulaString(recordId)}"` });
    const company = records[0];
    if (!company || !company.fields.CompanyType || !sameValue(company.fields.RateView, session.user.rateView) || sameValue(company.fields.CompanyID, session.user.companyId)) {
        sendError(response, 404, 'Company was not found in your administration scope.');
        return;
    }
    await airtableRequest(`${config.tables.companies}/${recordId}`, {
        method: 'PATCH',
        body: { fields: { MarginPercent: marginPercent, MarginNumber: marginNumber } }
    });
    sendJson(response, 200, { ok: true }, securityHeaders());
}

async function serveStatic(request, response, pathname) {
    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) || path.basename(filePath).startsWith('.')) {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    try {
        const content = await fs.readFile(filePath);
        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
            ...securityHeaders()
        });
        response.end(content);
    } catch {
        sendError(response, 404, 'Not found.');
    }
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        const { pathname } = url;
        if (pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, response);
        if (pathname === '/api/auth/logout' && request.method === 'POST') {
            const session = getSession(request);
            if (session) sessions.delete(session.token);
            sendJson(response, 204, null, { 'Set-Cookie': sessionCookie('', 0), ...securityHeaders() });
            return;
        }
        if (pathname === '/api/session' && request.method === 'GET') {
            const session = await requireSession(request, response);
            if (!session) return;
            sendJson(response, 200, { user: { username: session.user.username, isAdmin: session.user.isAdmin } }, securityHeaders());
            return;
        }
        if (pathname === '/api/v1' && request.method === 'GET') {
            sendJson(response, 200, {
                name: 'Rate Ninja Demo API',
                version: 'v1',
                authentication: 'Send your demo key in the X-API-Key header.',
                endpoints: ['/api/v1/rates', '/api/v1/sailings', '/api/v1/predictive-pricing']
            }, securityHeaders());
            return;
        }
        if (pathname === '/api/v1/rates' && request.method === 'GET') return handlePublicRates(request, response, url);
        if (pathname === '/api/v1/sailings' && request.method === 'GET') return handlePublicSailings(request, response, url);
        if (pathname === '/api/v1/predictive-pricing' && request.method === 'GET') return handlePredictivePricing(request, response, url);

        const session = pathname.startsWith('/api/') ? await requireSession(request, response) : null;
        if (pathname.startsWith('/api/') && !session) return;
        if (pathname === '/api/rates' && request.method === 'GET') return handleRates(request, response, session);
        if (pathname === '/api/sailings' && request.method === 'GET') return handleSailings(request, response, session, url);
        if (pathname === '/api/admin/companies' && request.method === 'GET') return handleAdminCompanies(request, response, session);
        const companyMatch = pathname.match(/^\/api\/admin\/companies\/([\w-]+)$/);
        if (companyMatch && request.method === 'PATCH') return handleAdminCompanyUpdate(request, response, session, companyMatch[1]);
        if (pathname.startsWith('/api/')) return sendError(response, 404, 'API route not found.');
        return serveStatic(request, response, pathname);
    } catch (error) {
        console.error(error);
        sendError(response, 500, 'Something went wrong. Please try again.');
    }
});

server.listen(PORT, () => {
    console.log(`Rate Ninja is running at http://localhost:${PORT}`);
});
