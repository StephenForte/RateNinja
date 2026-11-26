'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { test } = require('node:test');
const { click, element, hiddenDeep, install, runRecord, walk } = require('./helpers/r1-65');
const { REPORT, LATEST } = require('./helpers/r1-66');

const API = '/api/admin/swarm-runs';
const COMPANIES = `${API}/companies`;
const LIST = `${API}?companyId=c1`;
const DETAIL = `${API}/run-1`;
const company = { companyId: 'c1', name: 'Alpha Synthetic', runCount: 2, lastStartedAt: LATEST, running: true };
const running = runRecord({
    status: 'running', finishedAt: null, agents: [{ role: 'master', attempt: 1, status: 'running', report: REPORT }]
});

function visible(container, text) {
    return walk(container).some(node => !hiddenDeep(node) && node.textContent === text);
}

function assertReadOnly(container) {
    const buttons = walk(container).filter(node => node.tag === 'button').map(node => node.textContent);
    assert.ok(!buttons.includes('Run') && !buttons.includes('Cancel'));
}

async function mountPage(t, respond, configure) {
    const document = install(t);
    configure?.(document);
    const calls = [];
    t.mock.method(global, 'fetch', (path, options) => {
        assert.equal(options.method || 'GET', 'GET');
        calls.push(path);
        return respond(path, options);
    });
    const container = element('main');
    const { mount, unmount } = await import('../public/js/admin/swarm-runs.js');
    t.after(unmount);
    await mount(container);
    return { calls, container, unmount };
}

async function tick(t, delay = 2000) {
    t.mock.timers.tick(delay);
    for (let i = 0; i < 4; i++) await settle();
}

test('the context-free Admin sections are Swarm runs, OAuth clients and Ports', async () => {
    const { sections } = await import('../public/js/registry.js');
    const { adminSectionNeedsCompany } = await import('../public/js/permissions.js');
    const admin = { systemAdmin: true, companyContext: null };
    const adminSections = sections.filter(section => section.area === 'admin');
    assert.deepEqual(adminSections.filter(section => !adminSectionNeedsCompany(admin, section))
        .map(section => section.id).sort(), ['oauth-clients', 'ports', 'swarm-runs']);
    const selected = { ...admin, companyContext: { id: 'owner-a' } };
    assert.ok(adminSections.every(section => !adminSectionNeedsCompany(selected, section)));
});

test('the empty page explains that no customer has run a swarm', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { calls, container } = await mountPage(t, path => {
        assert.equal(path, COMPANIES);
        return Response.json({ companies: [] });
    });
    assert.ok(visible(container, 'No customer has run a swarm yet.'));
    await tick(t, 6000);
    assert.deepEqual(calls, [COMPANIES]);
});

test('the admin opens a customer and sees tokens and literal reports in a read-only detail', async t => {
    const { formatWhen } = await import('../public/js/swarm/time.js');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let detailReads = 0;
    const { calls, container } = await mountPage(t, path => {
        if (path === COMPANIES) return Response.json({ companies: [company] });
        if (path === LIST) return Response.json({ runs: [running] });
        assert.equal(path, DETAIL);
        const run = ++detailReads === 1 ? running : { ...running, status: 'completed', summary: 'Finished' };
        return Response.json({ run });
    });
    for (const text of [company.name, '2', formatWhen(LATEST).text, 'Running']) assert.ok(visible(container, text), text);
    assert.ok(walk(container).some(node => node.attributes && node.attributes.title === LATEST));
    assertReadOnly(container);
    await click(container, company.name);
    assertReadOnly(container);
    await click(container, 'Open');
    assertReadOnly(container);
    for (const text of ['Input tokens', 'Output tokens', '111', '222', REPORT]) {
        assert.ok(visible(container, text), text);
    }
    assert.equal(walk(container).some(node => node.tag === 'script'), false);
    await tick(t, 1999);
    assert.deepEqual(calls, [COMPANIES, LIST, DETAIL]);
    await tick(t, 1);
    assert.ok(visible(container, 'Finished'));
    await tick(t, 6000);
    assert.deepEqual(calls, [COMPANIES, LIST, DETAIL, DETAIL]);
});

test('a slow refresh stays in flight once and does not load the queued view after unmount', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release;
    let signal;
    let reads = 0;
    const { calls, container, unmount } = await mountPage(t, (path, options) => {
        assert.equal(path, COMPANIES);
        if (++reads === 1) return Response.json({ companies: [company] });
        signal = options.signal;
        return new Promise(resolve => { release = resolve; });
    });
    await tick(t);
    await tick(t, 6000);
    assert.deepEqual(calls, [COMPANIES, COMPANIES]);
    await click(container, company.name);
    unmount();
    assert.equal(signal.aborted, true);
    release(Response.json({ companies: [company] }));
    await tick(t, 6000);
    assert.deepEqual(calls, [COMPANIES, COMPANIES]);
});

test('a completed read for the previous view does not overwrite the queued customer view', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release;
    let reads = 0;
    const { calls, container } = await mountPage(t, path => {
        if (path === LIST) return Response.json({ runs: [running] });
        assert.equal(path, COMPANIES);
        if (++reads === 1) return Response.json({ companies: [company] });
        return new Promise(resolve => { release = resolve; });
    });
    await tick(t);
    await click(container, company.name);
    assert.deepEqual(calls, [COMPANIES, COMPANIES]);
    release(Response.json({ companies: [] }));
    await tick(t, 0);
    assert.deepEqual(calls, [COMPANIES, COMPANIES, LIST]);
    assert.ok(visible(container, 'Open'));
    assert.equal(visible(container, 'No customer has run a swarm yet.'), false);
});

for (const status of [401, 403]) {
    test(`polling clears displayed data and stops after ${status}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let listReads = 0;
        const { calls, container } = await mountPage(t, path => {
            if (path === COMPANIES) return Response.json({ companies: [company] });
            assert.equal(path, LIST);
            if (++listReads === 1) return Response.json({ runs: [running] });
            return Response.json({ error: 'Access ended.' }, { status });
        });
        await click(container, company.name);
        assert.ok(visible(container, 'Open'));
        await tick(t);
        assert.ok(visible(container, 'Access ended.'));
        assert.equal(visible(container, 'Open'), false);
        await tick(t, 6000);
        assert.deepEqual(calls, [COMPANIES, LIST, LIST]);
    });
}

test('polling pauses when the shell hides a mounted section and resumes when shown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const section = { hidden: false };
    let updateVisibility;
    let disconnected = false;
    const { calls, unmount } = await mountPage(t, path => {
        assert.equal(path, COMPANIES);
        return Response.json({ companies: [company] });
    }, document => {
        document.getElementById = id => {
            assert.equal(id, 'sectionView');
            return section;
        };
        global.MutationObserver = class {
            constructor(callback) { updateVisibility = callback; }
            observe(target) { assert.equal(target, section); }
            disconnect() { disconnected = true; }
        };
        t.after(() => { delete global.MutationObserver; });
    });
    section.hidden = true;
    updateVisibility();
    await tick(t, 6000);
    assert.deepEqual(calls, [COMPANIES]);
    section.hidden = false;
    updateVisibility();
    await tick(t, 0);
    await tick(t);
    assert.deepEqual(calls, [COMPANIES, COMPANIES, COMPANIES]);
    unmount();
    assert.equal(disconnected, true);
});
