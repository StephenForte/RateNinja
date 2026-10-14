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
const KNOWN_PUBLIC_ORIGIN = 'https://rate-ninja.onrender.com';
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

function positiveInt(name, fallback) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return fallback;
    return value;
}

function importMaxBytes() {
    return positiveInt('IMPORT_MAX_BYTES', 5_000_000);
}

function importMaxRows() {
    return positiveInt('IMPORT_MAX_ROWS', 10_000);
}

function importSampleRows() {
    return positiveInt('IMPORT_SAMPLE_ROWS', 5);
}

function importSampleChars() {
    return positiveInt('IMPORT_SAMPLE_CHARS', 8_000);
}

function importMappingModel() {
    const configured = process.env.IMPORT_MAPPING_MODEL;
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return 'claude-sonnet-5-5';
}

function importMappingTimeoutMs() {
    return positiveInt('IMPORT_MAPPING_TIMEOUT_MS', 20_000);
}

function publicOrigin() {
    const configured = process.env.PUBLIC_ORIGIN || KNOWN_PUBLIC_ORIGIN;
    try {
        const url = new URL(configured);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
            return KNOWN_PUBLIC_ORIGIN;
        }
        return url.origin;
    } catch {
        return KNOWN_PUBLIC_ORIGIN;
    }
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
    KNOWN_PUBLIC_ORIGIN,
    partnerOauthEnabled,
    oauthSigningKey,
    publicOrigin,
    importMaxBytes,
    importMaxRows,
    importSampleRows,
    importSampleChars,
    importMappingModel,
    importMappingTimeoutMs
};
