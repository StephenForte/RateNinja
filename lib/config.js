try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional; deployment platforms normally provide environment variables.
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = require('node:path').join(__dirname, '..');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PUBLIC_API_RATE_LIMIT = 60;
const PUBLIC_API_WINDOW_MS = 60 * 1000;
const PARTNER_RATE_LIMIT = 60;
const PARTNER_WINDOW_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_IP_MAX_FAILURES = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const config = {
    sessionSecret: process.env.SESSION_SECRET,
    publicApiKey: process.env.RATE_NINJA_API_KEY
};

function partnerOauthEnabled() {
    const flag = process.env.PARTNER_OAUTH_ENABLED;
    if (flag === 'true') return true;
    if (flag === 'false') return false;
    return process.env.NODE_ENV !== 'production';
}

function oauthSigningKey() {
    return process.env.OAUTH_SIGNING_SECRET || config.sessionSecret || '';
}

module.exports = {
    PORT,
    HOST,
    ROOT,
    SESSION_TTL_MS,
    PUBLIC_API_RATE_LIMIT,
    PUBLIC_API_WINDOW_MS,
    PARTNER_RATE_LIMIT,
    PARTNER_WINDOW_MS,
    ACCESS_TOKEN_TTL_MS,
    AUTH_CODE_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    LOGIN_MAX_FAILURES,
    LOGIN_IP_MAX_FAILURES,
    LOGIN_WINDOW_MS,
    config,
    partnerOauthEnabled,
    oauthSigningKey
};
