'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { endpoint, mountForm, walk, byClass } = require('./helpers/r1-38');

const queryField = 'Start from a saved query (optional)';
const bookingField = 'Allow AI Agent to request a booking';
const alternativesField = 'Allow AI Agent to search for alternative routes';
const minField = 'Min price (USD per container)';
const maxField = 'Max price (USD per container)';
const anotherButton = 'Queue and add another';
const today = '2026-11-19';
const later = '2026-11-23';
const sharedWindow = [{ start: '2026-11-17', end: '2026-11-22' }];
const portLane = { rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', windows: sharedWindow };
const inlandLane = { rateType: 'Inland', originPort: 'SHA', destinationPort: 'CHI', windows: [{ start: later, end: '2026-12-05' }] };
const expiredLane = { ...portLane, destinationPort: 'NYC', windows: [{ start: '2026-11-13', end: '2026-11-18' }] };
const options = {
    canManageAgents: true, canRequestBooking: true, maxBookingSlots: 10, today,
    rateTypes: ['Port', 'Inland'], containerTypes: ['40HC', '20D'],
    lanes: [portLane, inlandLane, expiredLane],
    savedQueries: [
        { id: 'chi', name: 'Synthetic Inland', originPort: 'SHA', destinationPort: 'CHI' },
        { id: 'unavailable', name: 'Unavailable port', originPort: 'SHA', destinationPort: 'MIA' }
    ]
};
const booking = {
    containerType: '20D', allowAlternativeRoutes: true, allowBookingRequest: true,
    priceMin: 0, priceMax: 1350.75, bookingSlots: 3
};
const requested = {
    rateType: 'Inland', originPort: 'SHA', destinationPort: 'CHI', sailingDate: later, savedQueryId: 'chi', ...booking
};

function record(fields, id = 'agent-new') {
    return {
        ...fields, id, creatorName: 'Synthetic Creator', status: 'queued', canEdit: true,
        createdAt: '2026-11-19T00:00:00Z'
    };
}

function open(ui) {
    ui.button('New agent').events.click();
}

function configureBooking(ui) {
    ui.set('Container type', '20D');
    ui.set(alternativesField, true);
    ui.set(bookingField, true);
    ui.set(minField, '0');
    ui.set(maxField, '1350.75');
    ui.set('Slots', '3');
}

function actionLabels(ui) {
    return walk(ui.form()).filter(node => node.tag === 'button').map(node => node.textContent);
}

function values(ui) {
    return walk(ui.form())
        .filter(node => node.tag === 'input' || node.tag === 'select')
        .map(node => node.type === 'checkbox' ? node.checked : node.value);
}

test('one editor puts saved queries first and Queue agent posts one item then closes', async t => {
    const ui = await mountForm(t, {
        options,
        onRequest: ({ body }) => Response.json({ agents: [record(body[0])] })
    });
    open(ui);
    const nodes = walk(ui.form());
    assert.equal(nodes.filter(node => node.tag === 'fieldset').length, 1);
    assert.deepEqual(nodes.filter(node => node.tag === 'legend').map(node => node.textContent), ['Search and settings']);
    assert.deepEqual(actionLabels(ui), ['Queue agent', anotherButton, 'Cancel']);
    assert.equal(ui.form().querySelector('.agent-confirmation').textContent, '');
    assert.deepEqual(nodes.filter(node => node.tag === 'label').map(label =>
        label.children.find(node => node.tag === '#text').textContent), [
        queryField, 'Rate type', 'Origin port', 'Destination port', 'Sailing date', 'Container type',
        alternativesField, bookingField, 'Use AI for slot selection', minField, maxField, 'Slots'
    ]);
    assert.equal(ui.activeElement(), ui.control(queryField));
    ui.set(queryField, 'chi');
    configureBooking(ui);
    await ui.submit('Queue agent');
    assert.deepEqual(ui.calls, [{ path: endpoint, method: 'POST', body: [requested] }]);
    assert.equal(ui.form(), undefined);
    assert.equal(ui.activeElement(), ui.button('New agent'));
});

test('Queue and add another clears the search, retains settings and updates the grid and count', async t => {
    let nextId = 0;
    const ui = await mountForm(t, {
        options,
        onRequest: ({ body }) => Response.json({ agents: [record(body[0], String(++nextId))] })
    });
    open(ui);
    const form = ui.form();
    ui.set(queryField, 'chi');
    configureBooking(ui);
    const slotSelection = 'Use AI for slot selection';
    ui.set(slotSelection, true);
    await ui.submit(anotherButton);
    assert.equal(ui.form(), form);
    assert.equal(ui.activeElement(), ui.control(queryField));
    assert.deepEqual(values(ui), ['', '', '', '', '', '20D', true, true, true, '0', '1350.75', '3']);
    assert.equal(ui.control(slotSelection).checked, true);
    assert.equal(form.querySelector('.agent-confirmation').textContent, 'Queued SHA → CHI (1 queued this session)');

    ui.set('Rate type', 'Port');
    ui.set('Destination port', 'LAX');
    await ui.submit(anotherButton);
    assert.deepEqual(ui.calls.map(call => call.body[0].acceptMaxSlots), [true, true]);
    assert.deepEqual(ui.calls.map(call => call.body.map(({ acceptMaxSlots, ...settings }) => settings)), [
        [requested],
        [{ ...requested, rateType: 'Port', destinationPort: 'LAX', sailingDate: today, savedQueryId: null }]
    ]);
    assert.deepEqual(values(ui), ['', '', '', '', '', '20D', true, true, true, '0', '1350.75', '3']);
    assert.equal(ui.control(slotSelection).checked, true);
    assert.equal(form.querySelector('.agent-confirmation').textContent, 'Queued SHA → LAX (2 queued this session)');
    const grid = ui.container.querySelector('.agent-grid-scroll');
    for (const lane of ['SHA → CHI', 'SHA → LAX']) {
        assert.ok(walk(grid).some(node => node.textContent === lane), lane);
    }
    ui.button('Cancel', form).events.click();
    open(ui);
    assert.equal(ui.form().querySelector('.agent-confirmation').textContent, '');
});

test('both queue buttons are disabled during submission and a failure keeps values for retry', async t => {
    const pending = Promise.withResolvers();
    const ui = await mountForm(t, {
        options,
        onRequest: ({ body }) => ui.calls.length === 1 ? pending.promise : Response.json({ agents: [record(body[0])] })
    });
    open(ui);
    ui.set(queryField, 'chi');
    configureBooking(ui);
    const original = values(ui);
    const submitting = ui.submit(anotherButton);
    for (const name of ['Queue agent', anotherButton]) {
        assert.equal(ui.button(name, ui.form()).disabled, true);
        await ui.submit(name);
    }
    assert.equal(ui.calls.length, 1);
    pending.resolve(Response.json({ error: 'Row 1: Choose another date.' }, { status: 400 }));
    await submitting;
    assert.deepEqual(values(ui), original);
    assert.equal(ui.button('Queue agent').disabled, false);
    assert.equal(ui.button(anotherButton).disabled, false);
    assert.equal(ui.form().querySelector('.agent-confirmation').textContent, '');
    const error = ui.form().querySelector('.error');
    assert.equal(error.hidden, false);
    assert.equal(ui.activeElement(), error);
    assert.equal(error.children[1].textContent, 'Choose another date.');
    await ui.submit(anotherButton);
    assert.equal(ui.calls.length, 2);
    assert.deepEqual(ui.calls[0], ui.calls[1]);
    assert.match(ui.form().querySelector('.agent-confirmation').textContent, /1 queued this session/);
});

test('single choices select automatically and the date follows the current lane windows', async t => {
    const ui = await mountForm(t, {
        options: { ...options, rateTypes: ['Inland'], containerTypes: ['40HC'], lanes: [inlandLane] }
    });
    open(ui);
    assert.deepEqual(values(ui).slice(0, 6), ['', 'Inland', 'SHA', 'CHI', later, '40HC']);
    assert.equal(ui.control('Sailing date').disabled, false);
});

test('date clamps to today, resets on lane changes and stays blank for expired lanes', async t => {
    const ui = await mountForm(t, { options });
    open(ui);
    ui.set('Rate type', 'Port');
    ui.set('Destination port', 'LAX');
    assert.equal(ui.control('Sailing date').min, today);
    assert.equal(ui.control('Sailing date').value, today);
    ui.set('Sailing date', '2026-11-21');
    ui.set('Rate type', 'Inland');
    assert.equal(ui.control('Sailing date').value, later);
    ui.set('Rate type', 'Port');
    ui.set('Destination port', 'NYC');
    assert.equal(ui.control('Sailing date').value, '');
    assert.equal(ui.control('Sailing date').disabled, true);
    await ui.submit('Queue agent');
    assert.equal(ui.calls.length, 0);
    assert.match(ui.form().querySelector('.error').children[1].textContent, /current rate window/);
});

test('saved query fills a unique lane and an unavailable port shows the existing note', async t => {
    const ui = await mountForm(t, { options });
    open(ui);
    assert.equal(ui.control(queryField).disabled, undefined);
    ui.set(queryField, 'chi');
    assert.deepEqual(values(ui).slice(0, 5), ['chi', 'Inland', 'SHA', 'CHI', later]);
    ui.set(queryField, 'unavailable');
    assert.ok(walk(ui.form()).some(node => node.textContent ===
        'This query contains a port that is unavailable for this rate type. Select an available lane.'));
    assert.equal(ui.control(queryField).value, '');
});

test('a multi-type saved query fills ports after the user picks a rate type', async t => {
    const ui = await mountForm(t, { options: {
        ...options, lanes: [...options.lanes, { ...inlandLane, rateType: 'Port' }]
    } });
    open(ui);
    ui.set(queryField, 'chi');
    assert.equal(ui.control('Rate type').value, '');
    ui.set('Rate type', 'Port');
    assert.deepEqual(values(ui).slice(0, 5), ['chi', 'Port', 'SHA', 'CHI', later]);
    ui.set('Destination port', 'LAX');
    assert.equal(ui.control(queryField).value, '');
});

test('edit loads agent-specific options and saves one object with existing query and date', async t => {
    const { savedQueries, ...editOptions } = options;
    const original = record({ ...requested, sailingDate: '2026-11-25' }, 'agent/edit');
    const ui = await mountForm(t, {
        options: { ...options, canRequestBooking: false, lanes: [portLane], rateTypes: ['Port'] },
        agents: [original],
        onRequest: ({ method, body }) => method === 'GET'
            ? Response.json({ ...editOptions, savedQueries: [] })
            : Response.json({ agent: record(body, original.id) })
    });
    const expand = walk(ui.container).find(node => node.tag === 'button' && node.attributes['aria-expanded'] === 'false');
    expand.events.click();
    await ui.button('Edit').events.click();
    assert.deepEqual(actionLabels(ui), ['Save changes', 'Cancel']);
    assert.equal(ui.control(bookingField).checked, true);
    ui.set('Slots', '4');
    await ui.submit('Save changes');
    assert.deepEqual(ui.calls, [
        { path: endpoint + '/options?agentId=agent%2Fedit', method: 'GET', body: undefined },
        { path: endpoint + '/agent%2Fedit', method: 'PUT', body: { ...requested, sailingDate: '2026-11-25', bookingSlots: 4 } }
    ]);
    assert.equal(ui.form(), undefined);
});

test('companies without booking permission queue only the visible settings', async t => {
    const ui = await mountForm(t, {
        options: { ...options, canRequestBooking: false },
        onRequest: ({ body }) => Response.json({ agents: [record(body[0])] })
    });
    open(ui);
    ui.set(queryField, 'chi');
    ui.set('Container type', '20D');
    assert.ok(!walk(ui.form()).some(node => node.textContent === bookingField));
    assert.equal(ui.form().querySelector('.agent-prices').hidden, true);
    await ui.submit(anotherButton);
    assert.deepEqual(ui.calls[0].body, [{
        ...requested, allowAlternativeRoutes: false, allowBookingRequest: false,
        priceMin: null, priceMax: null, bookingSlots: null
    }]);
});
