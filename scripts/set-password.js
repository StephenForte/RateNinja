#!/usr/bin/env node
require('../lib/config');
const { ensureFoundation } = require('../lib/foundation');
const { setPasswordByUsername } = require('../lib/accounts');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
    console.error('Usage: node scripts/set-password.js <username> <password>');
    process.exitCode = 1;
} else {
    ensureFoundation();
    const result = setPasswordByUsername(username, password);
    if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
    } else {
        console.log(`Password updated for ${username}.`);
    }
}
