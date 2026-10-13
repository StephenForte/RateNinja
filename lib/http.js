const { csrfMatches } = require('./csrf');

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

async function readBody(request) {
    if (typeof request._rnRawBody === 'string') return request._rnRawBody;
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_000_000) throw new Error('Request body is too large.');
    }
    return body;
}

async function readJson(request) {
    const body = await readBody(request);
    try {
        return body ? JSON.parse(body) : {};
    } catch {
        throw new Error('Request body must be valid JSON.');
    }
}

function formBody(text) {
    return Object.fromEntries(new URLSearchParams(text));
}

function requireCsrf(request, response, session, body) {
    if (csrfMatches(request, session, body)) return true;
    sendError(response, 403, 'Your session could not be verified. Refresh the page and try again.');
    return false;
}

module.exports = {
    sendJson,
    sendError,
    securityHeaders,
    readBody,
    readJson,
    formBody,
    requireCsrf
};
