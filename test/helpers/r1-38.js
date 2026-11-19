'use strict';

const assert = require('node:assert/strict');
const { walk, byClass } = require('./r1-36');

const endpoint = '/api/managed-agents';

async function mountForm(t, { options, agents = [], onRequest = () => assert.fail('Unexpected request') }) {
    const document = {
        createElement: element,
        createTextNode: textContent => Object.assign(element('#text'), { textContent })
    };

    function element(tag) {
        return {
            tag, children: [], textContent: '', value: '', attributes: {}, events: {},
            append(...children) {
                for (const value of children) {
                    const child = typeof value === 'string' ? document.createTextNode(value) : value;
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
                this.append(...children);
            },
            remove() {
                if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
                this.parent = null;
            },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelector(selector) { return walk(this).find(node => byClass(node, selector.slice(1))); },
            focus() { document.activeElement = this; },
            get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
        };
    }

    const globals = {
        document,
        Option: function (textContent, value) { return Object.assign(element('option'), { textContent, value }); }
    };
    for (const [name, value] of Object.entries(globals)) {
        const previous = Object.getOwnPropertyDescriptor(global, name);
        Object.defineProperty(global, name, { value, configurable: true });
        t.after(() => {
            if (previous) Object.defineProperty(global, name, previous);
            else delete global[name];
        });
    }
    const calls = [];
    t.mock.method(global, 'fetch', async (path, init) => {
        if (path === endpoint + '/options') return Response.json(options);
        if (path === endpoint && !init.method) return Response.json({ agents });
        const call = { path, method: init.method || 'GET', body: init.body && JSON.parse(init.body) };
        calls.push(call);
        return onRequest(call);
    });
    const container = element('main');
    const { mount, unmount } = await import('../../public/js/agents/managed-agents.js');
    await mount(container);
    t.after(unmount);

    function button(name, root = container) {
        const result = walk(root).find(node => node.tag === 'button' && node.textContent === name);
        assert.ok(result, `Missing button: ${name}`);
        return result;
    }

    function form() {
        return walk(container).find(node => node.tag === 'form');
    }

    return {
        calls, container, button, form,
        activeElement: () => document.activeElement,
        control(label) {
            const field = walk(form()).find(node => node.tag === 'label'
                && node.children.some(child => child.tag === '#text' && child.textContent === label));
            assert.ok(field, `Missing field: ${label}`);
            return field.children.find(node => node.tag === 'input' || node.tag === 'select');
        },
        set(label, value) {
            const control = this.control(label);
            if (control.type === 'checkbox') control.checked = value;
            else control.value = value;
            control.events.change?.();
        },
        submit(name) {
            return form().events.submit({ preventDefault() {}, submitter: button(name, form()) });
        }
    };
}

module.exports = { endpoint, mountForm, walk, byClass };
