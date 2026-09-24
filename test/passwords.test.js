const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, validatePassword } = require('../lib/passwords');

describe('argon2id passwords', () => {
    it('stores an Argon2id PHC string and rejects a different password', () => {
        const password = 'correct-horse-battery';
        const hash = hashPassword(password);
        assert.match(hash, /^\$argon2id\$/);
        assert.equal(verifyPassword(hash, password), true);
        assert.equal(verifyPassword(hash, 'wrong-horse-battery'), false);
        assert.equal(validatePassword('short'), 'Password must be 12 to 200 characters.');
        assert.equal(validatePassword(password), null);
    });
});
