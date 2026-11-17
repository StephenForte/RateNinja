const assert = require('node:assert/strict');
const { call } = require('./r1-19');

async function createKey(baseUrl, session, label = 'Synthetic test key') {
    const result = await call(baseUrl, session, 'POST', '/api/account/api-keys', { label });
    assert.equal(result.status, 201, result.text);
    return result.json;
}

module.exports = { createKey };
