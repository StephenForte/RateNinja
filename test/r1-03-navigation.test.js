const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const member = {
    signedIn: true,
    systemAdmin: false,
    companyAdmin: false,
    contractOwner: false,
    legacy: false,
    companyContext: null,
    companyName: ''
};
const customerAdmin = { ...member, companyAdmin: true, companyName: 'Blackwater' };
const ownerAdmin = { ...member, companyAdmin: true, contractOwner: true, companyName: 'Kings Group' };
const systemAdmin = { ...member, systemAdmin: true, companyContext: { id: 'kings', name: 'Kings Group' } };
const everyRole = { ...systemAdmin, companyAdmin: true, contractOwner: true };

describe('app shell routes', () => {
    it('maps every registered path and rejects the unknown ones', async () => {
        const { sections } = await import('../public/js/registry.js');
        const { resolveRoute } = await import('../public/js/router.js');
        for (const section of sections) {
            const decision = resolveRoute(section.path, everyRole);
            assert.equal(decision.kind, 'section', section.path);
            assert.equal(decision.section.id, section.id);
            assert.equal(decision.section.area, section.area);
        }
        assert.deepEqual(resolveRoute('/', member), { kind: 'redirect', path: '/rates' });
        assert.deepEqual(resolveRoute('/index.html', member), { kind: 'redirect', path: '/rates' });
        assert.deepEqual(resolveRoute('/profile', member), { kind: 'redirect', path: '/profile/account' });
        assert.deepEqual(resolveRoute('/profile/', member), { kind: 'redirect', path: '/profile/account' });
        for (const path of ['/profile/nope', '/admin/nope', '/admin', '/settings', '/rates/extra', '/profile/security/extra', '/admin/x.css']) {
            assert.equal(resolveRoute(path, everyRole).kind, 'not-found', path);
        }
    });

    it('resolves a forbidden section to access-denied', async () => {
        const { resolveRoute } = await import('../public/js/router.js');
        const denied = [
            [member, '/admin/users'],
            [member, '/admin/customers'],
            [member, '/profile/connected-apps'],
            [customerAdmin, '/admin/customers'],
            [customerAdmin, '/admin/companies'],
            [customerAdmin, '/admin/oauth-clients'],
            [ownerAdmin, '/admin/companies'],
            [ownerAdmin, '/admin/oauth-clients'],
            [systemAdmin, '/profile/connected-apps']
        ];
        for (const [permissions, path] of denied) {
            const decision = resolveRoute(path, permissions);
            assert.equal(decision.kind, 'access-denied', path);
            assert.equal(decision.section.path, path);
        }
        assert.equal(resolveRoute('/profile/security', member).kind, 'section');
        assert.equal(resolveRoute('/admin/users', customerAdmin).kind, 'section');
        assert.equal(resolveRoute('/admin/customers', ownerAdmin).kind, 'section');
        assert.equal(resolveRoute('/admin/companies', systemAdmin).kind, 'section');
        assert.equal(resolveRoute('/admin/oauth-clients', systemAdmin).kind, 'section');
    });
});

describe('menu matches the role', () => {
    it('lists exactly the sections each role may open', async () => {
        const { menuFor } = await import('../public/js/menu.js');
        const paths = permissions => menuFor(permissions).map(item => item.path);
        assert.deepEqual(paths(member), [
            '/rates',
            '/profile/account',
            '/profile/security',
            '/profile/preferences'
        ]);
        assert.deepEqual(paths(customerAdmin), [
            '/rates',
            '/profile/account',
            '/profile/security',
            '/profile/preferences',
            '/admin/users',
            '/admin/integrations'
        ]);
        assert.deepEqual(paths(ownerAdmin), [
            '/rates',
            '/profile/account',
            '/profile/security',
            '/profile/preferences',
            '/profile/connected-apps',
            '/admin/users',
            '/admin/customers',
            '/admin/data',
            '/admin/pull-forward',
            '/admin/imports',
            '/admin/integrations'
        ]);
        assert.deepEqual(paths(systemAdmin), [
            '/rates',
            '/profile/account',
            '/profile/security',
            '/profile/preferences',
            '/admin/users',
            '/admin/companies',
            '/admin/customers',
            '/admin/data',
            '/admin/pull-forward',
            '/admin/imports',
            '/admin/integrations',
            '/admin/oauth-clients'
        ]);
    });

    it('keeps OAuth clients on the legacy admin flag until the session carries permissions', async () => {
        const { menuFor } = await import('../public/js/menu.js');
        const { permissionsFromUser } = await import('../public/js/permissions.js');
        const legacy = permissionsFromUser({
            username: 'Ada',
            isAdmin: true,
            isContractOwner: false,
            companyName: 'Blackwater'
        });
        assert.equal(legacy.legacy, true);
        assert.equal(legacy.systemAdmin, false);
        assert.equal(legacy.companyAdmin, true);
        assert.equal(menuFor(legacy).some(item => item.path === '/admin/oauth-clients'), true);
        const modern = permissionsFromUser({
            username: 'Ada',
            isAdmin: true,
            permissions: { systemAdmin: false, companyAdmin: true, contractOwner: false },
            companyContext: null,
            companyName: 'Blackwater'
        });
        assert.equal(modern.legacy, false);
        assert.equal(menuFor(modern).some(item => item.path === '/admin/oauth-clients'), false);
    });
});

describe('company context and OAuth next', () => {
    it('blocks a system admin company operation without a selected company and repeats the name otherwise', async () => {
        const { companyOperationGate } = await import('../public/js/confirm.js');
        const { companyIndicator, contextFromPayload } = await import('../public/js/permissions.js');
        const missing = companyOperationGate({ ...systemAdmin, companyContext: null }, 'Save customer margins.');
        assert.equal(missing.allowed, false);
        assert.match(missing.message, /Select a company/);
        const named = companyOperationGate(systemAdmin, 'Save customer margins.');
        assert.equal(named.allowed, true);
        assert.match(named.message, /Kings Group/);
        const owner = companyOperationGate(ownerAdmin, 'Pull rates forward.');
        assert.equal(owner.allowed, true);
        assert.match(owner.message, /Kings Group/);
        assert.deepEqual(companyIndicator(systemAdmin), { visible: true, text: 'Selected company: Kings Group' });
        assert.deepEqual(companyIndicator({ ...systemAdmin, companyContext: null }), { visible: true, text: 'No company selected' });
        assert.equal(companyIndicator(ownerAdmin).visible, false);
        assert.deepEqual(contextFromPayload({ companyContext: { id: 'kings', name: 'Kings Group' } }), { id: 'kings', name: 'Kings Group' });
        assert.deepEqual(contextFromPayload({ company: { id: 'acme', name: 'Acme' } }), { id: 'acme', name: 'Acme' });
        assert.equal(contextFromPayload(null), null);
    });

    it('accepts only a same-origin OAuth authorize next URL', async () => {
        const { safeOauthNext } = await import('../public/js/oauth-next.js');
        assert.equal(safeOauthNext('/oauth/authorize?client_id=abc'), '/oauth/authorize?client_id=abc');
        assert.equal(safeOauthNext('https://evil.example/oauth/authorize?client_id=abc'), null);
        assert.equal(safeOauthNext('/login'), null);
        assert.equal(safeOauthNext('/oauth/authorize?client_id=abc\\n'), null);
        assert.equal(safeOauthNext('/oauth/token'), null);
    });
});

describe('shell assets stay absolute', () => {
    it('loads the stylesheet, icon, and module entry from the site root', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
        assert.match(html, /href="\/styles\.css"/);
        assert.match(html, /href="\/favicon\.svg"/);
        assert.match(html, /type="module" src="\/js\/main\.js"/);
        assert.equal(html.includes('script.js'), false);
        assert.equal(html.includes('onclick='), false);
        const root = path.join(__dirname, '..', 'public', 'js');
        const files = [];
        const walk = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) walk(fullPath);
                else if (entry.name.endsWith('.js')) files.push(fullPath);
            }
        };
        walk(root);
        assert.ok(files.length > 5);
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            assert.equal(/fetch\(\s*['"](?!\/|https?:)/.test(text), false, file);
        }
    });
});
