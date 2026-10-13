const crypto = require('node:crypto');

const FIXED_MS = Date.parse('2026-10-13T12:00:00.000Z');
const PASSWORD = 'sail-the-ocean';
const REDIRECT_URI = 'http://127.0.0.1:9/callback';

function freezeClock(ms = FIXED_MS) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(ms);
            else super(...args);
        }
        static now() {
            return ms;
        }
    }
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    global.Date = FrozenDate;
    return ms;
}

function cookieHeader(response) {
    return (response.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
}

function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge, state: crypto.randomBytes(12).toString('base64url') };
}

async function authorizeAndToken({ baseUrl, cookie, csrf, clientId, clientSecret, redirectUri = REDIRECT_URI, scope = 'profile:read rates:read sailings:read' }) {
    const proof = pkce();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256'
    });
    const approved = await fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...Object.fromEntries(params), decision: 'approve', csrf_token: csrf }),
        redirect: 'manual'
    });
    if (approved.status !== 302) {
        throw new Error(`Authorize failed (${approved.status}): ${await approved.text()}`);
    }
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
            code_verifier: proof.verifier
        })
    });
    const token = await tokenResponse.json();
    if (tokenResponse.status !== 200) throw new Error(`Token failed: ${JSON.stringify(token)}`);
    return token;
}

async function partnerGet(baseUrl, token, path) {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: response.status, text, body };
}

async function mcpCall(baseUrl, token, method, params, id = 1) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

function insertCompany(db, row) {
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.id, row.name, row.type, row.typeId, row.id, row.admin ? 1 : 0);
}

function insertUser(db, row) {
    db.prepare(`
        INSERT INTO users (
            id, username, display_name, rate_view, company_id, company_reference, admin_screen,
            disabled, session_epoch, company_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(row.id, row.username, row.username, row.companyId, row.companyId, row.companyId, row.admin ? 1 : 0, row.companyId);
}

function insertRate(db, row) {
    db.prepare(`
        INSERT INTO rates (
            id, rate_type, origin_port, destination_port, inland_delivery_location,
            commodity_type, carrier, contract_owner, rate_20d, rate_40d, rate_40hc,
            rate_effective_date, rate_expiration_date, notes_1, owner_company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.id,
        row.rateType || 'FAK',
        row.origin,
        row.destination,
        row.inland || '',
        row.commodity || 'General',
        row.carrier,
        row.contractOwner || 'Owner',
        row.d20,
        row.d40,
        row.d40hc,
        row.effective || '2026-01-01',
        row.expiration || '',
        row.notes || '',
        row.owner
    );
}

function insertSailing(db, row) {
    db.prepare(`
        INSERT INTO sailings (id, departure, arrival, carrier, departure_port, vessel, voyage, owner_company_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.departure, row.arrival || null, row.carrier, row.origin, row.vessel || 'Vessel', row.voyage || '1', row.owner);
}

module.exports = {
    FIXED_MS,
    PASSWORD,
    REDIRECT_URI,
    freezeClock,
    cookieHeader,
    pkce,
    authorizeAndToken,
    partnerGet,
    mcpCall,
    insertCompany,
    insertUser,
    insertRate,
    insertSailing
};
