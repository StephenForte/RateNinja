'use strict';

const assert = require('node:assert/strict');
const { click, walk } = require('./r1-63');

function byClass(root, name) {
    const match = walk(root).find(node => node.className.split(' ').includes(name));
    assert.ok(match, `Missing .${name}`);
    return match;
}

function addLaneButtons(root) {
    return walk(root).filter(node => node.tag === 'button' && node.textContent === 'Add lane');
}

function clickToolbarAdd(root) {
    return click(byClass(root, 'swarm-lane-toolbar'), 'Add lane');
}

module.exports = { byClass, addLaneButtons, clickToolbarAdd };
