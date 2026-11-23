'use strict';

const assert = require('node:assert/strict');

function walk(node) {
    return [node, ...(node.children || []).flatMap(walk)];
}

function hiddenDeep(node) {
    for (let item = node; item; item = item.parent) {
        if (item.hidden) return true;
    }
    return false;
}

function element(tag) {
    return {
        tag, children: [], textContent: '', value: '', className: '', attributes: {}, events: {},
        append(...children) {
            for (const value of children) {
                const child = typeof value === 'string' ? Object.assign(element('#text'), { textContent: value }) : value;
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
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener(name, handler) { this.events[name] = handler; },
        focus() {},
        set innerHTML(value) { throw new Error(`unexpected HTML insertion: ${value}`); },
        insertAdjacentHTML(position, value) { throw new Error(`unexpected HTML insertion: ${value}`); }
    };
}

function install(t) {
    const document = {
        createElement: element,
        createTextNode: textContent => Object.assign(element('#text'), { textContent })
    };
    const globals = {
        document,
        window: { confirm: () => true },
        location: { search: '', replace() {} }
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

async function mountSwarm(t, { permissions, respond }) {
    install(t);
    const calls = [];
    t.mock.method(global, 'fetch', async (path, init) => {
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(init.body) : undefined;
        const call = { path, method, body };
        calls.push(call);
        return respond(call);
    });
    const container = element('main');
    const { mount, unmount } = await import('../../public/js/swarm/page.js');
    await mount(container, { permissions });
    t.after(unmount);
    return { calls, container };
}

function control(root, label) {
    const field = walk(root).find(node => node.tag === 'label'
        && !hiddenDeep(node)
        && node.children.some(child => child.tag === '#text' && child.textContent === label));
    assert.ok(field, `Missing field: ${label}`);
    return field.children.find(node => node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea');
}

function controls(root, label) {
    return walk(root).filter(node => node.tag === 'label'
        && !hiddenDeep(node)
        && node.children.some(child => child.tag === '#text' && child.textContent === label))
        .map(field => field.children.find(node => node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea'));
}

function click(root, name) {
    const matches = walk(root).filter(node => node.tag === 'button' && node.textContent === name && !hiddenDeep(node));
    assert.equal(matches.length, 1, `button ${name}: ${matches.length}`);
    return matches[0].events.click();
}

function lanes(root) {
    return walk(root).filter(node => node.tag === 'fieldset'
        && String(node.className).split(' ').includes('swarm-lane')
        && !hiddenDeep(node));
}

function texts(root) {
    return walk(root).map(node => node.textContent).filter(Boolean);
}

function tags(root) {
    return walk(root).map(node => node.tag);
}

const today = '2026-11-22';
const options = {
    canRequestBooking: true,
    maxBookingSlots: 10,
    today,
    rateTypes: ['Port'],
    containerTypes: ['40HC'],
    lanes: [{ rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', windows: [{ start: today, end: '2026-12-01' }] }],
    savedQueries: []
};

function lane(overrides = {}) {
    return {
        rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: today, containerType: '40HC',
        allowAlternativeRoutes: false, allowBookingRequest: false, priceMin: null, priceMax: null, bookingSlots: null,
        acceptMaxSlots: false, priority: 'normal', dateFlexDays: 0, ...overrides
    };
}

module.exports = {
    walk, hiddenDeep, element, install, mountSwarm, control, controls, click, lanes, texts, tags,
    today, options, lane
};
