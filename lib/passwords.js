const crypto = require('node:crypto');
const { hashSync, verifySync, Algorithm } = require('@node-rs/argon2');
const { MIN_PASSWORD_LENGTH, PASSWORD_HASH_VERSION } = require('./constants');

const ARGON_OPTIONS = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
};

const DUMMY_HASH = hashSync(`dummy-${crypto.randomBytes(16).toString('hex')}`, ARGON_OPTIONS);

function hashPassword(password) {
    return hashSync(password, ARGON_OPTIONS);
}

function verifyPassword(passwordHash, password) {
    try {
        return verifySync(passwordHash, password);
    } catch {
        return false;
    }
}

function verifyPasswordOrDummy(passwordHash, password) {
    if (passwordHash) return verifyPassword(passwordHash, password);
    verifyPassword(DUMMY_HASH, password);
    return false;
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
        return `Password must be ${MIN_PASSWORD_LENGTH} to 200 characters.`;
    }
    if (/[\r\n]/.test(password)) return 'Password must not contain line breaks.';
    return null;
}

module.exports = {
    ARGON_OPTIONS,
    PASSWORD_HASH_VERSION,
    hashPassword,
    verifyPassword,
    verifyPasswordOrDummy,
    validatePassword
};
