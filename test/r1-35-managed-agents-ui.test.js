'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { PAYLOAD } = require('./helpers/r1-35');

it('renders a completed summary as text, links to booking requests, and omits both for a queued agent', async t => {
    const created = '2026-11-18T21:30:00.000Z';
    const shared = { createdAt: created, originPort: 'SHA', destinationPort: 'LAX' };
    const agents = [
        { ...shared, status: 'completed', finishedAt: created, resultSummary: PAYLOAD, bookingRequestId: 'synthetic-booking' },
        { ...shared, status: 'queued', finishedAt: null, resultSummary: null, bookingRequestId: null }
    ];
    function element(tag) {
        return {
            tag, children: [], textContent: '',
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; },
            setAttribute() {},
            addEventListener() {},
            set innerHTML(value) { assert.fail('unexpected HTML insertion: ' + value); }
        };
    }
    t.mock.method(global, 'fetch', async path => Response.json(
        path.endsWith('/options') ? { canManageAgents: true } : { agents }));
    const originalDocument = global.document;
    global.document = { createElement: element };
    t.after(() => {
        if (originalDocument === undefined) delete global.document;
        else global.document = originalDocument;
    });

    const container = element('main');
    const { mount, unmount } = await import('../public/js/agents/managed-agents.js');
    await mount(container);
    t.after(() => unmount());
    const list = container.children.find(node => node.className === 'agent-list');
    const [completed, queued] = list.children;
    const walk = node => [node, ...node.children.flatMap(walk)];
    const done = walk(completed);
    assert.equal(done.find(node => node.className === 'agent-result-summary').textContent, PAYLOAD);
    assert.equal(done.some(node => node.tag === 'img'), false);
    assert.ok(done.some(node => node.textContent === 'Finished'));
    assert.equal(done.find(node => node.tag === 'a').href, '/profile/booking-requests');
    assert.ok(walk(queued).every(node => node.tag !== 'a' && node.textContent !== 'Finished'
        && node.className !== 'agent-result-summary'));
});
