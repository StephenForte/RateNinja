'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mountGrid, walk } = require('./helpers/r1-36');

function button(container) {
    return walk(container).find(node => node.tag === 'button' && node.textContent === 'Run queued agents');
}

function readiness(overrides) {
    return {
        run: null,
        readiness: {
            queuedCount: 2,
            missingSettings: [],
            windowClosed: false,
            nextPostAt: '2026-11-21T00:17:00.000Z',
            runInProgress: false,
            disabledReason: null,
            ...overrides
        }
    };
}

describe('r1-45 run button', () => {
    it('shows nothing new to someone who is not a system admin', async t => {
        const container = await mountGrid(t, []);
        assert.equal(button(container), undefined);
        assert.equal(walk(container).some(node => node.className === 'agent-run'), false);
    });

    it('disables the button with the readiness reason', async t => {
        const payload = readiness({
            queuedCount: 0,
            missingSettings: ['ANTHROPIC_API_KEY'],
            disabledReason: 'Set ANTHROPIC_API_KEY to run managed agents.'
        });
        const container = await mountGrid(t, [], undefined, payload);
        const control = button(container);
        assert.equal(control.disabled, true);
        const reason = walk(container).find(node => node.className === 'agent-run-reason');
        assert.equal(reason.textContent, payload.readiness.disabledReason);
    });

    it('confirms the queued count and the next post time', async t => {
        const container = await mountGrid(t, [], () => Response.json({ run: { status: 'running' } }), readiness());
        const control = button(container);
        assert.equal(control.disabled, false);
        let message = '';
        global.window.confirm = text => {
            message = text;
            return false;
        };
        control.events.click();
        assert.match(message, /2 queued agents/);
        assert.match(message, /2026-11-21 00:17 UTC/);
        assert.match(message, /Claude/);
    });

    it('shows the latest run with text content', async t => {
        const payload = readiness();
        payload.run = {
            id: 'run-1',
            status: 'succeeded',
            startedBy: 'Synthetic Admin',
            startedAt: '2026-11-20T12:00:00.000Z',
            finishedAt: '2026-11-20T12:05:00.000Z',
            exitCode: 0,
            startedAgentIds: ['a', 'b'],
            summary: '2 queued, 0 already running.'
        };
        const container = await mountGrid(t, [], undefined, payload);
        const status = walk(container).find(node => node.className === 'agent-run-status');
        const summary = walk(container).find(node => node.className === 'agent-run-summary');
        assert.equal(status.textContent, 'Status: succeeded');
        assert.equal(summary.textContent, payload.run.summary);
        assert.match(walk(container).find(node => node.className === 'agent-run-who').textContent, /Synthetic Admin/);
        assert.match(walk(container).find(node => node.className === 'agent-run-counts').textContent, /2 started/);
    });
});
