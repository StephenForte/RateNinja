'use strict';

const assert = require('node:assert/strict');
const { element, install, runRecord, walk } = require('./r1-65');
const { lane } = require('./r1-70');

function progressRun() {
    const lanes = Array.from({ length: 25 }, (_, index) => lane(index + 1, { allowBookingRequest: index < 2 }));
    const agents = Array.from({ length: 12 }, (_, index) => ({
        role: 'search', lanePosition: index + 1, attempt: 1,
        status: index < 8 ? 'completed' : index === 8 ? 'failed' : 'running',
        rateId: index < 6 ? `rate-${index + 1}` : null
    }));
    for (const position of [1, 2]) {
        agents.push({
            role: 'booking', lanePosition: position, attempt: 1, status: 'completed',
            bookingRequestId: `booking-${position}`, slots: position
        });
    }
    return runRecord({ status: 'running', finishedAt: null, summary: null, lanes, agents });
}

function nodeWithClass(host, className) {
    return walk(host).find(node => node.className.split(/\s+/).includes(className));
}

function tableRows(host) {
    return nodeWithClass(host, 'swarm-lane-table').children.find(node => node.tag === 'tbody').children;
}

function browserLikeDom(t) {
    const doc = install(t);
    const root = element('main');
    doc.activeElement = root;
    const create = doc.createElement;
    doc.createElement = tag => {
        const node = create(tag);
        let text = '';
        Object.defineProperty(node, 'textContent', {
            get() { return node.children.length ? node.children.map(child => child.textContent).join('') : text; },
            set(value) { text = value; }
        });
        let scrollLeft = 0;
        Object.defineProperty(node, 'scrollLeft', {
            get() { return scrollLeft; },
            set(value) { if (walk(root).includes(node) && node.children.length) scrollLeft = value; }
        });
        node.focus = () => {
            assert.ok(walk(root).includes(node), 'focus target is attached');
            doc.activeElement = node;
        };
        const remove = node.remove;
        node.remove = () => {
            if (walk(node).includes(doc.activeElement)) doc.activeElement = root;
            remove.call(node);
        };
        return node;
    };
    const host = doc.createElement('div');
    root.append(host);
    return { doc, root, host };
}

module.exports = { browserLikeDom, nodeWithClass, progressRun, tableRows };
