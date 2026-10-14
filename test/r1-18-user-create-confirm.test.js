const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('R1-18: retired Airtable migration refuses without opening a database', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-18-guard-'));
    const database = path.join(temporary, 'must-not-exist.db');
    const env = { ...process.env, SQLITE_DB_PATH: database };
    delete env.AIRTABLE_PAT;
    try {
        const result = spawnSync(process.execPath, ['scripts/migrate-from-airtable.js'], {
            cwd: root, env, encoding: 'utf8', timeout: 10_000
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /D-026/);
        assert.match(result.stdout + result.stderr, /raw Airtable shape cannot be started or restored on Round 1 code/);
        assert.equal(fs.existsSync(database), false, 'refusal must happen before lib/db opens SQLite');
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

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
