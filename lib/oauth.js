const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const {
    SCOPES,
    PARTNER_AUDIENCE,
    CONSENT_VERSION,
    COMPANY_TYPE_CONTRACT_OWNER,
    CAPACITY_EXCHANGE_CLIENT_ID,
    CAPACITY_EXCHANGE_DISPLAY_NAME
} = require('./constants');
const {
    ACCESS_TOKEN_TTL_MS,
    AUTH_CODE_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    oauthSigningKey,
    partnerOauthEnabled
} = require('./config');
const { getUserById, getCompanyByRecordId } = require('./store');
const { recordAudit } = require('./audit');

function nowIso() {
    return new Date().toISOString();
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue));
    const right = Buffer.from(String(rightValue));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function randomToken(prefix) {
    return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function clientFromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        displayName: row.display_name,
        secretHash: row.secret_hash,
        clientType: row.client_type,
        redirectUris: parseJsonArray(row.redirect_uris),
        allowedScopes: parseJsonArray(row.allowed_scopes),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function getClient(id) {
    return clientFromRow(db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id));
}

function validRedirectUri(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.hash) return false;
        if (url.protocol === 'https:') return true;
        return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    } catch {
        return false;
    }
}

function parseScopes(value, allowed) {
    if (typeof value !== 'string' || !value.trim()) return { error: 'invalid_scope' };
    const scopes = [...new Set(value.trim().split(/\s+/))];
    if (!scopes.length || scopes.some(scope => !SCOPES.includes(scope) || !allowed.includes(scope))) {
        return { error: 'invalid_scope' };
    }
    return { scopes };
}

function pkceS256(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function validVerifier(verifier) {
    return typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

function secretMatches(storedHash, supplied) {
    if (!storedHash || typeof supplied !== 'string' || !supplied) return false;
    return safeEqual(sha256(supplied), storedHash);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Inter, Segoe UI, sans-serif; background: #102a43; color: #102a43; margin: 0; }
    main { max-width: 32rem; margin: 8vh auto; background: #fff; border-radius: 16px; padding: 2rem; }
    h1 { font-size: 1.4rem; margin-top: 0; }
    ul { padding-left: 1.2rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button { font: inherit; border: 0; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; }
    .approve { background: #0b6e4f; color: white; }
    .deny { background: #e7eef5; }
    p.note { color: #486581; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function errorPage(message) {
    return {
        type: 'html',
        status: 400,
        html: page('Rate Ninja', `<h1>Rate Ninja</h1><p>${escapeHtml(message)}</p>`)
    };
}

function redirectWithError(redirectUri, error, description, state) {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (description) url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    return { type: 'redirect', location: url.toString() };
}

function disabledPartnerPage() {
    return {
        type: 'html',
        status: 403,
        html: page('Rate Ninja', '<h1>Rate Ninja</h1><p>Partner sign-in is turned off until the production security gates are opened.</p>')
    };
}

function validateAuthorizeRequest(query) {
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    const redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : '';
    const client = getClient(clientId);
    if (!client || client.status !== 'active' || !client.redirectUris.includes(redirectUri)) {
        return { clientError: errorPage('This application is not registered for that callback.') };
    }
    const state = typeof query.state === 'string' ? query.state : '';
    if (!state || state.length > 512) {
        return { client, redirectError: redirectWithError(redirectUri, 'invalid_request', 'state is required', state) };
    }
    if (query.response_type !== 'code') {
        return { client, redirectError: redirectWithError(redirectUri, 'unsupported_response_type', 'Only code is supported', state) };
    }
    if (query.code_challenge_method !== 'S256' || typeof query.code_challenge !== 'string' || !query.code_challenge) {
        return { client, redirectError: redirectWithError(redirectUri, 'invalid_request', 'PKCE S256 is required', state) };
    }
    const parsed = parseScopes(query.scope, client.allowedScopes);
    if (parsed.error) {
        return { client, redirectError: redirectWithError(redirectUri, 'invalid_scope', 'Requested scope is not allowed', state) };
    }
    return {
        client,
        redirectUri,
        state,
        scopes: parsed.scopes,
        codeChallenge: query.code_challenge
    };
}

function renderConsent({ client, query, csrfToken }) {
    const fields = [
        ['client_id', query.client_id],
        ['redirect_uri', query.redirect_uri],
        ['response_type', 'code'],
        ['scope', query.scope],
        ['state', query.state],
        ['code_challenge', query.code_challenge],
        ['code_challenge_method', 'S256'],
        ['csrf_token', csrfToken]
    ].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
    const scopes = String(query.scope || '').split(/\s+/).filter(Boolean)
        .map(scope => `<li>${escapeHtml(scope)}</li>`).join('');
    return page('Authorize application', `
      <h1>Rate Ninja</h1>
      <p><strong>${escapeHtml(client.displayName)}</strong> wants to read data from your Rate Ninja account.</p>
      <ul>${scopes}</ul>
      <p class="note">Rates and sailings are contract records. They are not proof of capacity you can transfer or book.</p>
      <form method="post" action="/oauth/authorize">
        ${fields}
        <div class="actions">
          <button class="approve" type="submit" name="decision" value="approve">Approve</button>
          <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>`);
}

function beginAuthorization({ query, sessionUser }) {
    if (!partnerOauthEnabled()) return disabledPartnerPage();
    const validated = validateAuthorizeRequest(query);
    if (validated.clientError) return validated.clientError;
    if (validated.redirectError) return validated.redirectError;
    if (!sessionUser) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'string') params.set(key, value);
        }
        return { type: 'login', next: `/oauth/authorize?${params.toString()}` };
    }
    if (sessionUser.companyType !== COMPANY_TYPE_CONTRACT_OWNER) {
        recordAudit('oauth_consent_denied', {
            actorUserId: sessionUser.id,
            clientId: validated.client.id,
            detail: { reason: 'only_contract_owner' }
        });
        return redirectWithError(validated.redirectUri, 'access_denied', 'only_contract_owner', validated.state);
    }
    return {
        type: 'html',
        status: 200,
        html: renderConsent({ client: validated.client, query, csrfToken: sessionUser.csrfToken })
    };
}

function revokeActiveGrants(userId, clientId, revokedAt) {
    const grants = db.prepare(`
        SELECT id FROM oauth_grants
        WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL
    `).all(userId, clientId);
    for (const grant of grants) {
        db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').run(revokedAt, grant.id);
        db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(revokedAt, grant.id);
    }
}

function completeAuthorization({ form, sessionUser }) {
    if (!partnerOauthEnabled()) return disabledPartnerPage();
    const validated = validateAuthorizeRequest(form);
    if (validated.clientError) return validated.clientError;
    if (validated.redirectError) return validated.redirectError;
    if (!sessionUser) return { type: 'login', next: '/oauth/authorize' };
    if (form.decision === 'deny') {
        recordAudit('oauth_consent_denied', {
            actorUserId: sessionUser.id,
            clientId: validated.client.id,
            detail: { reason: 'user_denied' }
        });
        return redirectWithError(validated.redirectUri, 'access_denied', 'The request was denied', validated.state);
    }
    if (form.decision !== 'approve') {
        return redirectWithError(validated.redirectUri, 'invalid_request', 'decision is required', validated.state);
    }
    if (sessionUser.companyType !== COMPANY_TYPE_CONTRACT_OWNER) {
        recordAudit('oauth_consent_denied', {
            actorUserId: sessionUser.id,
            clientId: validated.client.id,
            detail: { reason: 'only_contract_owner' }
        });
        return redirectWithError(validated.redirectUri, 'access_denied', 'only_contract_owner', validated.state);
    }
    const code = randomToken('rnc');
    const createdAt = Date.now();
    transaction(() => {
        revokeActiveGrants(sessionUser.id, validated.client.id, createdAt);
        const grantId = crypto.randomUUID();
        db.prepare(`
            INSERT INTO oauth_grants (id, client_id, user_id, scopes, consent_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(grantId, validated.client.id, sessionUser.id, validated.scopes.join(' '), CONSENT_VERSION, createdAt);
        db.prepare(`
            INSERT INTO oauth_authorization_codes (
                id, code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method,
                scopes, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?)
        `).run(
            crypto.randomUUID(),
            sha256(code),
            validated.client.id,
            sessionUser.id,
            validated.redirectUri,
            form.code_challenge,
            validated.scopes.join(' '),
            createdAt + AUTH_CODE_TTL_MS,
            createdAt
        );
        recordAudit('oauth_consent_approved', {
            actorUserId: sessionUser.id,
            clientId: validated.client.id,
            detail: { scopeCount: validated.scopes.length }
        });
    });
    const url = new URL(validated.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', validated.state);
    return { type: 'redirect', location: url.toString() };
}

function signAccessToken(payload) {
    const key = oauthSigningKey();
    if (!key) throw new Error('OAuth signing key is not configured.');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `rn1.${body}.${signature}`;
}

function readAccessToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'rn1') return null;
    const key = oauthSigningKey();
    if (!key) return null;
    const signature = crypto.createHmac('sha256', key).update(parts[1]).digest('base64url');
    if (!safeEqual(signature, parts[2])) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function issueAccessToken({ user, clientId, scopes, grantId }) {
    const issuedAt = Date.now();
    return signAccessToken({
        sub: user.id,
        client_id: clientId,
        scope: scopes.join(' '),
        aud: PARTNER_AUDIENCE,
        exp: issuedAt + ACCESS_TOKEN_TTL_MS,
        iat: issuedAt,
        grant_id: grantId,
        company_record_id: user.companyRecordId,
        session_epoch: user.sessionEpoch
    });
}

function tokenResponse({ accessToken, refreshToken, scopes }) {
    return {
        status: 200,
        body: {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            refresh_token: refreshToken,
            scope: scopes.join(' ')
        }
    };
}

function oauthError(status, error, description) {
    return { status, body: { error, error_description: description } };
}

function authenticateClient(client, secret) {
    if (!client || client.status !== 'active') return oauthError(401, 'invalid_client', 'Client authentication failed.');
    if (client.clientType === 'confidential') {
        if (!secretMatches(client.secretHash, secret)) return oauthError(401, 'invalid_client', 'Client authentication failed.');
        return null;
    }
    if (secret) return oauthError(401, 'invalid_client', 'Public clients must not send a client secret.');
    return null;
}

function loadLiveUser(userId) {
    const user = getUserById(userId);
    if (!user || user.disabled) return null;
    const company = user.companyRecordId ? getCompanyByRecordId(user.companyRecordId) : null;
    return {
        ...user,
        companyType: company?.fields?.CompanyType || '',
        companyName: company?.fields?.CompanyName || '',
        companyBusinessId: company?.fields?.CompanyID || user.companyId || ''
    };
}

function exchangeAuthorizationCode(body) {
    if (!partnerOauthEnabled()) return oauthError(403, 'partner_oauth_disabled', 'Partner OAuth is turned off.');
    const client = getClient(body.client_id);
    const authError = authenticateClient(client, body.client_secret);
    if (authError) return authError;
    if (body.grant_type !== 'authorization_code') return oauthError(400, 'unsupported_grant_type', 'Unsupported grant type.');
    if (!validVerifier(body.code_verifier) || typeof body.code !== 'string' || typeof body.redirect_uri !== 'string') {
        return oauthError(400, 'invalid_request', 'Code, verifier, and redirect URI are required.');
    }
    const codeHash = sha256(body.code);
    try {
        return transaction(() => {
            const row = db.prepare('SELECT * FROM oauth_authorization_codes WHERE code_hash = ?').get(codeHash);
            const now = Date.now();
            if (!row || row.client_id !== client.id || row.redirect_uri !== body.redirect_uri || row.used_at || row.expires_at <= now) {
                return oauthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
            }
            if (!safeEqual(pkceS256(body.code_verifier), row.code_challenge)) {
                return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
            }
            const consumed = db.prepare('UPDATE oauth_authorization_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id);
            if (Number(consumed.changes) !== 1) return oauthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
            const user = loadLiveUser(row.user_id);
            const grant = db.prepare(`
                SELECT * FROM oauth_grants
                WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL
                ORDER BY created_at DESC LIMIT 1
            `).get(row.user_id, client.id);
            if (!user || user.companyType !== COMPANY_TYPE_CONTRACT_OWNER || !grant) {
                return oauthError(400, 'invalid_grant', 'Authorization code is invalid or expired.');
            }
            const scopes = row.scopes.split(' ').filter(Boolean);
            const refreshToken = randomToken('rfr');
            const familyId = crypto.randomUUID();
            db.prepare(`
                INSERT INTO oauth_refresh_tokens (
                    id, token_hash, family_id, grant_id, client_id, user_id, scopes, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                crypto.randomUUID(),
                sha256(refreshToken),
                familyId,
                grant.id,
                client.id,
                user.id,
                scopes.join(' '),
                now + REFRESH_TOKEN_TTL_MS,
                now
            );
            recordAudit('oauth_token_issued', { actorUserId: user.id, clientId: client.id, detail: { grant: 'authorization_code' } });
            return tokenResponse({
                accessToken: issueAccessToken({ user, clientId: client.id, scopes, grantId: grant.id }),
                refreshToken,
                scopes
            });
        });
    } catch (error) {
        if (error.status && error.body) return error;
        throw error;
    }
}

function revokeRefreshFamily(familyId, revokedAt) {
    db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(revokedAt, familyId);
}

function refreshAccessToken(body) {
    if (!partnerOauthEnabled()) return oauthError(403, 'partner_oauth_disabled', 'Partner OAuth is turned off.');
    const client = getClient(body.client_id);
    const authError = authenticateClient(client, body.client_secret);
    if (authError) return authError;
    if (body.grant_type !== 'refresh_token') return oauthError(400, 'unsupported_grant_type', 'Unsupported grant type.');
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) return oauthError(400, 'invalid_request', 'refresh_token is required.');
    return transaction(() => {
        const now = Date.now();
        const row = db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').get(sha256(body.refresh_token));
        if (!row || row.client_id !== client.id) return oauthError(400, 'invalid_grant', 'Refresh token is invalid.');
        if (row.revoked_at || row.rotated_at) {
            revokeRefreshFamily(row.family_id, now);
            db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, row.grant_id);
            recordAudit('oauth_refresh_reuse', { actorUserId: row.user_id, clientId: client.id, detail: { familyRevoked: true } });
            return oauthError(400, 'invalid_grant', 'Refresh token reuse revoked the token family.');
        }
        if (row.expires_at <= now) return oauthError(400, 'invalid_grant', 'Refresh token is invalid.');
        const grant = db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(row.grant_id);
        const user = loadLiveUser(row.user_id);
        if (!grant || grant.revoked_at || !user || user.companyType !== COMPANY_TYPE_CONTRACT_OWNER) {
            return oauthError(400, 'invalid_grant', 'Refresh token is invalid.');
        }
        const rotated = db.prepare('UPDATE oauth_refresh_tokens SET rotated_at = ?, revoked_at = ? WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL')
            .run(now, now, row.id);
        if (Number(rotated.changes) !== 1) return oauthError(400, 'invalid_grant', 'Refresh token is invalid.');
        const scopes = row.scopes.split(' ').filter(Boolean);
        const refreshToken = randomToken('rfr');
        db.prepare(`
            INSERT INTO oauth_refresh_tokens (
                id, token_hash, family_id, grant_id, client_id, user_id, scopes, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), sha256(refreshToken), row.family_id, row.grant_id, client.id, user.id, scopes.join(' '), now + REFRESH_TOKEN_TTL_MS, now);
        recordAudit('oauth_refresh_rotated', { actorUserId: user.id, clientId: client.id, detail: { rotated: true } });
        return tokenResponse({
            accessToken: issueAccessToken({ user, clientId: client.id, scopes, grantId: row.grant_id }),
            refreshToken,
            scopes
        });
    });
}

function grantToken(body) {
    if (body.grant_type === 'authorization_code') return exchangeAuthorizationCode(body);
    if (body.grant_type === 'refresh_token') return refreshAccessToken(body);
    if (!partnerOauthEnabled()) return oauthError(403, 'partner_oauth_disabled', 'Partner OAuth is turned off.');
    return oauthError(400, 'unsupported_grant_type', 'Unsupported grant type.');
}

function revokePresentedToken(body) {
    const client = getClient(body.client_id);
    const authError = authenticateClient(client, body.client_secret);
    if (authError) return authError;
    if (typeof body.token !== 'string' || !body.token) return { status: 200, body: {} };
    const now = Date.now();
    transaction(() => {
        const refresh = db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').get(sha256(body.token));
        if (refresh && refresh.client_id === client.id) {
            db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, refresh.grant_id);
            revokeRefreshFamily(refresh.family_id, now);
            recordAudit('oauth_revoked', { actorUserId: refresh.user_id, clientId: client.id, detail: { via: 'token_endpoint' } });
            return;
        }
        const access = readAccessToken(body.token);
        if (access && access.client_id === client.id && access.grant_id) {
            db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, access.grant_id);
            db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, access.grant_id);
            recordAudit('oauth_revoked', { actorUserId: access.sub, clientId: client.id, detail: { via: 'access_token' } });
        }
    });
    return { status: 200, body: {} };
}

function verifyAccessToken(token, requiredScope) {
    if (!partnerOauthEnabled()) {
        return { ok: false, status: 403, error: 'partner_oauth_disabled', description: 'Partner OAuth is turned off.' };
    }
    const payload = readAccessToken(token);
    if (!payload || payload.aud !== PARTNER_AUDIENCE || !payload.exp || payload.exp <= Date.now()) {
        return { ok: false, status: 401, error: 'invalid_token', description: 'Access token is missing or invalid.' };
    }
    const scopes = String(payload.scope || '').split(' ').filter(Boolean);
    if (requiredScope && !scopes.includes(requiredScope)) {
        return { ok: false, status: 403, error: 'insufficient_scope', description: 'Token does not include the required scope.' };
    }
    const client = getClient(payload.client_id);
    const user = loadLiveUser(payload.sub);
    const grant = payload.grant_id ? db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(payload.grant_id) : null;
    if (!client || client.status !== 'active' || !user || !grant || grant.revoked_at || grant.client_id !== client.id) {
        return { ok: false, status: 401, error: 'invalid_token', description: 'Access token is missing or invalid.' };
    }
    if (user.companyType !== COMPANY_TYPE_CONTRACT_OWNER || user.companyRecordId !== payload.company_record_id || user.sessionEpoch !== payload.session_epoch) {
        return { ok: false, status: 401, error: 'invalid_token', description: 'Access token is missing or invalid.' };
    }
    return {
        ok: true,
        access: {
            sub: user.id,
            username: user.displayName || user.username,
            loginName: user.username,
            clientId: client.id,
            scopes,
            grantId: grant.id,
            companyRecordId: user.companyRecordId,
            companyId: user.companyBusinessId,
            companyName: user.companyName,
            companyType: user.companyType,
            active: !user.disabled
        }
    };
}

function userInfo(token) {
    const verified = verifyAccessToken(token, 'profile:read');
    if (!verified.ok) return { status: verified.status, body: { error: verified.error, error_description: verified.description } };
    const access = verified.access;
    return {
        status: 200,
        body: {
            sub: access.sub,
            name: access.username,
            companyId: access.companyRecordId,
            companyName: access.companyName,
            companyType: access.companyType,
            active: access.active
        }
    };
}

function listUserGrants(userId) {
    return db.prepare(`
        SELECT g.id, g.client_id, g.scopes, g.created_at, c.display_name
        FROM oauth_grants g
        JOIN oauth_clients c ON c.id = g.client_id
        WHERE g.user_id = ? AND g.revoked_at IS NULL
        ORDER BY g.created_at DESC
    `).all(userId).map(row => ({
        clientId: row.client_id,
        displayName: row.display_name,
        scopes: row.scopes.split(' ').filter(Boolean),
        createdAt: new Date(row.created_at).toISOString()
    }));
}

function revokeUserClientGrant(userId, clientId) {
    const now = Date.now();
    transaction(() => {
        const grants = db.prepare('SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL').all(userId, clientId);
        for (const grant of grants) {
            db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').run(now, grant.id);
            db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, grant.id);
        }
        if (grants.length) recordAudit('oauth_revoked', { actorUserId: userId, clientId, detail: { via: 'user' } });
    });
}

function publicClient(client, extra = {}) {
    return {
        id: client.id,
        displayName: client.displayName,
        clientType: client.clientType,
        redirectUris: client.redirectUris,
        allowedScopes: client.allowedScopes,
        status: client.status,
        hasSecret: Boolean(client.secretHash),
        ...extra
    };
}

function listClientsAdmin() {
    return db.prepare('SELECT * FROM oauth_clients ORDER BY display_name').all().map(row => publicClient(clientFromRow(row)));
}

function normalizeClientInput(input, { requireSecret }) {
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName || displayName.length > 80) return { error: 'Display name is required (80 characters max).' };
    if (!['confidential', 'public'].includes(input.clientType)) return { error: 'Client type must be confidential or public.' };
    const redirectUris = Array.isArray(input.redirectUris) ? input.redirectUris.map(value => String(value).trim()).filter(Boolean) : [];
    if (redirectUris.some(uri => !validRedirectUri(uri))) {
        return { error: 'Redirect URIs must be https, or http on localhost, with no fragment.' };
    }
    if (new Set(redirectUris).size !== redirectUris.length) return { error: 'Redirect URIs must be unique.' };
    const parsed = parseScopes(Array.isArray(input.allowedScopes) ? input.allowedScopes.join(' ') : '', SCOPES);
    if (parsed.error) return { error: 'Choose at least one allowed scope.' };
    const status = input.status || 'active';
    if (!['active', 'disabled'].includes(status)) return { error: 'Status must be active or disabled.' };
    let secret = null;
    let secretHash = null;
    if (input.clientType === 'confidential' && requireSecret) {
        secret = randomToken('rnsec');
        secretHash = sha256(secret);
    }
    return { displayName, clientType: input.clientType, redirectUris, allowedScopes: parsed.scopes, status, secret, secretHash };
}

function registerClient(input, actorUserId) {
    const normalized = normalizeClientInput(input, { requireSecret: input.clientType === 'confidential' });
    if (normalized.error) return { ok: false, status: 400, error: normalized.error };
    const id = `rn_${crypto.randomBytes(12).toString('base64url')}`;
    const timestamp = nowIso();
    db.prepare(`
        INSERT INTO oauth_clients (
            id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        normalized.displayName,
        normalized.secretHash,
        normalized.clientType,
        JSON.stringify(normalized.redirectUris),
        JSON.stringify(normalized.allowedScopes),
        normalized.status,
        timestamp,
        timestamp
    );
    recordAudit('oauth_client_created', { actorUserId, clientId: id, detail: { clientType: normalized.clientType } });
    const client = getClient(id);
    return { ok: true, client: publicClient(client), clientSecret: normalized.secret };
}

function updateClient(id, input, actorUserId) {
    const existing = getClient(id);
    if (!existing) return { ok: false, status: 404, error: 'OAuth client was not found.' };
    const normalized = normalizeClientInput({
        displayName: input.displayName ?? existing.displayName,
        clientType: existing.clientType,
        redirectUris: input.redirectUris ?? existing.redirectUris,
        allowedScopes: input.allowedScopes ?? existing.allowedScopes,
        status: input.status ?? existing.status
    }, { requireSecret: false });
    if (normalized.error) return { ok: false, status: 400, error: normalized.error };
    db.prepare(`
        UPDATE oauth_clients
        SET display_name = ?, redirect_uris = ?, allowed_scopes = ?, status = ?, updated_at = ?
        WHERE id = ?
    `).run(
        normalized.displayName,
        JSON.stringify(normalized.redirectUris),
        JSON.stringify(normalized.allowedScopes),
        normalized.status,
        nowIso(),
        id
    );
    recordAudit('oauth_client_updated', { actorUserId, clientId: id, detail: { status: normalized.status } });
    return { ok: true, client: publicClient(getClient(id)) };
}

function rotateClientSecret(id, actorUserId) {
    const existing = getClient(id);
    if (!existing) return { ok: false, status: 404, error: 'OAuth client was not found.' };
    if (existing.clientType !== 'confidential') return { ok: false, status: 400, error: 'Public clients do not have a secret.' };
    const secret = randomToken('rnsec');
    db.prepare('UPDATE oauth_clients SET secret_hash = ?, updated_at = ? WHERE id = ?').run(sha256(secret), nowIso(), id);
    recordAudit('oauth_client_updated', { actorUserId, clientId: id, detail: { secretRotated: true } });
    return { ok: true, client: publicClient(getClient(id)), clientSecret: secret };
}

function ensureCapacityExchangeClient() {
    const byId = db.prepare('SELECT id FROM oauth_clients WHERE id = ?').get(CAPACITY_EXCHANGE_CLIENT_ID);
    if (byId) return byId.id;
    const existing = db.prepare('SELECT id FROM oauth_clients WHERE display_name = ?').get(CAPACITY_EXCHANGE_DISPLAY_NAME);
    if (existing) return existing.id;
    const timestamp = nowIso();
    db.prepare(`
        INSERT INTO oauth_clients (
            id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
        ) VALUES (?, ?, NULL, 'confidential', '[]', ?, 'active', ?, ?)
    `).run(
        CAPACITY_EXCHANGE_CLIENT_ID,
        CAPACITY_EXCHANGE_DISPLAY_NAME,
        JSON.stringify(SCOPES),
        timestamp,
        timestamp
    );
    return CAPACITY_EXCHANGE_CLIENT_ID;
}

function authorizationServerMetadata(origin) {
    return {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        userinfo_endpoint: `${origin}/oauth/userinfo`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: SCOPES,
        service_documentation: `${origin}/docs/partner-integration.md`
    };
}

function protectedResourceMetadata(origin) {
    return {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_documentation: `${origin}/docs/partner-integration.md`
    };
}

module.exports = {
    beginAuthorization,
    completeAuthorization,
    grantToken,
    revokePresentedToken,
    verifyAccessToken,
    userInfo,
    listUserGrants,
    revokeUserClientGrant,
    listClientsAdmin,
    registerClient,
    updateClient,
    rotateClientSecret,
    ensureCapacityExchangeClient,
    authorizationServerMetadata,
    protectedResourceMetadata,
    escapeHtml
};
