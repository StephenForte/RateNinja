try {
    process.loadEnvFile('.env');
} catch {
    // .env is optional; deployment platforms normally provide environment variables.
}

const PORT = Number(process.env.PORT) || 3000;
const ROOT = require('node:path').join(__dirname, '..');
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PUBLIC_API_RATE_LIMIT = 60;
const PUBLIC_API_WINDOW_MS = 60 * 1000;
const AIRTABLE_CACHE_TTL_MS = Number(process.env.AIRTABLE_CACHE_TTL_MS) || 60_000;
const AIRTABLE_TIMEOUT_MS = Number(process.env.AIRTABLE_TIMEOUT_MS) || 15_000;
const SAILINGS_MAX_RECORDS = 100;

const config = {
    apiToken: process.env.AIRTABLE_PAT,
    sessionSecret: process.env.SESSION_SECRET,
    publicApiKey: process.env.RATE_NINJA_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID || 'appBLegnJMAienppq',
    cacheTtlMs: AIRTABLE_CACHE_TTL_MS,
    timeoutMs: AIRTABLE_TIMEOUT_MS,
    sailingsMaxRecords: SAILINGS_MAX_RECORDS,
    tables: {
        rates: process.env.AIRTABLE_RATE_TABLE_ID || 'tbl5OpIdW2kyRRWLp',
        users: process.env.AIRTABLE_USER_TABLE_ID || 'tblwtjp73CaWe3GKy',
        companies: process.env.AIRTABLE_COMPANY_TABLE_ID || 'CompanyReference',
        sailings: process.env.AIRTABLE_SAILINGS_TABLE_ID || 'Sailings'
    }
};

module.exports = {
    PORT,
    ROOT,
    SESSION_TTL_MS,
    PUBLIC_API_RATE_LIMIT,
    PUBLIC_API_WINDOW_MS,
    config
};
