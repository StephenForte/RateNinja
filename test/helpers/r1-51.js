'use strict';

const http = require('node:http');
const { once } = require('node:events');

function walk(node) {
    return [node, ...Array.from(node.children ?? []).flatMap(walk)];
}

function element(tag) {
    return {
        tag, children: [], textContent: '', attributes: {}, events: {}, hidden: false,
        append(...children) {
            for (const value of children) {
                const child = typeof value === 'string' ? { ...element('#text'), textContent: value } : value;
                child.parent?.children.splice(child.parent.children.indexOf(child), 1);
                child.parent = this;
                this.children.push(child);
            }
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
        set innerHTML(value) { throw new Error('unexpected HTML insertion: ' + value); },
        insertAdjacentHTML(position, value) { throw new Error('unexpected HTML insertion: ' + value); }
    };
}

async function fakeReadRpc() {
    const token = 'r151-secret-token';
    const calls = [];
    const state = { mode: 'ok', tx: null, receipt: null };
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        calls.push(body.method);
        if (state.mode === 'http') {
            response.statusCode = 500;
            response.setHeader('x-rpc-token', token);
            response.end(JSON.stringify({ error: token, url: request.url }));
            return;
        }
        if (state.mode === 'reject') {
            response.end(JSON.stringify({
                jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `down ${token}` }
            }));
            return;
        }
        const result = body.method === 'eth_getTransactionReceipt' ? state.receipt : state.tx;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/${token}`;
    function disconnect() {
        if (!server.listening) return Promise.resolve();
        const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        return done;
    }
    return { url, calls, state, token, disconnect };
}

async function mountBookingRequests(t, requests, onReceipt) {
    const globals = {
        document: {
            createElement: element,
            createTextNode: value => Object.assign(element('#text'), { textContent: value }),
            getElementById: () => null
        },
        window: {}
    };
    const restores = [];
    for (const [name, value] of Object.entries(globals)) {
        const previous = Object.getOwnPropertyDescriptor(global, name);
        Object.defineProperty(global, name, { value, configurable: true });
        restores.push(() => {
            if (previous) Object.defineProperty(global, name, previous);
            else delete global[name];
        });
    }
    t.mock.method(global, 'fetch', async (path, options) => {
        const target = String(path);
        if (target === '/api/booking-requests' && !options?.method) return Response.json({ requests });
        if (target === '/api/booking-requests/read') return Response.json({});
        if (target.endsWith('/receipt')) return onReceipt(target, options);
        throw new Error(`unexpected request ${target}`);
    });
    const container = element('main');
    const { mount, unmount } = await import('../../public/js/rates/booking-requests.js');
    await mount(container);
    t.after(() => {
        unmount();
        restores.forEach(restore => restore());
    });
    return container;
}

module.exports = { element, fakeReadRpc, mountBookingRequests, walk };
