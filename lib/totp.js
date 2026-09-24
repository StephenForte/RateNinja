const crypto = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function encodeBase32(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
    return output;
}

function decodeBase32(input) {
    const clean = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const index = BASE32.indexOf(char);
        if (index < 0) return null;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateSecret() {
    return encodeBase32(crypto.randomBytes(20));
}

function hotp(secret, counter) {
    const key = decodeBase32(secret);
    if (!key || !key.length) return null;
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(message).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % (10 ** DIGITS);
    return String(binary).padStart(DIGITS, '0');
}

function currentStep(now = Date.now()) {
    return Math.floor(now / 1000 / STEP_SECONDS);
}

function codesMatch(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function verifyTotp(secret, token, now = Date.now(), lastStep = null) {
    if (!/^\d{6}$/.test(String(token || ''))) return null;
    const counter = currentStep(now);
    for (const step of [counter - 1, counter, counter + 1]) {
        if (lastStep !== null && lastStep !== undefined && step <= Number(lastStep)) continue;
        const expected = hotp(secret, step);
        if (expected && codesMatch(expected, token)) return step;
    }
    return null;
}

function otpauthUrl(username, secret) {
    const label = encodeURIComponent(`Rate Ninja:${username}`);
    const query = new URLSearchParams({
        secret,
        issuer: 'Rate Ninja',
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return `otpauth://totp/${label}?${query}`;
}

module.exports = {
    generateSecret,
    hotp,
    verifyTotp,
    otpauthUrl,
    currentStep
};
