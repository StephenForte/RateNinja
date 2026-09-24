const { readdirSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', 'data', '.git']);

function walk(directory) {
    for (const entry of readdirSync(directory)) {
        if (skip.has(entry)) continue;
        const fullPath = path.join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
            walk(fullPath);
            continue;
        }
        if (!fullPath.endsWith('.js')) continue;
        const result = spawnSync(process.execPath, ['--check', fullPath], { stdio: 'inherit' });
        if (result.status) process.exit(result.status);
    }
}

walk(root);
