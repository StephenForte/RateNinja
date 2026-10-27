const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('R1-18: user create confirms and returns on denial before sending the request', () => {
    const source = fs.readFileSync(path.join(root, 'public/js/admin/users.js'), 'utf8');
    const start = source.indexOf("create.addEventListener('click'");
    const end = source.indexOf('function openEditor', start);
    assert.ok(start >= 0 && end > start, 'isolate the create click handler');
    const handler = source.slice(start, end);
    const gate = /const\s+(\w+)\s*=\s*confirmed\s*\(/.exec(handler);
    assert.ok(gate, 'create uses the existing confirmed helper');
    const request = /request\s*\(\s*['"]\/api\/admin\/users['"]/.exec(handler);
    assert.ok(request && gate.index < request.index, 'confirmation precedes the create request');
    const beforeRequest = handler.slice(gate.index, request.index);
    assert.match(beforeRequest, new RegExp(`if\\s*\\(\\s*!${gate[1]}\\.allowed\\s*\\)\\s*\\{[^}]*return\\s*;`),
        'denial or cancellation returns before the request');
    assert.match(beforeRequest, new RegExp(`errors\\.show\\s*\\(\\s*${gate[1]}\\.message\\s*\\)`),
        'context denial displays the gate message');
});
