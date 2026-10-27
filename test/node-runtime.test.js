'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const MINIMUM_RENDER_NODE = [26, 12, 1];

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function versionAtLeast(version, minimum) {
    const parts = version.split('.').map(part => Number(part));
    assert.equal(parts.length, 3, version);
    for (let index = 0; index < minimum.length; index += 1) {
        if (parts[index] > minimum[index]) return true;
        if (parts[index] < minimum[index]) return false;
    }
    return true;
}

describe('Render Node.js pin', () => {
    it('pins the Render build to Node.js 26.12.1 or higher and leaves local engines on 22+', () => {
        const blueprint = read('render.yaml');
        const match = blueprint.match(/- key: NODE_VERSION\s+value:\s*"(\d+\.\d+\.\d+)"/);
        assert.ok(match, 'render.yaml must set NODE_VERSION to a quoted x.y.z value');
        assert.equal(versionAtLeast(match[1], MINIMUM_RENDER_NODE), true, match[1]);
        assert.match(blueprint, /runtime:\s*node/);
        assert.equal(blueprint.includes('PYTHON_VERSION'), false);
        assert.equal(blueprint.includes('PHP'), false);

        const manifest = JSON.parse(read('package.json'));
        assert.equal(manifest.engines.node, '>=22');

        const readme = read('README.md');
        assert.match(readme, /Node\.js 22 or later/);
        assert.match(readme, new RegExp(`NODE_VERSION\` is \`${match[1]}`));
        assert.match(readme, /does not run PHP or Python/);
    });
});
