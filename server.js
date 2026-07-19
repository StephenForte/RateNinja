const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const {
    PORT,
    ROOT,
    PUBLIC_API_RATE_LIMIT,
    PUBLIC_API_WINDOW_MS,
    config
} = require('./lib/config');
const {
    airtableRequest,
    fetchAllRecords,
    getAllRates,
    getAllCompanies,
    invalidateCompaniesCache,
    fetchCompanyByRecordId,
    fetchSailings
} = require('./lib/airtable');
const {
    normalizeValue,
    sameValue,
    escapeFormulaString,
    mapRateRecord,
    parsePageNumber,
    matchesSearch,
    parseDateOnly,
    fullDaysUntil,
    calculatePredictiveRate,
    latestPredictiveRateRecords,
    companyById,
    rateVisibleToView
} = require('./lib/domain');
const {
    getSession,
    createSession,
    destroySession,
    sessionCookie,
    startSessionSweep
} = require('./lib/session');

let publicApiWindow = { startedAt: Date.now(), requests: 0 };

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

async function handleRates(request, response, session, url) {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const [companies, records] = await Promise.all([
        getAllCompanies(),
        getAllRates({ force: forceRefresh })
    ]);
    const company = companyById(companies, session.user.companyId);
    const rates = records
        .filter(record => rateVisibleToView(record, session.user.rateView))
        .map(record => mapRateRecord(record, company));
    sendJson(response, 200, { rates }, securityHeaders());
}

async function handlePublicRates(request, response, url) {
    if (!requirePublicApiAccess(request, response)) return;
    const carrier = url.searchParams.get('carrier') || '';
    const originPort = url.searchParams.get('originPort') || '';
    const destinationPort = url.searchParams.get('destinationPort') || '';
    const page = parsePageNumber(url.searchParams.get('page'), 1, 10_000);
    const pageSize = parsePageNumber(url.searchParams.get('pageSize'), 50, 100);
    const records = await getAllRates();
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
    const sailings = await fetchSailings({ carrier, originPort, after });
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
    const records = latestPredictiveRateRecords(await getAllRates(), carrier, originPort);
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
    const sailings = await fetchSailings({ carrier, originPort, after });
    sendJson(response, 200, { sailings }, securityHeaders());
}

async function handleAdminCompanies(request, response, session) {
    if (!session.user.isAdmin) {
        sendError(response, 403, 'Administrator access is required.');
        return;
    }
    const records = await getAllCompanies();
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
    const company = await fetchCompanyByRecordId(recordId);
    if (!company || !company.fields.CompanyType || !sameValue(company.fields.RateView, session.user.rateView) || sameValue(company.fields.CompanyID, session.user.companyId)) {
        sendError(response, 404, 'Company was not found in your administration scope.');
        return;
    }
    await airtableRequest(`${config.tables.companies}/${recordId}`, {
        method: 'PATCH',
        body: { fields: { MarginPercent: marginPercent, MarginNumber: marginNumber } }
    });
    invalidateCompaniesCache();
    sendJson(response, 200, { ok: true }, securityHeaders());
}

function hasDotSegment(pathname) {
    return pathname.split('/').some(segment => segment.startsWith('.'));
}

async function serveStatic(request, response, pathname) {
    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    if (hasDotSegment(requestedPath)) {
        sendError(response, 403, 'Forbidden.');
        return;
    }
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
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
            if (session) destroySession(session.token);
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
        if (pathname === '/api/rates' && request.method === 'GET') return handleRates(request, response, session, url);
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

startSessionSweep();
server.listen(PORT, () => {
    console.log(`Rate Ninja is running at http://localhost:${PORT}`);
});
