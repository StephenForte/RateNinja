'use strict';

async function partnerSend(baseUrl, token, method, urlPath, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (Object.prototype.hasOwnProperty.call(options, 'raw')) {
        headers['content-type'] = 'application/json';
        body = options.raw;
    } else if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.body);
    }
    const response = await fetch(`${baseUrl}${urlPath}`, { method, headers, body });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { status: response.status, text, body: parsed };
}

function assertNoBase(assert, payload, base) {
    const json = JSON.stringify(payload);
    assert.equal(json.includes(String(base)), false, json);
    assert.equal(/basePrice|rate20D|rate40D|rate40HC|rate_20d/i.test(json), false, json);
}

module.exports = {
    partnerSend,
    assertNoBase
};
