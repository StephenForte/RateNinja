'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const { it } = require('node:test');
const { byClass, mountGrid, walk } = require('./helpers/r1-36');

function button(container, text = 'Post to CloudBBS now') {
    return walk(container).find(node => node.tag === 'button' && node.textContent === text);
}

function readiness({ configured = true, disabledReason = null } = {}) {
    return {
        run: null,
        readiness: {
            queuedCount: 1,
            disabledReason: null,
            cloudBbsPost: { configured, inProgress: false, disabledReason }
        }
    };
}

it('hides the post action from non-admins', async t => {
    const page = await mountGrid(t, []);
    assert.equal(button(page), undefined);
});

it('shows the post disabled reason from the server', async t => {
    const reason = 'Set CLOUDBBS_TOKEN to post to CloudBBS.';
    const page = await mountGrid(t, [], undefined, readiness({ configured: false, disabledReason: reason }));
    assert.equal(button(page).disabled, true);
    assert.equal(walk(page).find(node => byClass(node, 'agent-post-reason')).textContent, reason);
});

it('confirms rotation, disables both actions during posting, and displays the result as text', async t => {
    const result = Promise.withResolvers();
    let requests = 0;
    const page = await mountGrid(t, [], (path, options) => {
        assert.equal(path, '/api/managed-agents/cloudbbs-post');
        assert.equal(options.method, 'POST');
        requests += 1;
        return result.promise;
    }, readiness());

    global.window.confirm = text => {
        assert.match(text, /Replace the rn announcement/);
        assert.match(text, /current booking code will stop working/);
        assert.match(text, /laptop agent run/);
        return false;
    };
    button(page).events.click();
    assert.equal(requests, 0);

    global.window.confirm = () => true;
    button(page).events.click();
    assert.equal(requests, 1);
    assert.equal(button(page, 'Posting…').disabled, true);
    assert.equal(button(page, 'Run queued agents').disabled, true);

    result.resolve(Response.json({ version: 7, updatedAt: '2026-11-20T12:00:01.000Z', byteLength: 250 }));
    await settle();
    assert.equal(button(page).disabled, false);
    assert.equal(walk(page).find(node => byClass(node, 'agent-post-result')).textContent,
        'Posted version 7 at 2026-11-20T12:00:01.000Z');
});

it('displays a rejected post as text and refreshes the disabled reason', async t => {
    const reason = 'A managed agent run is already in progress.';
    let state = readiness();
    const page = await mountGrid(t, [], () => {
        state = readiness({ disabledReason: reason });
        return Response.json({ error: '<em>Post refused</em>' }, { status: 409 });
    }, () => state);
    button(page).events.click();
    await settle();
    assert.equal(walk(page).find(node => byClass(node, 'agent-post-result')).textContent, '<em>Post refused</em>');
    assert.equal(walk(page).find(node => byClass(node, 'agent-post-reason')).textContent, reason);
    assert.equal(button(page).disabled, true);
});
