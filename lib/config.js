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

const config = {
    sessionSecret: process.env.SESSION_SECRET,
    publicApiKey: process.env.RATE_NINJA_API_KEY
};

module.exports = {
    PORT,
    ROOT,
    SESSION_TTL_MS,
    PUBLIC_API_RATE_LIMIT,
    PUBLIC_API_WINDOW_MS,
    config
};
