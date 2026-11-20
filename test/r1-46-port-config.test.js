const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');

const configPath = require.resolve('../lib/config');
const cwd = mkdtempSync(join(tmpdir(), 'rateninja-port-config-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

for (const [value, expected] of [[undefined, 3000], ['', 3000], ['0', 0], ['10000', 10000], ['abc', 3000]]) {
    test(`port config reads ${value === undefined ? 'unset PORT' : `PORT=${JSON.stringify(value)}`}`, () => {
        const env = { ...process.env, PORT: value };
        if (value === undefined) delete env.PORT;
        const output = execFileSync(process.execPath, [
            '-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).PORT))`
        ], { cwd, env, encoding: 'utf8' });

        assert.equal(JSON.parse(output), expected);
    });
}
