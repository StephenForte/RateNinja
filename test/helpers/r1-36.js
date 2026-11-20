'use strict';

const assert = require('node:assert/strict');

function walk(node) {
    return [node, ...Array.from(node.children ?? []).flatMap(walk)];
}

function element(tag) {
    return {
        tag, children: [], textContent: '', attributes: {}, events: {},
        append(...children) {
            for (const value of children) {
                const child = typeof value === 'string' ? { ...element('#text'), textContent: value } : value;
                child.parent?.children.splice(child.parent.children.indexOf(child), 1);
                child.parent = this;
                this.children.push(child);
            }
        },
        prepend(child) {
            this.append(child);
            this.children.unshift(this.children.pop());
        },
        replaceChildren(...children) {
            while (this.children.length) this.children[0].remove();
            this.append(...children);
        },
        remove() {
            if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
            this.parent = null;
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this.events[name] = handler; },
        querySelector(selector) { return walk(this).find(node => byClass(node, selector.slice(1))); },
        focus() {},
        set innerHTML(value) { assert.fail('unexpected HTML insertion: ' + value); },
        insertAdjacentHTML(position, value) { assert.fail('unexpected HTML insertion: ' + value); }
    };
}

function byClass(node, name) {
    return node.className?.split(' ').includes(name);
}

async function mountGrid(t, agents, onRequest = () => assert.fail('unexpected mutation'), runs = null, formOptions = {}) {
    const globals = {
        document: { createElement: element, createTextNode: value => Object.assign(element('#text'), { textContent: value }) },
        Option: function (label, value) { return Object.assign(element('option'), { textContent: label, value }); },
        window: { confirm: () => true }
    };
    for (const [name, value] of Object.entries(globals)) {
        const previous = Object.getOwnPropertyDescriptor(global, name);
        Object.defineProperty(global, name, { value, configurable: true });
        t.after(() => {
            if (previous) Object.defineProperty(global, name, previous);
            else delete global[name];
        });
    }
    t.mock.method(global, 'fetch', async (path, options) => {
        if (path.endsWith('/options')) return Response.json({
            canManageAgents: true, rateTypes: [], containerTypes: [], lanes: [], savedQueries: [], ...formOptions
        });
        if (path === '/api/managed-agents/runs/latest') {
            const payload = typeof runs === 'function' ? await runs() : runs;
            if (!payload) return Response.json({ error: 'System admin access is required.' }, { status: 403 });
            if (payload instanceof Response) return payload;
            return Response.json(payload);
        }
        if (path === '/api/managed-agents/runs' && options?.method === 'POST') return onRequest(path, options);
        if (path === '/api/managed-agents' && !options?.method) {
            const rows = typeof agents === 'function' ? await agents() : agents;
            return rows instanceof Response ? rows : Response.json({ agents: rows });
        }
        return onRequest(path, options);
    });
    const container = element('main');
    const { mount, unmount } = await import('../../public/js/agents/managed-agents.js');
    await mount(container);
    t.after(unmount);
    return container;
}

module.exports = { byClass, mountGrid, walk };
