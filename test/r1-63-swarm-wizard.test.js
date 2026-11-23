'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { mountSwarm, control, click, lanes, walk, tags, hiddenDeep, options, lane } = require('./helpers/r1-63');

const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const customer = { signedIn: true, systemAdmin: false };
const admin = { signedIn: true, systemAdmin: true };

function saved(body, id = 'swarm-new') {
    return Response.json({
        swarm: { id, canEdit: true, updatedAt: '2026-11-22T02:00:00.000Z', ...body }
    });
}

function customerFetch(swarms, onWrite) {
    return call => {
        if (call.path === '/api/swarm/access' && call.method === 'GET') return Response.json({ enabled: true });
        if (call.path === '/api/swarms' && call.method === 'GET') return Response.json({ swarms });
        if (call.path === '/api/managed-agents/options' && call.method === 'GET') return Response.json(options);
        if (onWrite) return onWrite(call);
        return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
    };
}

async function openNew(container, name = 'North', instructions = 'Hold course') {
    await click(container, 'New swarm');
    control(container, 'Name').value = name;
    control(container, 'Instructions').value = instructions;
    await click(container, 'Next');
}

test('hostile swarm text is shown as text and creates no element', async t => {
    const swarm = {
        id: 'swarm-hostile', name: hostile, instructions: hostile, canEdit: true,
        totalSpendCap: null, totalSlotsCap: null, updatedAt: '2026-11-22T01:00:00.000Z', lanes: [lane()]
    };
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([swarm])
    });
    assert.equal(tags(container).includes('script'), false);
    assert.equal(tags(container).includes('img'), false);
    const cells = walk(container).filter(node => node.className === 'swarm-name' || node.className === 'swarm-instructions');
    assert.deepEqual(cells.map(node => node.textContent), [hostile, hostile]);

    await click(container, 'Edit');
    assert.equal(control(container, 'Name').value, hostile);
    assert.equal(control(container, 'Instructions').value, hostile);
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    const review = walk(container).filter(node => !hiddenDeep(node)
        && (node.className === 'swarm-name' || node.className === 'swarm-instructions'));
    assert.deepEqual(review.map(node => node.textContent), [hostile, hostile]);
    assert.equal(tags(container).includes('script'), false);
    assert.equal(tags(container).includes('img'), false);
    assert.equal(walk(container).some(node => node.tag === 'button' && node.textContent === 'Run'), false);
    assert.equal(walk(container).some(node => node.textContent === 'Running a swarm arrives with the run dashboard.'), true);
});

test('system admin, enabled customer, and everyone else see different views', async t => {
    const adminUi = await mountSwarm(t, {
        permissions: admin,
        respond: call => {
            assert.equal(call.path, '/api/admin/swarm/companies');
            return Response.json({ companies: [{ companyId: 'buyer', name: 'Synthetic Buyer', enabled: false, bbsProject: null, hasBbsToken: false, updatedAt: null }] });
        }
    });
    assert.equal(walk(adminUi.container).some(node => node.textContent === 'Premium feature. Contact Kings to enable Managed Agent Swarm.'), false);
    assert.equal(walk(adminUi.container).some(node => node.className === 'swarm-token' && node.value === ''), true);
    assert.equal(adminUi.calls.some(call => call.path === '/api/swarms'), false);

    const enabled = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([])
    });
    assert.equal(walk(enabled.container).some(node => node.tag === 'button' && node.textContent === 'New swarm'), true);
    assert.equal(walk(enabled.container).some(node => node.className === 'swarm-premium'), false);
    assert.equal(walk(enabled.container).some(node => node.type === 'password'), false);

    const locked = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            assert.equal(call.path, '/api/swarm/access');
            return Response.json({ enabled: false });
        }
    });
    assert.equal(walk(locked.container).some(node => node.textContent === 'Premium feature. Contact Kings to enable Managed Agent Swarm.'), true);
    assert.equal(walk(locked.container).some(node => node.tag === 'form'), false);
    assert.equal(walk(locked.container).some(node => node.tag === 'button' && node.textContent === 'New swarm'), false);
    assert.equal(walk(locked.container).some(node => node.tag === 'textarea'), false);
    assert.deepEqual(locked.calls.map(call => call.path), ['/api/swarm/access']);
});

test('token field stays empty and omits, keeps, or clears the credential', async t => {
    const secret = 'super-secret-token';
    let savedBody;
    const { container, calls } = await mountSwarm(t, {
        permissions: admin,
        respond: call => {
            if (call.method === 'GET') {
                return Response.json({
                    companies: [{
                        companyId: 'buyer',
                        name: hostile,
                        enabled: true,
                        bbsProject: 'buyer.project',
                        hasBbsToken: true,
                        updatedAt: '2026-11-22T01:00:00.000Z',
                        bbsToken: secret
                    }]
                });
            }
            savedBody = call.body;
            if (call.body.enabled === true && call.body.bbsProject === 'missing project') {
                return Response.json({ error: 'Provide bbsProject as a project name or null.', code: 'bad_project' }, { status: 400 });
            }
            return Response.json({
                company: {
                    companyId: 'buyer',
                    name: hostile,
                    enabled: call.body.enabled,
                    bbsProject: call.body.bbsProject,
                    hasBbsToken: call.body.bbsToken !== null,
                    updatedAt: '2026-11-22T03:00:00.000Z',
                    bbsToken: secret
                }
            });
        }
    });
    const token = walk(container).find(node => node.className === 'swarm-token');
    assert.equal(token.type, 'password');
    assert.equal(token.value, '');
    assert.equal(walk(container).some(node => node.textContent === 'Token set'), true);
    assert.equal(walk(container).some(node => node.textContent === secret || node.value === secret), false);
    assert.equal(walk(container).find(node => node.className === 'swarm-company-name').textContent, hostile);
    assert.equal(tags(container).includes('script'), false);

    const form = walk(container).find(node => node.tag === 'form');
    await form.events.submit({ preventDefault() {} });
    assert.equal(Object.hasOwn(savedBody, 'bbsToken'), false);
    assert.equal(savedBody.enabled, true);
    assert.equal(savedBody.bbsProject, 'buyer.project');
    assert.equal(token.value, '');
    assert.equal(walk(container).some(node => node.textContent === secret || node.value === secret), false);

    await click(container, 'Clear token');
    await form.events.submit({ preventDefault() {} });
    assert.equal(savedBody.bbsToken, null);
    assert.equal(token.value, '');
    assert.equal(walk(container).some(node => node.textContent === 'No token'), true);

    control(container, 'CloudBBS project').value = 'missing project';
    await form.events.submit({ preventDefault() {} });
    assert.equal(walk(container).some(node => node.textContent === 'Provide bbsProject as a project name or null.'), true);
    assert.equal(calls.filter(call => call.method === 'PUT').at(-1).body.bbsProject, 'missing project');
});

test('25 lanes are the maximum, apply changes only the selected lanes, and values survive navigation', async t => {
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([])
    });
    await openNew(container);
    await click(container, 'Next');
    for (let count = 0; count < 25; count += 1) await click(container, 'Add lane');
    assert.equal(lanes(container).length, 25);
    const add = walk(container).find(node => node.tag === 'button' && node.textContent === 'Add lane');
    assert.equal(add.disabled, true);
    await click(container, 'Add lane');
    assert.equal(lanes(container).length, 25);

    const fresh = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([])
    });
    await openNew(fresh.container, 'Kept');
    control(fresh.container, 'Total spend cap (USD)').value = '50';
    control(fresh.container, 'Total slots cap').value = '6';
    await click(fresh.container, 'Next');
    await click(fresh.container, 'Back');
    assert.equal(control(fresh.container, 'Total spend cap (USD)').value, '50');
    assert.equal(control(fresh.container, 'Total slots cap').value, '6');
    await click(fresh.container, 'Back');
    assert.equal(control(fresh.container, 'Name').value, 'Kept');
    assert.equal(control(fresh.container, 'Instructions').value, 'Hold course');
    await click(fresh.container, 'Next');
    await click(fresh.container, 'Next');
    await click(fresh.container, 'Add lane');
    await click(fresh.container, 'Add lane');
    await click(fresh.container, 'Add lane');
    await click(fresh.container, 'Next');
    const template = walk(fresh.container).find(node => String(node.className).includes('swarm-policy-template'));
    control(template, 'Priority').value = 'high';
    control(template, 'Date flex (days)').value = '4';
    control(template, 'Allow alternatives').checked = true;
    const rows = lanes(fresh.container);
    control(rows[1], 'Priority').value = 'low';
    for (const index of [0, 2]) {
        walk(rows[index]).find(node => String(node.className).split(' ').includes('swarm-select')).checked = true;
    }
    await click(fresh.container, 'Apply to selected');
    assert.equal(control(rows[0], 'Priority').value, 'high');
    assert.equal(control(rows[1], 'Priority').value, 'low');
    assert.equal(control(rows[2], 'Priority').value, 'high');
    assert.equal(control(rows[0], 'Date flex (days)').value, '4');
    assert.equal(control(rows[1], 'Date flex (days)').value, '0');
    assert.equal(control(rows[0], 'Allow alternatives').checked, true);
    assert.equal(control(rows[1], 'Allow alternatives').checked, false);
    await click(fresh.container, 'Next');
    await click(fresh.container, 'Back');
    assert.equal(control(lanes(fresh.container)[1], 'Priority').value, 'low');
    await click(fresh.container, 'Back');
    await click(fresh.container, 'Next');
    assert.equal(control(lanes(fresh.container)[0], 'Priority').value, 'high');
    assert.equal(control(lanes(fresh.container)[1], 'Priority').value, 'low');
    assert.equal(control(lanes(fresh.container)[1], 'Date flex (days)').value, '0');
});

test('booking lanes block Save until both caps are valid, and no booking sends null caps', async t => {
    const posts = [];
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([], call => {
            posts.push(call);
            return saved(call.body);
        })
    });
    await openNew(container, 'Booked');
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Next');
    const row = lanes(container)[0];
    const booking = control(row, 'Allow booking');
    booking.checked = true;
    booking.events.change();
    control(row, 'Min price (USD)').value = '1';
    control(row, 'Max price (USD)').value = '2';
    control(row, 'Slots').value = '1';
    control(row, 'Use AI for slot selection').checked = true;
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(posts.length, 0);
    assert.equal(walk(container).some(node => node.textContent === 'Enter a total spend cap greater than 0 when a lane allows booking.'), true);
    assert.equal(walk(container).find(node => String(node.className).split(' ').includes('swarm-step-2')).hidden, false);

    control(container, 'Total spend cap (USD)').value = '12';
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(posts.length, 0);
    assert.equal(walk(container).some(node => node.textContent === 'Enter a total slots cap from 1 to 10000 when a lane allows booking.'), true);

    control(container, 'Total slots cap').value = '4';
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.totalSpendCap, 12);
    assert.equal(posts[0].body.totalSlotsCap, 4);
    assert.equal(posts[0].body.lanes[0].allowBookingRequest, true);
    assert.equal(posts[0].body.lanes[0].acceptMaxSlots, true);

    await click(container, 'New swarm');
    control(container, 'Name').value = 'Open';
    await click(container, 'Next');
    control(container, 'Total spend cap (USD)').value = '99';
    control(container, 'Total slots cap').value = '8';
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(posts[1].body.totalSpendCap, null);
    assert.equal(posts[1].body.totalSlotsCap, null);
    assert.equal(posts[1].body.lanes[0].allowBookingRequest, false);
});

test('POST and PUT bodies match the API shape and the shown lane order', async t => {
    const writes = [];
    const existing = {
        id: 'swarm-edit', name: 'Old name', instructions: 'Old text', canEdit: true,
        totalSpendCap: 40, totalSlotsCap: 3, updatedAt: '2026-11-22T01:00:00.000Z',
        lanes: [
            lane({ allowBookingRequest: true, priceMin: 1, priceMax: 2, bookingSlots: 1 }),
            lane({ sailingDate: '2026-11-23', priority: 'low' })
        ]
    };
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([existing], call => {
            writes.push(call);
            return saved(call.body, call.method === 'POST' ? 'swarm-created' : existing.id);
        })
    });
    await openNew(container, 'Created', 'Created text');
    control(container, 'Total spend cap (USD)').value = '80';
    control(container, 'Total slots cap').value = '9';
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Add lane');
    let rows = lanes(container);
    control(rows[1], 'Sailing date').value = '2026-11-30';
    await click(rows[1], 'Up');
    rows = lanes(container);
    assert.equal(control(rows[0], 'Sailing date').value, '2026-11-30');
    await click(container, 'Next');
    rows = lanes(container);
    control(rows[0], 'Priority').value = 'high';
    control(rows[0], 'Allow alternatives').checked = true;
    control(rows[0], 'Date flex (days)').value = '2';
    const booking = control(rows[0], 'Allow booking');
    booking.checked = true;
    booking.events.change();
    control(rows[0], 'Min price (USD)').value = '10';
    control(rows[0], 'Max price (USD)').value = '20.5';
    control(rows[0], 'Slots').value = '3';
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].path, '/api/swarms');
    assert.deepEqual(writes[0].body, {
        name: 'Created',
        instructions: 'Created text',
        totalSpendCap: 80,
        totalSlotsCap: 9,
        lanes: [
            {
                rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-30', containerType: '40HC',
                allowAlternativeRoutes: true, allowBookingRequest: true, priceMin: 10, priceMax: 20.5, bookingSlots: 3,
                acceptMaxSlots: false, priority: 'high', dateFlexDays: 2
            },
            {
                rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-22', containerType: '40HC',
                allowAlternativeRoutes: false, allowBookingRequest: false, priceMin: null, priceMax: null, bookingSlots: null,
                acceptMaxSlots: false, priority: 'normal', dateFlexDays: 0
            }
        ]
    });
    assert.equal(walk(container).some(node => node.textContent === 'Created'), true);

    const oldRow = walk(container).find(node => node.tag === 'tr' && walk(node).some(child => child.textContent === 'Old name'));
    await click(oldRow, 'Edit');
    control(container, 'Name').value = 'Renamed';
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Next');
    rows = lanes(container);
    const second = control(rows[1], 'Priority');
    second.value = 'high';
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(writes[1].method, 'PUT');
    assert.equal(writes[1].path, '/api/swarms/swarm-edit');
    assert.equal(writes[1].body.name, 'Renamed');
    assert.equal(writes[1].body.instructions, 'Old text');
    assert.deepEqual(writes[1].body.lanes.map(item => item.sailingDate), ['2026-11-22', '2026-11-23']);
    assert.deepEqual(writes[1].body.lanes.map(item => item.priority), ['normal', 'high']);
    assert.equal(writes[1].body.totalSpendCap, 40);
    assert.equal(writes[1].body.totalSlotsCap, 3);
});

test('a 400 with position marks that lane and shows the server message as text', async t => {
    const message = 'Select a visible lane for this rate type. <script>alert(1)</script>';
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([], () => Response.json({ error: message, position: 3 }, { status: 400 }))
    });
    await openNew(container, 'Marked');
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Add lane');
    await click(container, 'Add lane');
    await click(container, 'Next');
    await click(container, 'Next');
    await click(container, 'Save');
    const row = lanes(container).find(node => node.attributes['data-position'] === '3');
    assert.equal(String(row.className).includes('swarm-lane-marked'), true);
    assert.equal(walk(row).some(node => node.textContent === message), true);
    assert.equal(tags(container).includes('script'), false);
    assert.equal(walk(container).find(node => String(node.className).split(' ').includes('swarm-step-3')).hidden, false);
});

test('a file over 20000 characters is refused and the text area is unchanged', async t => {
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([])
    });
    await click(container, 'New swarm');
    const area = control(container, 'Instructions');
    area.value = 'keep me';
    const upload = control(container, 'Upload .md');
    upload.files = [new File(['x'.repeat(20001)], 'notes.md', { type: 'text/markdown' })];
    await upload.events.change();
    assert.equal(area.value, 'keep me');
    assert.equal(walk(container).some(node => node.textContent === 'Enter instructions as text of at most 20000 characters.'), true);

    upload.files = [new File(['# Short'], 'notes.txt', { type: 'text/plain' })];
    await upload.events.change();
    assert.equal(area.value, '# Short');
    assert.equal(walk(container).some(node => node.textContent === '7 / 20000'), true);
});

test('booking controls stay disabled when the company cannot request bookings', async t => {
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: call => {
            if (call.path === '/api/managed-agents/options') {
                return Response.json({ ...options, canRequestBooking: false });
            }
            return customerFetch([])(call);
        }
    });
    await openNew(container, 'No book');
    await click(container, 'Next');
    await click(container, 'Add lane');
    await click(container, 'Next');
    const booking = control(lanes(container)[0], 'Allow booking');
    assert.equal(booking.disabled, true);
    assert.equal(booking.checked, false);
    assert.equal(walk(container).some(node => node.textContent === 'Your company cannot request bookings.'), true);
});

test('delete asks for the swarm name and edit is hidden without canEdit', async t => {
    const kept = { id: 'kept', name: 'Kept swarm', instructions: '', canEdit: false, totalSpendCap: null, totalSlotsCap: null, updatedAt: '2026-11-22T01:00:00.000Z', lanes: [lane()] };
    const doomed = { id: 'doomed', name: `Delete ${hostile}`, instructions: '', canEdit: true, totalSpendCap: null, totalSlotsCap: null, updatedAt: '2026-11-22T01:00:00.000Z', lanes: [lane()] };
    let asked = '';
    const { container } = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch([kept, doomed], call => {
            assert.equal(call.method, 'DELETE');
            assert.equal(call.path, '/api/swarms/doomed');
            return new Response(null, { status: 204 });
        })
    });
    global.window.confirm = message => {
        asked = message;
        return true;
    };
    assert.equal(walk(container).filter(node => node.tag === 'button' && node.textContent === 'Edit').length, 1);
    assert.equal(walk(container).filter(node => node.tag === 'button' && node.textContent === 'Delete').length, 1);
    await click(container, 'Delete');
    assert.equal(asked, `Delete the swarm Delete ${hostile}?`);
    assert.equal(tags(container).includes('script'), false);
    assert.equal(walk(container).some(node => node.textContent === doomed.name), false);
    assert.equal(walk(container).some(node => node.textContent === 'Kept swarm'), true);
});

test('swarm UI files do not build HTML from strings or store a token', () => {
    const directory = path.join(__dirname, '../public/js/swarm');
    const pattern = /innerHTML|insertAdjacentHTML|outerHTML|document\.write|localStorage|sessionStorage|console\./;
    for (const name of fs.readdirSync(directory)) {
        const text = fs.readFileSync(path.join(directory, name), 'utf8');
        assert.equal(pattern.test(text), false, name);
    }
});
