'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { click, control, lanes, options, today } = require('./helpers/r1-63');
const { csvText, file, laneRow, openLanes, panel, savedLane, upload } = require('./helpers/r1-69');
const { addLaneButtons, byClass, clickToolbarAdd } = require('./helpers/r1-71');

const limitMessage = 'A swarm can have at most 25 lanes.';

async function toLanes(t, optionsOverride) {
    const mounted = await openLanes(t, { optionsOverride });
    await click(mounted.container, 'Next');
    return mounted;
}

async function toPolicy(t) {
    const { container, posts } = await toLanes(t);
    await clickToolbarAdd(container);
    await clickToolbarAdd(container);
    await click(container, 'Next');
    return { container, posts };
}

test('the lane toolbar count tracks both Add lane buttons, removal and CSV replacement', async t => {
    const { container } = await toLanes(t);
    const step = panel(container, 3);
    const toolbar = byClass(step, 'swarm-lane-toolbar');
    const count = byClass(toolbar, 'swarm-lane-count');
    const topHint = byClass(toolbar, 'swarm-lane-limit');
    const [top, bottom] = addLaneButtons(step);
    assert.equal(top.parent, toolbar);
    assert.equal(bottom.parent, step);
    assert.equal(step.children.at(-2), bottom);
    const bottomHint = step.children.at(-1);
    assert.equal(count.textContent, '0 of 25 lanes');
    await clickToolbarAdd(container);
    assert.equal(count.textContent, '1 of 25 lanes');
    await bottom.events.click();
    assert.equal(count.textContent, '2 of 25 lanes');
    await click(lanes(step)[0], 'Remove');
    assert.equal(count.textContent, '1 of 25 lanes');

    const csv = csvText(Array.from({ length: 25 }, () => laneRow()));
    await upload(container, file('lanes.csv', csv));
    assert.equal(panel(container, 4).hidden, false);
    assert.equal(count.textContent, '25 of 25 lanes');
    assert.equal(top.disabled, true);
    assert.equal(bottom.disabled, true);
    assert.equal(topHint.textContent, limitMessage);
    assert.equal(bottomHint.textContent, limitMessage);
    await click(container, 'Back');
    await click(lanes(step)[24], 'Remove');
    assert.equal(count.textContent, '24 of 25 lanes');
    assert.equal(top.disabled, false);
    assert.equal(bottom.disabled, false);
    assert.equal(topHint.textContent, '');
    assert.equal(bottomHint.textContent, '');
});

test('new lanes inherit live controls and initialize their own destination and date', async t => {
    const alternateWindow = { start: '2026-12-05', end: '2026-12-08' };
    const { container } = await toLanes(t, {
        ...options,
        rateTypes: ['Port', 'Inland'],
        containerTypes: ['40HC', '20D'],
        lanes: [
            ...options.lanes,
            { rateType: 'Inland', originPort: 'HKG', destinationPort: 'SEA', windows: [options.lanes[0].windows[0], alternateWindow] },
            { rateType: 'Inland', originPort: 'NGB', destinationPort: 'NYC', windows: [alternateWindow] }
        ]
    });
    await clickToolbarAdd(container);
    const [first] = lanes(container);
    for (const label of ['Rate type', 'Origin port', 'Destination port', 'Sailing date', 'Container type']) {
        assert.equal(control(first, label).value, '');
    }
    const rate = control(first, 'Rate type');
    rate.value = 'Inland';
    rate.events.change();
    const origin = control(first, 'Origin port');
    origin.value = 'HKG';
    origin.events.change();
    control(first, 'Container type').value = '20D';
    control(first, 'Sailing date').value = alternateWindow.start;

    await clickToolbarAdd(container);
    const second = lanes(container)[1];
    assert.equal(control(second, 'Rate type').value, 'Inland');
    assert.equal(control(second, 'Origin port').value, 'HKG');
    assert.equal(control(second, 'Destination port').value, 'SEA');
    assert.equal(control(second, 'Sailing date').value, today);
    assert.equal(control(second, 'Container type').value, '20D');

    rate.value = 'Port';
    rate.events.change();
    control(first, 'Container type').value = '40HC';
    assert.equal(control(second, 'Rate type').value, 'Inland');
    assert.equal(control(second, 'Origin port').value, 'HKG');
    assert.equal(control(second, 'Container type').value, '20D');
});

test('the selection count tracks a single selection, Select all and clearing', async t => {
    const { container } = await toPolicy(t);
    const toolbar = byClass(container, 'swarm-policy-toolbar');
    const count = byClass(toolbar, 'swarm-selected-count');
    const all = control(toolbar, 'Select all');
    const selections = lanes(container).map(row => control(row, 'Select'));
    assert.equal(count.textContent, '0 selected');
    selections[0].checked = true;
    selections[0].events.change();
    assert.equal(count.textContent, '1 selected');
    assert.equal(all.indeterminate, true);
    all.checked = true;
    all.events.change();
    assert.equal(count.textContent, '2 selected');
    assert.deepEqual(selections.map(item => item.checked), [true, true]);
    all.checked = false;
    all.events.change();
    assert.equal(count.textContent, '0 selected');
    assert.deepEqual(selections.map(item => item.checked), [false, false]);
});

test('the toolbars and each lane expose their layout classes with direct label controls', async t => {
    const { container } = await toLanes(t);
    const laneToolbar = byClass(panel(container, 3), 'swarm-lane-toolbar');
    assert.equal(control(laneToolbar, 'Upload CSV').parent.children[0].textContent, 'Upload CSV');
    await clickToolbarAdd(container);
    await clickToolbarAdd(container);
    for (const row of lanes(container)) {
        const layout = byClass(row, 'swarm-lane-layout');
        const fields = byClass(layout, 'swarm-lane-fields');
        assert.ok(byClass(layout, 'swarm-lane-actions'));
        assert.equal(fields.children.length, 5);
        assert.equal(byClass(fields, 'swarm-date-hint').parent, control(fields, 'Sailing date').parent);
    }
    await click(container, 'Next');
    const policyToolbar = byClass(panel(container, 4), 'swarm-policy-toolbar');
    assert.equal(byClass(policyToolbar, 'swarm-policy-template').parent, policyToolbar);
    assert.equal(control(byClass(policyToolbar, 'swarm-policy-actions'), 'Select all').type, 'checkbox');
    for (const row of lanes(container)) {
        const layout = byClass(row, 'swarm-policy-layout');
        const heading = byClass(layout, 'swarm-policy-heading');
        assert.equal(control(heading, 'Select').type, 'checkbox');
        assert.equal(byClass(heading, 'swarm-lane-identity').parent, heading);
        const fields = byClass(layout, 'swarm-policy-fields');
        assert.equal(fields.children.length, 8);
        assert.equal(control(fields, 'Slots').disabled, true);
    }
});

test('the toolbar applies policy only to selected lanes and Save keeps the established body', async t => {
    const { container, posts } = await toPolicy(t);
    const rows = lanes(container);
    const selected = control(rows[1], 'Select');
    selected.checked = true;
    selected.events.change();
    const toolbar = byClass(container, 'swarm-policy-toolbar');
    control(toolbar, 'Priority').value = 'high';
    control(toolbar, 'Date flex (days)').value = '4';
    control(toolbar, 'Allow alternatives').checked = true;
    await click(toolbar, 'Apply to selected');
    assert.deepEqual(rows.map(row => control(row, 'Priority').value), ['normal', 'high']);
    assert.deepEqual(rows.map(row => control(row, 'Date flex (days)').value), ['0', '4']);
    await click(container, 'Next');
    await click(container, 'Save');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
        name: 'North',
        instructions: 'Hold course',
        totalSpendCap: null,
        totalSlotsCap: null,
        lanes: [savedLane, { ...savedLane, priority: 'high', dateFlexDays: 4, allowAlternativeRoutes: true }]
    });
});
