'use strict';

process.env.PARTNER_OAUTH_ENABLED = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { authorizeAndToken, mcpCall, REDIRECT_URI } = require('./helpers/r1-12');
const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    activate,
    call,
    insertCompany,
    insertMargin,
    insertRate,
    insertUser,
    login,
    utcDay
} = require('./helpers/r1-19');
const { partnerSend } = require('./helpers/r1-21');
const { applyAdminKey } = require('./helpers/r1-25');
const { search, RATE_TYPE } = require('./helpers/r1-33');
const { ADMIN_KEY, ROOT } = require('./helpers/r1-34');
const { CODE, startCloudBbs } = require('./helpers/r1-37');
const { MAX_BOOKING_SLOTS } = require('../lib/limits');

const OVER = 'This rate allows at most 5 slots per request.';
const NONE = 'This rate has no slots available.';
const RANGE = `Slots must be a whole number from 1 to ${MAX_BOOKING_SLOTS}.`;
const NOT_FOUND = JSON.stringify({ error: 'Not found.' });

describe('r1-56 per-request slot cap', { concurrency: 1 }, () => {
    let app;
    let cloud;
    let buyer;
    let token;

    before(async () => {
        cloud = await startCloudBbs();
        cloud.configureServer();
        app = await startApp();
        applyAdminKey(ADMIN_KEY);
        app.db.prepare('UPDATE users SET is_system_admin = 1 WHERE username = ?').run(app.username);
        insertCompany(app.db, { id: 'cap-owner', name: 'Cap Owner', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertCompany(app.db, { id: 'cap-buyer', name: 'Cap Buyer', type: COMPANY_TYPE_CUSTOMER });
        insertCompany(app.db, { id: 'cap-stranger', name: 'Cap Stranger', type: COMPANY_TYPE_CONTRACT_OWNER });
        insertUser(app.db, { id: 'cap-buyer-user', username: 'cap-buyer', companyId: 'cap-buyer', displayName: 'Cap Buyer' });
        activate('cap-buyer');
        insertMargin(app.db, { id: 'cap-margin', owner: 'cap-owner', customer: 'cap-buyer', percent: 0 });
        const expiration = utcDay(40);
        insertRate(app.db, { id: 'cap-max-5', owner: 'cap-owner', rate20: 1000, expiration, maxSlotsAllowed: 5 });
        insertRate(app.db, { id: 'cap-max-0', owner: 'cap-owner', rate20: 1000, expiration, maxSlotsAllowed: 0 });
        insertRate(app.db, { id: 'cap-max-null', owner: 'cap-owner', rate20: 1000, expiration, maxSlotsAllowed: null });
        insertRate(app.db, { id: 'cap-hidden', owner: 'cap-stranger', rate20: 1000, expiration, maxSlotsAllowed: 5 });
        for (const id of ['cap-max-5', 'cap-max-0', 'cap-max-null', 'cap-hidden']) {
            app.db.prepare('UPDATE rates SET rate_type = ? WHERE id = ?').run(RATE_TYPE, id);
        }
        buyer = await login(app.baseUrl, 'cap-buyer');
        const registered = await app.request('/api/admin/oauth-clients', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                displayName: 'Synthetic R1-56',
                clientType: 'confidential',
                redirectUris: [REDIRECT_URI],
                allowedScopes: ['bookings:write']
            })
        });
        const registration = await registered.json();
        assert.equal(registered.status, 201, JSON.stringify(registration));
        const oauth = await authorizeAndToken({
            baseUrl: app.baseUrl,
            cookie: buyer.cookie,
            csrf: buyer.csrf,
            clientId: registration.client.id,
            clientSecret: registration.clientSecret,
            scope: 'bookings:write'
        });
        token = oauth.access_token;
    });

    after(async () => {
        await app?.close();
        await cloud?.close();
    });

    function footprint() {
        return {
            requests: app.db.prepare('SELECT COUNT(*) AS n FROM booking_requests').get().n,
            audits: app.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            receipts: app.db.prepare('SELECT COUNT(*) AS n FROM booking_receipts').get().n
        };
    }

    function web(rateId, slots) {
        return call(app.baseUrl, buyer, 'POST', '/api/booking-requests', {
            rateId, containerSize: '20D', slots
        });
    }

    function partner(rateId, slots) {
        return partnerSend(app.baseUrl, token, 'POST', '/api/partner/v1/me/booking-requests', {
            body: { rateId, containerSize: '20D', slots, bookingCode: CODE }
        });
    }

    function mcp(rateId, slots) {
        return mcpCall(app.baseUrl, token, 'tools/call', {
            name: 'rateninja_create_booking_request',
            arguments: { rateId, containerSize: '20D', slots, bookingCode: CODE }
        });
    }

    async function queueAgent(bookingSlots) {
        const queued = await call(app.baseUrl, buyer, 'POST', '/api/managed-agents', [
            search({
                allowBookingRequest: true,
                allowAlternativeRoutes: false,
                bookingSlots,
                containerType: '20D',
                priceMin: 0,
                priceMax: 5000
            })
        ]);
        assert.equal(queued.status, 201, queued.text);
        return queued.json.agents[0];
    }

    async function adminBook(agentId) {
        const response = await app.request(`${ROOT}/${agentId}/booking-requests`, {
            method: 'POST',
            cookie: false,
            csrf: false,
            headers: { 'content-type': 'application/json', 'x-admin-api-key': ADMIN_KEY },
            body: JSON.stringify({ rateId: 'cap-max-5', bookingCode: CODE })
        });
        const text = await response.text();
        return { status: response.status, json: JSON.parse(text), text };
    }

    it('refuses 6 and accepts 5 on the web, including a second request at the max', async () => {
        const before = footprint();
        const refused = await web('cap-max-5', 6);
        assert.equal(refused.status, 400);
        assert.equal(refused.json.error, OVER);
        assert.deepEqual(footprint(), before);

        const first = await web('cap-max-5', 5);
        assert.equal(first.status, 201, first.text);
        assert.equal(first.json.request.slots, 5);
        const second = await web('cap-max-5', 5);
        assert.equal(second.status, 201, second.text);
        assert.equal(second.json.request.slots, 5);
        assert.notEqual(first.json.request.id, second.json.request.id);
        assert.equal(footprint().requests, before.requests + 2);
    });

    it('refuses 6 and accepts 5 on the partner API', async () => {
        const before = footprint();
        const refused = await partner('cap-max-5', 6);
        assert.equal(refused.status, 400);
        assert.deepEqual(refused.body, { error: 'invalid_request', error_description: OVER });
        assert.equal(JSON.stringify(refused.body).includes('maxSlotsAllowed'), false);
        assert.deepEqual(footprint(), before);

        const created = await partner('cap-max-5', 5);
        assert.equal(created.status, 201, created.text);
        assert.equal(created.body.data.slots, 5);
        assert.equal(JSON.stringify(created.body).includes('maxSlotsAllowed'), false);
        assert.equal(footprint().requests, before.requests + 1);
    });

    it('refuses 6 and accepts 5 through MCP', async () => {
        const before = footprint();
        const refused = await mcp('cap-max-5', 6);
        assert.equal(refused.status, 200);
        assert.equal(refused.body.result.isError, true);
        assert.deepEqual(refused.body.result.structuredContent, { error: 'invalid_request', error_description: OVER });
        assert.deepEqual(footprint(), before);

        const created = await mcp('cap-max-5', 5);
        assert.equal(created.status, 200, created.text);
        assert.equal(created.body.result.isError, false);
        assert.equal(created.body.result.structuredContent.data.slots, 5);
        assert.equal(JSON.stringify(created.body).includes('maxSlotsAllowed'), false);
        assert.equal(footprint().requests, before.requests + 1);
    });

    it('refuses an agent booked for 6 slots, leaves it unchanged, and accepts one booked for 5', async () => {
        const over = await queueAgent(6);
        const atMax = await queueAgent(5);
        assert.equal(over.bookingSlots, 6);
        assert.equal(over.status, 'queued');
        const before = footprint();
        const refused = await adminBook(over.id);
        assert.equal(refused.status, 400);
        assert.deepEqual(refused.json, { error: 'invalid_request', error_description: OVER });
        assert.deepEqual(footprint(), before);
        const stored = app.db.prepare('SELECT status, booking_request_id, booking_slots FROM managed_agents WHERE id = ?').get(over.id);
        assert.equal(stored.status, 'queued');
        assert.equal(stored.booking_request_id, null);
        assert.equal(stored.booking_slots, 6);

        const created = await adminBook(atMax.id);
        assert.equal(created.status, 201, created.text);
        assert.equal(created.json.booking.slots, 5);
        const linked = app.db.prepare('SELECT status, booking_request_id FROM managed_agents WHERE id = ?').get(atMax.id);
        assert.equal(linked.booking_request_id, created.json.booking.id);
        const still = app.db.prepare('SELECT status, booking_request_id FROM managed_agents WHERE id = ?').get(over.id);
        assert.equal(still.status, 'queued');
        assert.equal(still.booking_request_id, null);
    });

    it('refuses 1 slot on a zero max from the web and from MCP', async () => {
        const before = footprint();
        const webRefused = await web('cap-max-0', 1);
        assert.equal(webRefused.status, 400);
        assert.equal(webRefused.json.error, NONE);
        const mcpRefused = await mcp('cap-max-0', 1);
        assert.equal(mcpRefused.status, 200);
        assert.equal(mcpRefused.body.result.isError, true);
        assert.deepEqual(mcpRefused.body.result.structuredContent, { error: 'invalid_request', error_description: NONE });
        assert.deepEqual(footprint(), before);
    });

    it('accepts 1000 and refuses 1001 when the rate has no max', async () => {
        const before = footprint();
        const accepted = await web('cap-max-null', MAX_BOOKING_SLOTS);
        assert.equal(accepted.status, 201, accepted.text);
        assert.equal(accepted.json.request.slots, MAX_BOOKING_SLOTS);
        const refused = await web('cap-max-null', MAX_BOOKING_SLOTS + 1);
        assert.equal(refused.status, 400);
        assert.equal(refused.json.error, RANGE);
        assert.equal(footprint().requests, before.requests + 1);
    });

    it('returns the same not-found body for a hidden rate as for a missing rate', async () => {
        const before = footprint();
        const hidden = await web('cap-hidden', 99);
        const missing = await web('cap-missing', 99);
        assert.equal(hidden.status, 404);
        assert.equal(missing.status, 404);
        assert.equal(hidden.text, missing.text);
        assert.equal(hidden.text, NOT_FOUND);
        assert.deepEqual(footprint(), before);
    });

    it('clamps the dialog slot field to the rate max and leaves a null max unchanged', async t => {
        installDocument(t);
        const { openBookingDialog } = await import('../public/js/rates/booking-requests.js');
        const slots = document.getElementById('bookingDialogSlots');
        slots.value = '9';
        openBookingDialog(dialogRate(3));
        const hint = document.getElementById('bookingDialogSlotsHint');
        assert.equal(slots.max, '3');
        assert.equal(slots.getAttribute('max'), '3');
        assert.equal(slots.value, '3');
        assert.equal(hint.textContent, 'Up to 3 slots');
        assert.equal(hint.hidden, false);

        slots.value = '4';
        openBookingDialog(dialogRate(null));
        assert.equal(slots.value, '1');
        assert.equal(slots.max, '');
        assert.equal(slots.getAttribute('max'), undefined);
        assert.equal(hint.textContent, '');
        assert.equal(hint.hidden, true);
    });
});

function dialogRate(maxSlotsAllowed) {
    return {
        id: 'dialog-rate',
        carrier: 'MSC',
        originPort: 'SHA',
        destinationPort: 'LAX',
        ownerCompanyName: 'Owner',
        rate20D: 1000,
        rate40D: null,
        rate40HC: null,
        rateExpirationDate: '2026-12-31',
        maxSlotsAllowed,
        predictive: false
    };
}

function installDocument(t) {
    const nodes = [];
    function element(tag) {
        const node = {
            tag,
            children: [],
            parent: null,
            parentNode: null,
            nextSibling: null,
            textContent: '',
            value: '',
            max: '',
            hidden: false,
            disabled: false,
            className: '',
            id: '',
            attributes: {},
            dataset: {},
            events: {},
            append(...children) {
                for (const child of children) {
                    child.remove();
                    child.parent = this;
                    child.parentNode = this;
                    this.children.push(child);
                }
            },
            insertBefore(child, before) {
                child.remove();
                child.parent = this;
                child.parentNode = this;
                const index = before ? this.children.indexOf(before) : -1;
                if (index < 0) this.children.push(child);
                else this.children.splice(index, 0, child);
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
                this.parentNode = null;
            },
            setAttribute(name, value) { this.attributes[name] = String(value); },
            getAttribute(name) { return this.attributes[name]; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(name, handler) { this.events[name] = handler; },
            focus() {}
        };
        node.classList = {
            toggle(name, force) {
                const tokens = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
                const on = force === undefined ? !tokens.has(name) : Boolean(force);
                if (on) tokens.add(name);
                else tokens.delete(name);
                node.className = [...tokens].join(' ');
            }
        };
        nodes.push(node);
        return node;
    }
    const document = {
        createElement: element,
        createTextNode(value) {
            return Object.assign(element('#text'), { textContent: String(value) });
        },
        getElementById(id) {
            return nodes.find(node => node.id === id) || null;
        }
    };
    const form = element('form');
    form.id = 'bookingDialogForm';
    const label = element('label');
    const slots = element('input');
    slots.id = 'bookingDialogSlots';
    label.append(slots);
    form.append(label);
    for (const id of ['bookingDialog', 'bookingDialogClose', 'bookingDialogSummary', 'bookingDialogSize', 'bookingDialogSubmit', 'bookingDialogMessage']) {
        const node = element('div');
        node.id = id;
        if (id === 'bookingDialog') node.hidden = true;
    }
    const previous = Object.getOwnPropertyDescriptor(global, 'document');
    Object.defineProperty(global, 'document', { value: document, configurable: true });
    t.after(() => {
        if (previous) Object.defineProperty(global, 'document', previous);
        else delete global.document;
    });
}
