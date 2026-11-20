'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-50-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'r1-50.db');
process.env.SESSION_SECRET = 'r1-50-session-secret-value-which-is-long';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { runManagedAgents } = require('../lib/managed-agent-runner');
const { agent, env, fakeAdmin, fakeProviders, RATE_ID } = require('./helpers/r1-35');

const ROOT = path.join(__dirname, '..');
const MFA_PATH = path.join(ROOT, 'lib', 'mfa.js');
const FA_600 = 'sha512-9usAa10IRO0HhonpyAIVpjrylPvoDwiPUiKdWk5t3PyolY1cOd4DSE0Ga+ri4AuTroPR5aQvXU9xC6qOPnzFeg==';
const FA_652 = 'sha512-SnH5WK+bZxgPHs44uWIX+LLJAJ9/2PkPKZ5QiAj6Ta86w+fsb2TkcmfRyVX3pBnMFcV7oQPJkl9QevSCWr3W6A==';

function loadExported(filePath, names) {
    const source = fs.readFileSync(filePath, 'utf8').replace(
        'module.exports = {',
        `module.exports = { ${names.join(', ')},`
    );
    const rewritten = source.replaceAll("require('./", `require('${path.join(ROOT, 'lib')}/`);
    const file = path.join(tmpDir, path.basename(filePath));
    fs.writeFileSync(file, rewritten);
    return require(file);
}

const { encryptSecret, decryptSecret } = loadExported(MFA_PATH, ['encryptSecret', 'decryptSecret']);
const { replaceBookingCode } = loadExported(path.join(ROOT, 'lib', 'managed-agent-runner.js'), ['replaceBookingCode']);

it('round-trips a secret from encryptSecret', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
    assert.equal(decryptSecret(encryptSecret('')), '');
});

it('returns null for a payload shorter than 28 bytes without decrypting', () => {
    const raw = Buffer.from(encryptSecret(''), 'base64url');
    assert.equal(raw.length, 28);
    // A 4-byte tag over the empty ciphertext is under 28 bytes. Node 22 will
    // authenticate that truncation when authTagLength is unset; Node 26 will not.
    const short = raw.subarray(0, 16).toString('base64url');
    const calls = [];
    const original = crypto.createDecipheriv;
    crypto.createDecipheriv = function (...args) {
        calls.push(args);
        return original.apply(this, args);
    };
    try {
        assert.equal(decryptSecret(short), null);
        assert.equal(calls.length, 0, 'short payloads must be rejected before decryption');
    } finally {
        crypto.createDecipheriv = original;
    }
});

it('returns null when the authentication tag is altered', () => {
    const raw = Buffer.from(encryptSecret('totp-secret'), 'base64url');
    raw[12] ^= 0xff;
    assert.equal(decryptSecret(raw.toString('base64url')), null);
});

async function runWith(bookingCode, summary, companyName) {
    const admin = fakeAdmin([agent('one', { companyName })]);
    const providers = fakeProviders({
        bookingCode,
        judge: () => ({ rateId: RATE_ID, summary })
    });
    let output = '';
    const writer = { write: text => { output += text; } };
    const code = await runManagedAgents({
        env, confirmed: true, stdout: writer, stderr: writer,
        fetchImpl: async (url, options) => {
            options.signal.throwIfAborted();
            const target = new URL(url);
            const body = options.body && JSON.parse(options.body);
            return target.hostname === 'rateninja.invalid'
                ? admin.reply(target, options.method, body)
                : providers.reply(target, options.method, body);
        }
    });
    return { code, output, summary: [...admin.states.values()][0].resultSummary };
}

it('replaces every casing of a booking code with [redacted]', async () => {
    const code = 'AbC12xY9Z';
    const result = await runWith(
        code,
        'Saw abc12xy9z and ABC12XY9Z and AbC12xY9Z.',
        `Firm ${code} ${code.toLowerCase()}`
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.summary, /Saw \[redacted\] and \[redacted\] and \[redacted\]\./);
    assert.equal(result.summary.toLowerCase().includes(code.toLowerCase()), false);
    assert.equal(result.output.toLowerCase().includes(code.toLowerCase()), false);
    assert.equal((result.output.match(/\[redacted\]/g) || []).length, 2);
});

it('replaces a booking code that contains regex metacharacters literally', () => {
    const input = 'Keep AZC, replace A.B*C and a.b*c and A.B*C.';
    assert.equal(
        replaceBookingCode(input, 'A.B*C'),
        'Keep AZC, replace [redacted] and [redacted] and [redacted].'
    );
});

it('pins every workflow uses line to a 40-character commit', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const uses = [];
    for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.yml')).sort()) {
        for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
            const match = line.match(/^\s*uses:\s*(\S+)/);
            if (match) uses.push(`${name}: ${match[1]}`);
        }
    }
    assert.ok(uses.includes('ci.yml: actions/checkout@11d5960a326750d5838078e36cf38b85af677262'));
    assert.ok(uses.includes('ci.yml: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'));
    assert.ok(uses.length >= 2);
    for (const entry of uses) assert.match(entry, /@[0-9a-f]{40}$/);
});

it('adds SRI and crossorigin to each Font Awesome stylesheet', () => {
    const expected = {
        'index.html': FA_600,
        'login.html': FA_600,
        'api-testbed.html': FA_652
    };
    const found = {};
    for (const name of fs.readdirSync(path.join(ROOT, 'public')).filter(file => file.endsWith('.html'))) {
        for (const line of fs.readFileSync(path.join(ROOT, 'public', name), 'utf8').split('\n')) {
            if (!line.includes('font-awesome') || !line.includes('<link')) continue;
            assert.match(line, /integrity="sha512-[A-Za-z0-9+/=]+"/);
            assert.match(line, /crossorigin="anonymous"/);
            assert.match(line, /referrerpolicy="no-referrer"/);
            const integrity = line.match(/integrity="([^"]+)"/)[1];
            found[name] = integrity;
        }
    }
    assert.deepEqual(found, expected);
});
