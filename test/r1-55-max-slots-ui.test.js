'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { catalog } = require('../lib/view-fields');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'lib', 'migrations');

function walk(node) {
    return [node, ...(node.children || []).flatMap(walk)];
}

function classTokens(value) {
    return String(value || '').split(/\s+/).filter(Boolean);
}

function matches(node, selector) {
    if (selector.startsWith('.')) return classTokens(node.className).includes(selector.slice(1));
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector === '[data-column]') return Object.prototype.hasOwnProperty.call(node.dataset || {}, 'column');
    return node.tag === selector;
}

function element(tag) {
    const node = {
        tag,
        children: [],
        parent: null,
        textContent: '',
        value: '',
        title: '',
        hidden: false,
        disabled: false,
        checked: false,
        type: '',
        className: '',
        id: '',
        min: '',
        placeholder: '',
        attributes: {},
        dataset: {},
        events: {},
        append(...children) {
            for (const value of children) {
                const child = typeof value === 'string' ? textNode(value) : value;
                if (child.tag === '#document-fragment') {
                    while (child.children.length) this.append(child.children[0]);
                    continue;
                }
                child.remove();
                child.parent = this;
                this.children.push(child);
            }
        },
        prepend(child) {
            child.remove();
            child.parent = this;
            this.children.unshift(child);
        },
        replaceChildren(...children) {
            while (this.children.length) this.children[0].remove();
            if (children.length) this.append(...children);
        },
        remove() {
            if (!this.parent) return;
            const index = this.parent.children.indexOf(this);
            if (index >= 0) this.parent.children.splice(index, 1);
            this.parent = null;
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(name, handler) { this.events[name] = handler; },
        focus() {},
        add(option) { this.append(option); },
        get options() { return this.children.filter(child => child.tag === 'option'); },
        querySelector(selector) { return walk(this).slice(1).find(item => matches(item, selector)) || null; },
        querySelectorAll(selector) { return walk(this).slice(1).filter(item => matches(item, selector)); }
    };
    node.classList = {
        add(...names) {
            const tokens = new Set(classTokens(node.className));
            names.forEach(name => tokens.add(name));
            node.className = [...tokens].join(' ');
        },
        toggle(name, force) {
            const tokens = new Set(classTokens(node.className));
            const on = force === undefined ? !tokens.has(name) : Boolean(force);
            if (on) tokens.add(name);
            else tokens.delete(name);
            node.className = [...tokens].join(' ');
            return on;
        },
        contains(name) { return classTokens(node.className).includes(name); }
    };
    return node;
}

function textNode(value) {
    return Object.assign(element('#text'), { textContent: String(value) });
}

function installDocument(t) {
    const nodes = [];
    const document = {
        createElement(tag) {
            const node = element(tag);
            nodes.push(node);
            return node;
        },
        createTextNode: textNode,
        createDocumentFragment() {
            return element('#document-fragment');
        },
        getElementById(id) {
            return nodes.find(node => node.id === id) || null;
        }
    };
    function Option(text, value) {
        const node = document.createElement('option');
        node.textContent = text == null ? '' : String(text);
        node.value = value == null ? '' : String(value);
        return node;
    }
    const ids = [
        'loading', 'error', 'errorMessage', 'ratesTableBody', 'ratesTableHead', 'searchInput', 'refreshBtn',
        'predictiveToggle', 'predictiveDate', 'predictiveDateError', 'predictiveBanner', 'predictiveBannerText',
        'prevBtn', 'nextBtn', 'pageInfo', 'sailingsModal', 'contractModal', 'ratesPreferenceBar',
        'carrierFilter', 'originPortFilter', 'destinationPortFilter', 'contractOwnerFilter',
        'closeModal', 'closeContractModal', 'bookingDialog', 'bookingDialogForm', 'bookingDialogClose',
        'bookingDialogMessage', 'bookingDialogSummary', 'bookingDialogSize', 'bookingDialogSlots', 'bookingDialogSubmit'
    ];
    for (const id of ids) {
        const node = document.createElement('div');
        node.id = id;
        if (id === 'bookingDialog') node.hidden = true;
    }
    const globals = {
        document,
        window: { addEventListener() {} },
        location: { search: '', replace() {} },
        Option
    };
    for (const [name, value] of Object.entries(globals)) {
        const previous = Object.getOwnPropertyDescriptor(global, name);
        Object.defineProperty(global, name, { value, configurable: true });
        t.after(() => {
            if (previous) Object.defineProperty(global, name, previous);
            else delete global[name];
        });
    }
    return document;
}

function rate(notes, maxSlotsAllowed, extra = {}) {
    return {
        id: `rate-${notes}`,
        rateType: 'FAK',
        originPort: 'SHA',
        destinationPort: 'LAX',
        inlandDeliveryLocation: '',
        commodityType: 'General',
        carrier: 'MSC',
        contractOwner: 'Owner',
        ownerCompanyName: 'Owner',
        rate20D: 1000,
        rate40D: 1800,
        rate40HC: 1900,
        rateEffectiveDate: '2026-01-01',
        rateExpirationDate: '2026-12-31',
        notes1: notes,
        maxSlotsAllowed,
        predictive: false,
        ...extra
    };
}

function visibleText(node) {
    if (!node) return '';
    if (node.tag === '#text') return node.textContent;
    if (!node.children || node.children.length === 0) return node.textContent || '';
    return node.children.map(visibleText).join('');
}

function headerLabels() {
    const row = document.getElementById('ratesTableHead').children[0];
    return row ? row.children.map(visibleText) : [];
}

function rowFor(note) {
    const body = document.getElementById('ratesTableBody');
    const notes = walk(body).find(node => node.className === 'notes' && node.textContent === note);
    assert.ok(notes, `missing row ${note}`);
    return notes.parent;
}

function buttonIn(row) {
    return row.children.at(-1).children.find(node => node.tag === 'button');
}

describe('r1-55 max slots on the customer grid', () => {
    it('shows Max slots immediately before Request booking and disables 0', async t => {
        installDocument(t);
        const rates = [
            rate('zero', 0),
            rate('four', 4),
            rate('missing', null),
            rate('expired', 2, { rateExpirationDate: '2020-01-01' }),
            rate('unpriced', 2, { rate20D: null, rate40D: null, rate40HC: null }),
            rate('predictive', null, { predictive: true })
        ];
        t.mock.method(global, 'fetch', async requestPath => {
            const url = String(requestPath);
            if (url === '/api/preferences/fields') return Response.json(catalog());
            if (url === '/api/preferences/views') return Response.json({ views: [] });
            if (url === '/api/preferences/queries') return Response.json({ queries: [] });
            if (url === '/api/rates') return Response.json({ rates });
            throw new Error(`unexpected fetch ${url}`);
        });
        const { showRates } = await import('../public/js/rates/browse.js');
        await showRates({ canBook: true });

        const labels = headerLabels();
        assert.equal(labels.at(-2), 'Max slots');
        assert.equal(labels.at(-1), 'Booking');
        const dialog = document.getElementById('bookingDialog');
        assert.equal(dialog.hidden, true);

        const zero = rowFor('zero');
        assert.equal(zero.children.at(-2).textContent, '0');
        assert.equal(zero.children.at(-2).className, 'max-slots');
        assert.equal(zero.children.at(-1).className, 'booking-action');
        const zeroButton = buttonIn(zero);
        assert.equal(zeroButton.disabled, true);
        assert.equal(zeroButton.title, 'No slots available');
        assert.equal(zeroButton.textContent, 'Request booking');
        assert.equal(zeroButton.events.click, undefined);
        zeroButton.events.click?.();
        assert.equal(dialog.hidden, true);

        for (const note of ['four', 'missing']) {
            const row = rowFor(note);
            const expected = note === 'four' ? '4' : '—';
            assert.equal(row.children.at(-2).textContent, expected);
            const button = buttonIn(row);
            assert.equal(button.disabled, false);
            assert.equal(button.title, '');
            assert.equal(typeof button.events.click, 'function');
            dialog.hidden = true;
            button.events.click();
            assert.equal(dialog.hidden, false);
            assert.equal(document.getElementById('bookingDialogForm').dataset.rateId, `rate-${note}`);
        }

        for (const [note, slots] of [['expired', '2'], ['unpriced', '2'], ['predictive', '—']]) {
            const row = rowFor(note);
            assert.equal(row.children.at(-2).textContent, slots);
            assert.equal(buttonIn(row), undefined);
            assert.equal(row.children.at(-1).children.length, 0);
        }

        await showRates({ canBook: false });
        assert.equal(headerLabels().includes('Max slots'), false);
        assert.equal(headerLabels().includes('Booking'), false);
        assert.equal(walk(document.getElementById('ratesTableBody')).some(node => node.className === 'max-slots'), false);
        assert.equal(walk(document.getElementById('ratesTableBody')).some(node => node.textContent === 'Request booking'), false);

        const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
        assert.match(css, /\.booking-request-btn:disabled\s*\{[^}]*background:\s*#d9e2ec;/);
    });
});

function copyMigrations(directory, newest) {
    fs.copyFileSync(path.join(root, 'lib', 'limits.js'), path.join(directory, 'limits.js'));
    const dest = path.join(directory, newest);
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(migrations)) {
        if (/^\d{3}-.+\.js$/.test(name) && name < newest) {
            fs.copyFileSync(path.join(migrations, name), path.join(dest, name));
        }
    }
    return dest;
}

describe('r1-55 session rates field stays off the other surfaces', { concurrency: 1 }, () => {
    it('adds maxSlotsAllowed only to a customer GET /api/rates', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-r155-surface-'));
        const dbPath = path.join(directory, 'app.db');
        const script = `
            const { server } = require('./server');
            const { db } = require('./lib/db');
            const { setPasswordByUsername } = require('./lib/accounts');
            const crypto = require('node:crypto');
            const password = 'sail-the-ocean';
            if (!db.prepare('SELECT id FROM companies WHERE id = ?').get('owner-r155')) {
                db.prepare(\`
                    INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
                    VALUES ('owner-r155', 'owner-r155', 'Surface Owner', 'Contract Owner', 'contract_owner', 'owner-r155', 1)
                \`).run();
                db.prepare(\`
                    INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
                    VALUES ('customer-r155', 'customer-r155', 'Surface Customer', 'Freight Forwarder/Customer', 'freight_forwarder_customer', 'customer-r155', 0)
                \`).run();
                db.prepare(\`
                    INSERT INTO users (
                        id, username, display_name, company_id, company_reference, company_record_id,
                        admin_screen, disabled, session_epoch
                    ) VALUES
                        ('user-owner-r155', 'surface-owner-r155', 'Surface Owner', 'owner-r155', 'owner-r155', 'owner-r155', 1, 0, 0),
                        ('user-customer-r155', 'surface-customer-r155', 'Surface Customer', 'customer-r155', 'customer-r155', 'customer-r155', 0, 0, 0)
                \`).run();
                db.prepare(\`
                    INSERT INTO company_margins (
                        id, owner_company_id, customer_company_id, margin_percent, margin_number,
                        created_at, updated_at, status, authorized_at
                    ) VALUES (
                        'margin-r155', 'owner-r155', 'customer-r155', 0, 0,
                        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'active', '2026-01-01T00:00:00.000Z'
                    )
                \`).run();
                db.prepare(\`
                    INSERT INTO rates (
                        id, carrier, origin_port, destination_port, contract_owner, rate_20d, rate_40d, rate_40hc,
                        rate_effective_date, rate_expiration_date, owner_company_id
                    ) VALUES
                        ('rate-three', 'MSC', 'SHA', 'LAX', 'Surface Owner', 1000, 1800, 1900, '2026-04-01', '2027-12-01', 'owner-r155'),
                        ('rate-zero', 'MSC', 'SHA', 'NYC', 'Surface Owner', 1100, 1900, 2000, '2026-04-01', '2027-12-01', 'owner-r155')
                \`).run();
                db.prepare(\`
                    INSERT INTO oauth_clients (
                        id, display_name, secret_hash, client_type, redirect_uris, allowed_scopes, status, created_at, updated_at
                    ) VALUES (
                        'client-r155', 'Synthetic', NULL, 'public', '[]', '["rates:read"]', 'active',
                        '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'
                    )
                \`).run();
                db.prepare(\`
                    INSERT INTO oauth_grants (id, client_id, user_id, scopes, consent_version, created_at, revoked_at)
                    VALUES ('grant-r155', 'client-r155', 'user-customer-r155', 'rates:read', '1', ?, NULL)
                \`).run(Date.now());
            }
            db.prepare('UPDATE rates SET max_slots_allowed = 3 WHERE id = ?').run('rate-three');
            for (const username of ['surface-owner-r155', 'surface-customer-r155']) {
                const set = setPasswordByUsername(username, password);
                if (!set.ok) throw new Error(set.error || username);
            }
            const epoch = db.prepare('SELECT session_epoch FROM users WHERE id = ?').get('user-customer-r155').session_epoch;
            const issuedAt = Date.now();
            const payload = {
                sub: 'user-customer-r155',
                client_id: 'client-r155',
                scope: 'rates:read',
                aud: 'rn:partner-api',
                exp: issuedAt + 60 * 60 * 1000,
                iat: issuedAt,
                grant_id: 'grant-r155',
                company_record_id: 'customer-r155',
                session_epoch: epoch
            };
            const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
            const signature = crypto.createHmac('sha256', process.env.OAUTH_SIGNING_SECRET).update(body).digest('base64url');
            const token = 'rn1.' + body + '.' + signature;
            const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rates'").get().sql;
            const allowsZero = tableSql.includes('max_slots_allowed >= 0');
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const base = 'http://127.0.0.1:' + server.address().port;
                    async function login(username) {
                        const response = await fetch(base + '/api/auth/login', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ username, password })
                        });
                        const session = await response.json();
                        if (response.status !== 200) throw new Error('login ' + username + ' ' + response.status + ' ' + JSON.stringify(session));
                        const cookie = (response.headers.getSetCookie?.() || []).map(value => value.split(';')[0]).join('; ');
                        return cookie;
                    }
                    async function readJson(url, headers) {
                        const response = await fetch(base + url, { headers });
                        const text = await response.text();
                        if (response.status !== 200) throw new Error(url + ' ' + response.status + ' ' + text);
                        return JSON.parse(text);
                    }
                    const ownerCookie = await login('surface-owner-r155');
                    const customerCookie = await login('surface-customer-r155');
                    const owner = await readJson('/api/rates', { cookie: ownerCookie });
                    const customer = await readJson('/api/rates', { cookie: customerCookie });
                    const predictiveOwner = await readJson('/api/rates/predictive?after=2027-07-13', { cookie: ownerCookie });
                    const predictiveCustomer = await readJson('/api/rates/predictive?after=2027-07-13', { cookie: customerCookie });
                    const available = await readJson('/api/partner/v1/me/available-rates', { authorization: 'Bearer ' + token });
                    const mcpResponse = await fetch(base + '/mcp', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'tools/call',
                            params: { name: 'rateninja_list_available_rates', arguments: {} }
                        })
                    });
                    const mcpText = await mcpResponse.text();
                    if (mcpResponse.status !== 200) throw new Error('mcp ' + mcpResponse.status + ' ' + mcpText);
                    const mcp = JSON.parse(mcpText);
                    let zeroCustomer = null;
                    if (allowsZero) {
                        db.prepare('UPDATE rates SET max_slots_allowed = 0 WHERE id = ?').run('rate-zero');
                        zeroCustomer = await readJson('/api/rates', { cookie: customerCookie });
                    }
                    console.log('R155 ' + JSON.stringify({
                        owner, customer, predictiveOwner, predictiveCustomer, available,
                        mcp: mcp.result && mcp.result.structuredContent,
                        zeroCustomer
                    }));
                    server.close();
                    db.close();
                } catch (error) {
                    console.error(error && error.stack ? error.stack : error);
                    process.exit(1);
                }
            });
        `;
        function readSurface(migrationsDir) {
            const result = spawnSync(process.execPath, ['-e', script], {
                cwd: root,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    SQLITE_DB_PATH: dbPath,
                    MIGRATIONS_DIR: migrationsDir,
                    PARTNER_OAUTH_ENABLED: 'true',
                    SESSION_SECRET: 'test-session-secret-value-which-is-long',
                    OAUTH_SIGNING_SECRET: 'test-oauth-signing-secret-value-long'
                },
                encoding: 'utf8',
                timeout: 60000
            });
            assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
            const line = result.stdout.trim().split('\n').find(item => item.startsWith('R155 '));
            return JSON.parse(line.slice(5));
        }
        function withoutSlots(rates) {
            return rates.map(rate => {
                const copy = { ...rate };
                delete copy.maxSlotsAllowed;
                return copy;
            });
        }
        try {
            const before = readSurface(copyMigrations(directory, '018'));
            const after = readSurface(migrations);
            assert.deepEqual(after.owner, before.owner);
            assert.deepEqual(after.predictiveOwner, before.predictiveOwner);
            assert.deepEqual(after.predictiveCustomer, before.predictiveCustomer);
            assert.deepEqual(after.available, before.available);
            assert.deepEqual(after.mcp, before.mcp);
            assert.deepEqual(after.mcp, after.available);
            assert.deepEqual(after.customer, before.customer);
            const three = after.customer.rates.find(rate => rate.id === 'rate-three');
            const zero = after.customer.rates.find(rate => rate.id === 'rate-zero');
            const beforeThree = before.customer.rates.find(rate => rate.id === 'rate-three');
            assert.equal(three.maxSlotsAllowed, 3);
            assert.equal(beforeThree.maxSlotsAllowed, 3);
            assert.deepEqual(withoutSlots([three]), withoutSlots([beforeThree]));
            assert.equal(typeof zero.maxSlotsAllowed, 'number');
            assert.equal(after.zeroCustomer.rates.find(rate => rate.id === 'rate-zero').maxSlotsAllowed, 0);
            assert.equal(after.zeroCustomer.rates.find(rate => rate.id === 'rate-three').maxSlotsAllowed, 3);
            assert.equal(before.zeroCustomer, null);
            for (const rate of after.available.data) {
                assert.equal(Object.hasOwn(rate, 'maxSlotsAllowed'), false);
                assert.equal(Object.hasOwn(rate, 'max_slots_allowed'), false);
            }
            for (const rate of after.owner.rates) {
                assert.equal(Object.hasOwn(rate, 'maxSlotsAllowed'), false);
            }
            assert.equal(JSON.stringify(after.predictiveCustomer).includes('maxSlotsAllowed'), false);
            assert.equal(JSON.stringify(after.mcp).includes('maxSlotsAllowed'), false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
