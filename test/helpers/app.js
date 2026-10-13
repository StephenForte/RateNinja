/**
 * Start Rate Ninja for a Round 1 test.
 *
 * lib/db.js opens SQLite and runs migrations when it is first required, so this
 * helper sets SQLITE_DB_PATH (and MIGRATIONS_DIR, when you pass migrationsDir)
 * before it loads server.js. Require this module and call startApp() before any
 * other require of server.js or lib/db.js. The test script runs each file in
 * its own process; call startApp() once per process.
 *
 * startApp(options) creates a temporary SQLite file, seeds one company and one
 * user, listens on 127.0.0.1 at an ephemeral port, and logs that user in.
 *
 * options.companyType: 'Contract Owner' (default) or 'Freight Forwarder/Customer'.
 *   'owner' and 'customer' are accepted aliases.
 * options.role: 'admin' (default) or 'member'. This sets users.admin_screen.
 *   company_role and is_system_admin arrive in R1-02; this helper does not set them.
 * options.username: login name. Default 'r101-admin' or 'r101-member'.
 * options.password: default 'sail-the-ocean' (must be 12–200 characters).
 * options.migrationsDir: fixture directory. Omit it to use lib/migrations.
 *
 * The returned client carries the session cookie and CSRF token:
 *   baseUrl, cookie, csrf, user, username, password, company, db, dbPath, directory
 *   request(path, { method, headers, body, cookie, csrf, redirect })
 *     cookie:false omits the session cookie. csrf:false omits X-CSRF-Token.
 *     Unsafe methods send the CSRF header unless you opt out.
 *   close() stops the server, closes the database, and deletes directory.
 * Call close() from after(). One failed startApp() deletes its own directory.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CUSTOMER_ID
} = require('../../lib/constants');

const DEFAULT_PASSWORD = 'sail-the-ocean';

function resolveCompanyType(companyType) {
    const value = companyType || COMPANY_TYPE_CONTRACT_OWNER;
    if (value === COMPANY_TYPE_CONTRACT_OWNER || value === 'owner' || value === COMPANY_TYPE_CONTRACT_OWNER_ID) {
        return { typeName: COMPANY_TYPE_CONTRACT_OWNER, typeId: COMPANY_TYPE_CONTRACT_OWNER_ID };
    }
    if (value === COMPANY_TYPE_CUSTOMER || value === 'customer' || value === COMPANY_TYPE_CUSTOMER_ID) {
        return { typeName: COMPANY_TYPE_CUSTOMER, typeId: COMPANY_TYPE_CUSTOMER_ID };
    }
    throw new Error(`Unknown companyType '${value}'. Use 'Contract Owner' or 'Freight Forwarder/Customer'.`);
}

function resolveRole(role) {
    if (role === undefined || role === 'admin') return 1;
    if (role === 'member') return 0;
    throw new Error(`Unknown role '${role}'. Use 'admin' or 'member'.`);
}

function cookieHeader(response) {
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return cookies.map(value => value.split(';')[0]).join('; ');
}

function seed(db, options) {
    const companyType = resolveCompanyType(options.companyType);
    const adminScreen = resolveRole(options.role);
    const username = options.username || (adminScreen ? 'r101-admin' : 'r101-member');
    const companyId = `r101-${cryptoId()}`;
    const userId = `r101-${cryptoId()}`;
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(companyId, companyId, options.companyName || 'R1 Test Company', companyType.typeName, companyType.typeId, companyId, adminScreen);
    db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen,
            password_hash, password_hash_version, disabled, session_epoch, company_record_id
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)
    `).run(userId, username, username, companyId, companyId, companyId, adminScreen, companyId);
    return {
        username,
        userId,
        company: { id: companyId, name: options.companyName || 'R1 Test Company', type: companyType.typeName }
    };
}

function cryptoId() {
    return require('node:crypto').randomBytes(8).toString('hex');
}

async function login(baseUrl, username, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await response.json();
    if (response.status !== 200 || !body.csrfToken) {
        throw new Error(`Login failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return { cookie: cookieHeader(response), csrf: body.csrfToken, user: body.user };
}

async function startApp(options = {}) {
    if (require.cache[require.resolve('../../lib/db')]) {
        throw new Error('startApp() must run before lib/db.js or server.js is required. Call it before any other app import.');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-app-'));
    const dbPath = path.join(directory, 'app.db');
    process.env.SQLITE_DB_PATH = dbPath;
    if (options.migrationsDir) process.env.MIGRATIONS_DIR = options.migrationsDir;
    if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'test-session-secret-value-which-is-long';
    if (!process.env.OAUTH_SIGNING_SECRET) process.env.OAUTH_SIGNING_SECRET = 'test-oauth-signing-secret-value-long';
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
    let server;
    let db;
    try {
        ({ server } = require('../../server'));
        ({ db } = require('../../lib/db'));
        const { setPasswordByUsername } = require('../../lib/accounts');
        const seeded = seed(db, options);
        const password = options.password || DEFAULT_PASSWORD;
        const set = setPasswordByUsername(seeded.username, password);
        if (!set.ok) throw new Error(set.error || 'Could not set the test password.');
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const loggedIn = await login(baseUrl, seeded.username, password);
        let closed = false;
        async function request(urlPath, requestOptions = {}) {
            const method = requestOptions.method || 'GET';
            const headers = new Headers(requestOptions.headers || {});
            if (requestOptions.cookie !== false) headers.set('cookie', loggedIn.cookie);
            const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
            if (requestOptions.csrf !== false && unsafe && !headers.has('x-csrf-token')) {
                headers.set('x-csrf-token', loggedIn.csrf);
            }
            return fetch(new URL(urlPath, baseUrl), {
                method,
                headers,
                body: requestOptions.body,
                redirect: requestOptions.redirect || 'manual'
            });
        }
        async function close() {
            if (closed) return;
            closed = true;
            await new Promise(resolve => server.close(resolve));
            try {
                db.close();
            } catch {
                // Already closed.
            }
            fs.rmSync(directory, { recursive: true, force: true });
        }
        return {
            baseUrl,
            cookie: loggedIn.cookie,
            csrf: loggedIn.csrf,
            user: loggedIn.user,
            username: seeded.username,
            password,
            company: seeded.company,
            db,
            dbPath,
            directory,
            request,
            close
        };
    } catch (error) {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (db) {
            try {
                db.close();
            } catch {
                // Temporary database.
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

module.exports = {
    startApp,
    DEFAULT_PASSWORD
};
