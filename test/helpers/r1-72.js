'use strict';

const assert = require('node:assert/strict');
const { click, element, install, options, walk } = require('./r1-63');

function byClass(root, className) {
    const item = walk(root).find(node => node.className.split(/\s+/).includes(className));
    assert.ok(item, className);
    return item;
}

async function openReview(t, swarm, laneOptions = options) {
    install(t);
    const host = element('main');
    const { openWizard } = await import('../../public/js/swarm/wizard.js');
    openWizard(host, { options: laneOptions, swarm, onDone() {} });
    for (let step = 1; step < 5; step += 1) await click(host, 'Next');
    const review = byClass(host, 'swarm-review');
    assert.equal(review.parent.hidden, false);
    return { host, review };
}

function factValues(list, terms) {
    assert.equal(list.tag, 'dl');
    assert.deepEqual(list.children.map(pair => pair.children[0]?.textContent), terms);
    return list.children.map(pair => {
        assert.equal(pair.tag, 'div');
        assert.deepEqual(pair.children.map(node => node.tag), ['dt', 'dd']);
        return pair.children[1];
    });
}

module.exports = { byClass, factValues, openReview };
