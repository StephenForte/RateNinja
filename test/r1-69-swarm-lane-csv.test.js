'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { tags } = require('./helpers/r1-63');
const {
    FULL_HEADER, REQUIRED_HEADER, csvText, laneRow, file, openLanes, panel, stepError, upload,
    savedLane, control, click, lanes, walk, options, today
} = require('./helpers/r1-69');

const FIELDS = 'Select a rate type, origin, destination, sailing date and container type for every lane.';
const VISIBLE = 'Select a visible lane for this rate type.';
const DATE = 'Choose a sailing date in a rate window for this lane.';
const FLEX = 'Enter a whole number of flex days from 0 to 14.';
const PRICE = 'Enter nonnegative minimum and maximum prices with minimum at or below maximum.';
const BOOKING = 'Your company cannot request bookings.';
const SLOTS = 'Enter a whole number of slots from 1 to 10.';
const DATE_FORMAT = 'Enter the sailing date as YYYY-MM-DD.';

let csvModule;
async function csv() {
    csvModule ??= await import('../public/js/swarm/lane-csv.js');
    return csvModule;
}

function identities(container) {
    return walk(container)
        .filter(node => node.className === 'swarm-lane-identity' && !panelHidden(node))
        .map(node => node.textContent);
}

function panelHidden(node) {
    for (let item = node; item; item = item.parent) {
        if (item.hidden) return true;
    }
    return false;
}

async function toLanes(t, extra) {
    const mounted = await openLanes(t, extra);
    await click(mounted.container, 'Next');
    return mounted;
}

async function refuse(t, csvFile, message) {
    const mounted = await toLanes(t);
    window.confirm = () => { throw new Error('unexpected confirm'); };
    await click(mounted.container, 'Add lane');
    await upload(mounted.container, csvFile);
    assert.equal(panel(mounted.container, 3).hidden, false);
    assert.equal(panel(mounted.container, 4).hidden, true);
    assert.equal(lanes(mounted.container).length, 1);
    assert.equal(control(lanes(mounted.container)[0], 'Sailing date').value, today);
    assert.equal(stepError(mounted.container, 3).includes(message), true, stepError(mounted.container, 3));
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.equal(mounted.posts.length, 1);
    assert.deepEqual(mounted.posts[0].body, {
        name: 'North',
        instructions: 'Hold course',
        totalSpendCap: null,
        totalSlotsCap: null,
        lanes: [savedLane]
    });
}

test('quoted reordered CSV cells keep commas, quotes, line breaks and a byte-order mark', async () => {
    const { parseLaneCsv, laneFromRecord } = await csv();
    const header = [' container type ', 'SAILING DATE', 'Destination Port', 'origin port', 'Rate Type'];
    const text = csvText([
        ['40hc', today, 'Say "Hi"', 'Los Angeles,\r\nCA', 'port']
    ], { headers: header, line: '\r\n', bom: true });
    const parsed = parseLaneCsv(text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.records[0].values, {
        rateType: 'port',
        originPort: 'Los Angeles,\r\nCA',
        destinationPort: 'Say "Hi"',
        sailingDate: today,
        containerType: '40hc',
        priority: '',
        allowAlternatives: '',
        dateFlexDays: '',
        allowBooking: '',
        priceMin: '',
        priceMax: '',
        slots: '',
        acceptMaxSlots: ''
    });
    const quotedOptions = {
        ...options,
        lanes: [{
            rateType: 'Port',
            originPort: 'Los Angeles,\r\nCA',
            destinationPort: 'Say "Hi"',
            windows: [{ start: today, end: '2026-12-01' }]
        }]
    };
    const built = laneFromRecord(parsed.records[0], quotedOptions);
    assert.deepEqual(built.messages, []);
    assert.equal(built.lane.rateType, 'Port');
    assert.equal(built.lane.originPort, 'Los Angeles,\r\nCA');
    assert.equal(built.lane.destinationPort, 'Say "Hi"');
    assert.equal(built.lane.containerType, '40HC');
});

test('an unclosed quote is not valid CSV and a blank header row is missing columns', async () => {
    const { parseLaneCsv, CSV_MESSAGES } = await csv();
    assert.deepEqual(parseLaneCsv('Rate Type,"SHA'), { ok: false, messages: [CSV_MESSAGES.parse] });
    const missing = parseLaneCsv('\n');
    assert.equal(missing.ok, false);
    assert.equal(missing.messages[0].includes('Rate Type'), true);
});

test('the template uses the first current window and is header only otherwise', async () => {
    const { templateCsv, parseLaneCsv } = await csv();
    const current = templateCsv(options);
    assert.equal(current.startsWith(`${FULL_HEADER.join(',')}\n`), true);
    const parsed = parseLaneCsv(current);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].values.rateType, 'Port');
    assert.equal(parsed.records[0].values.sailingDate, today);
    assert.equal(parsed.records[0].values.containerType, '40HC');
    assert.equal(parsed.records[0].values.allowBooking, 'no');
    const expired = {
        ...options,
        lanes: [
            { rateType: 'Old', originPort: 'NYC', destinationPort: 'SHA', windows: [{ start: '2020-01-01', end: '2020-01-02' }] },
            options.lanes[0]
        ]
    };
    assert.equal(templateCsv(expired).includes('Old'), false);
    assert.equal(templateCsv(expired).includes('Port'), true);
    const none = templateCsv({
        ...options,
        lanes: [{ rateType: 'Old', originPort: 'NYC', destinationPort: 'SHA', windows: [{ start: '2020-01-01', end: '2020-01-02' }] }]
    });
    assert.equal(none, `${FULL_HEADER.join(',')}\n`);
    const comma = templateCsv({
        ...options,
        lanes: [{
            rateType: 'Port', originPort: 'Los Angeles, CA', destinationPort: 'Say "Hi"',
            windows: [{ start: today, end: '2026-12-01' }]
        }]
    });
    assert.equal(parseLaneCsv(comma).records[0].values.originPort, 'Los Angeles, CA');
    assert.equal(parseLaneCsv(comma).records[0].values.destinationPort, 'Say "Hi"');
});

test('yes/no and priority cells use the file tokens and blanks', async () => {
    const { laneFromRecord } = await csv();
    const values = {
        rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: today, containerType: '40HC',
        priority: '', allowAlternatives: '', dateFlexDays: '', allowBooking: '', priceMin: '4', priceMax: '9',
        slots: '2', acceptMaxSlots: 'yes'
    };
    const blank = laneFromRecord({ values }, options);
    assert.deepEqual(blank.messages, []);
    assert.equal(blank.lane.priority, 'normal');
    assert.equal(blank.lane.allowAlternativeRoutes, false);
    assert.equal(blank.lane.dateFlexDays, 0);
    assert.equal(blank.lane.allowBookingRequest, false);
    assert.equal(blank.lane.priceMin, '');
    assert.equal(blank.lane.acceptMaxSlots, false);
    const booked = laneFromRecord({
        values: { ...values, priority: 'HIGH', allowAlternatives: 'Y', allowBooking: 'True', acceptMaxSlots: 'n' }
    }, options);
    assert.equal(booked.lane.priority, 'high');
    assert.equal(booked.lane.allowAlternativeRoutes, true);
    assert.equal(booked.lane.allowBookingRequest, true);
    assert.equal(booked.lane.acceptMaxSlots, false);
    assert.equal(booked.lane.priceMin, '4');
});

test('a full CSV file saves the same body as the same lanes entered by hand', async t => {
    const expected = {
        name: 'Created',
        instructions: 'Created text',
        totalSpendCap: 80,
        totalSlotsCap: 9,
        lanes: [
            {
                rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: '2026-11-30', containerType: '40HC',
                allowAlternativeRoutes: true, allowBookingRequest: true, priceMin: 10, priceMax: 20.5, bookingSlots: 3,
                acceptMaxSlots: true, priority: 'high', dateFlexDays: 4
            },
            {
                rateType: 'Port', originPort: 'SHA', destinationPort: 'LAX', sailingDate: today, containerType: '40HC',
                allowAlternativeRoutes: false, allowBookingRequest: false, priceMin: null, priceMax: null, bookingSlots: null,
                acceptMaxSlots: false, priority: 'low', dateFlexDays: 0
            }
        ]
    };
    const snapshot = [
        {
            identity: 'Port SHA to LAX, 2026-11-30, 40HC',
            priority: 'high', alternatives: true, flex: '4', booking: true, min: '10', max: '20.5', slots: '3', ai: true
        },
        {
            identity: `Port SHA to LAX, ${today}, 40HC`,
            priority: 'low', alternatives: false, flex: '0', booking: false, min: '', max: '', slots: '', ai: false
        }
    ];
    const hand = await openLanes(t, { name: 'Created', instructions: 'Created text' });
    control(hand.container, 'Total spend cap (USD)').value = '80';
    control(hand.container, 'Total slots cap').value = '9';
    await click(hand.container, 'Next');
    await click(hand.container, 'Add lane');
    await click(hand.container, 'Add lane');
    control(lanes(hand.container)[0], 'Sailing date').value = '2026-11-30';
    await click(hand.container, 'Next');
    const handRows = lanes(hand.container);
    control(handRows[0], 'Priority').value = 'high';
    control(handRows[0], 'Allow alternatives').checked = true;
    control(handRows[0], 'Date flex (days)').value = '4';
    const booking = control(handRows[0], 'Allow booking');
    booking.checked = true;
    booking.events.change();
    control(handRows[0], 'Min price (USD)').value = '10';
    control(handRows[0], 'Max price (USD)').value = '20.5';
    control(handRows[0], 'Slots').value = '3';
    control(handRows[0], 'Use AI for slot selection').checked = true;
    control(handRows[1], 'Priority').value = 'low';
    assert.deepEqual(readPolicy(hand.container), snapshot);
    await click(hand.container, 'Next');
    await click(hand.container, 'Save');

    const text = csvText([
        laneRow({
            date: '2026-11-30', priority: 'high', alternatives: 'yes', flex: '4', booking: 'yes',
            min: '10', max: '20.5', slots: '3', ai: 'yes'
        }),
        laneRow({ priority: 'low' })
    ]);
    const uploaded = await openLanes(t, { name: 'Created', instructions: 'Created text' });
    control(uploaded.container, 'Total spend cap (USD)').value = '80';
    control(uploaded.container, 'Total slots cap').value = '9';
    await click(uploaded.container, 'Next');
    let asked = 0;
    window.confirm = () => { asked += 1; return true; };
    await upload(uploaded.container, file('Lanes.CSV', text));
    assert.equal(asked, 0);
    assert.equal(panel(uploaded.container, 4).hidden, false);
    assert.deepEqual(readPolicy(uploaded.container), snapshot);
    await click(uploaded.container, 'Next');
    await click(uploaded.container, 'Save');
    assert.deepEqual(hand.posts[0].body, expected);
    assert.deepEqual(uploaded.posts[0].body, expected);
});

test('five required columns use the wizard defaults', async t => {
    const mounted = await toLanes(t);
    const text = csvText([['Port', 'SHA', 'LAX', today, '40HC']], { headers: REQUIRED_HEADER });
    await upload(mounted.container, file('lanes.csv', text));
    assert.equal(panel(mounted.container, 4).hidden, false);
    const row = lanes(mounted.container)[0];
    assert.equal(control(row, 'Priority').value, 'normal');
    assert.equal(control(row, 'Allow alternatives').checked, false);
    assert.equal(control(row, 'Date flex (days)').value, '0');
    assert.equal(control(row, 'Allow booking').checked, false);
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.deepEqual(mounted.posts[0].body.lanes, [savedLane]);
});

test('booking no ignores price, slots and AI slot cells', async t => {
    const mounted = await toLanes(t);
    const text = csvText([laneRow({
        booking: 'no', min: '$5', max: '1e2', slots: '1,000', ai: 'yes', alternatives: 'yes', flex: '2', priority: 'low'
    })]);
    await upload(mounted.container, file('lanes.csv', text));
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.deepEqual(mounted.posts[0].body.lanes[0], {
        ...savedLane,
        allowAlternativeRoutes: true,
        priority: 'low',
        dateFlexDays: 2
    });
});

test('lowercase lane and container values are stored with the options spelling', async t => {
    const mounted = await toLanes(t);
    const text = csvText([['port', 'sha', 'lax', today, '40hc']], { headers: REQUIRED_HEADER });
    await upload(mounted.container, file('lanes.csv', text));
    assert.equal(identities(mounted.container)[0], `Port SHA to LAX, ${today}, 40HC`);
    await click(mounted.container, 'Back');
    const row = lanes(mounted.container)[0];
    assert.equal(control(row, 'Rate type').value, 'Port');
    assert.equal(control(row, 'Origin port').value, 'SHA');
    assert.equal(control(row, 'Destination port').value, 'LAX');
    assert.equal(control(row, 'Container type').value, '40HC');
    await click(mounted.container, 'Next');
    assert.equal(identities(mounted.container)[0], `Port SHA to LAX, ${today}, 40HC`);
});

test('each file refusal leaves the lanes, step and Save body unchanged', async t => {
    const { CSV_MESSAGES } = await csv();
    const good = csvText([laneRow({ date: '2026-11-30' })]);
    await refuse(t, file('lanes.txt', good), CSV_MESSAGES.name);
    await refuse(t, file('lanes.csv', 'x'.repeat(100001)), CSV_MESSAGES.size);
    const headerLine = `${REQUIRED_HEADER.join(',')}\n`;
    const exact = headerLine + ' '.repeat(100000 - headerLine.length);
    await refuse(t, file('lanes.csv', exact), CSV_MESSAGES.none);
    await refuse(t, {
        name: 'lanes.csv',
        size: 8,
        text() { return Promise.reject(new Error('denied')); }
    }, CSV_MESSAGES.read);
    await refuse(t, file('lanes.csv', 'Rate Type,Destination Port,Sailing Date,Container Type\nPort,LAX,2026-11-22,40HC'), 'Origin Port');
    await refuse(t, file('lanes.csv', `${REQUIRED_HEADER.join(',')},Notes\nPort,SHA,LAX,${today},40HC,hello`), 'Notes');
    await refuse(t, file('lanes.csv', `rate type,${REQUIRED_HEADER.join(',')}\nPort,Port,SHA,LAX,${today},40HC`), 'Rate Type');
    await refuse(t, file('lanes.csv', `${REQUIRED_HEADER.join(',')}\n,,,,`), CSV_MESSAGES.none);
    await refuse(t, file('lanes.csv', `${REQUIRED_HEADER.join(',')}\n${Array.from({ length: 26 }, () => laneRow().slice(0, 5).join(',')).join('\n')}`), CSV_MESSAGES.tooMany);
});

test('each row rule refuses the file and keeps the Save body', async t => {
    const row = (overrides, headers = FULL_HEADER) => file('lanes.csv', csvText([laneRow(overrides)], { headers }));
    await refuse(t, row({ origin: 'NOPE' }), `Row 2: ${VISIBLE}`);
    await refuse(t, row({ container: '45HC' }), `Row 2: ${FIELDS}`);
    await refuse(t, row({ rateType: '' }), `Row 2: ${FIELDS}`);
    await refuse(t, row({ date: '11/24/2026' }), `Row 2: ${DATE_FORMAT}`);
    await refuse(t, row({ date: '2026-02-31' }), `Row 2: ${DATE_FORMAT}`);
    await refuse(t, row({ date: '2026-11-21' }), `Row 2: ${DATE}`);
    await refuse(t, row({ date: '2027-01-15' }), `Row 2: ${DATE}`);
    await refuse(t, row({ flex: '15' }), `Row 2: ${FLEX}`);
    await refuse(t, row({ flex: '1e1' }), `Row 2: ${FLEX}`);
    await refuse(t, row({ flex: '2.0' }), `Row 2: ${FLEX}`);
    await refuse(t, row({ priority: 'urgent' }), 'Row 2: Priority must be high, normal or low.');
    await refuse(t, row({ alternatives: 'maybe' }), 'Row 2: Allow Alternatives must be yes or no.');
    await refuse(t, row({ booking: 'maybe' }), 'Row 2: Allow Booking must be yes or no.');
    await refuse(t, row({ booking: 'yes', min: '', max: '', slots: '1' }), `Row 2: ${PRICE}`);
    await refuse(t, row({ booking: 'yes', min: '5', max: '1', slots: '1' }), `Row 2: ${PRICE}`);
    await refuse(t, row({ booking: 'yes', min: '$5', max: '6', slots: '1' }), `Row 2: ${PRICE}`);
    await refuse(t, row({ booking: 'yes', min: '1e2', max: '6', slots: '1' }), `Row 2: ${PRICE}`);
    await refuse(t, row({ booking: 'yes', min: '1,000', max: '2000', slots: '1' }), `Row 2: ${PRICE}`);
    await refuse(t, row({ booking: 'yes', min: '1', max: '2', slots: '0' }), `Row 2: ${SLOTS}`);
    await refuse(t, row({ booking: 'yes', min: '1', max: '2', slots: '11' }), `Row 2: ${SLOTS}`);
    await refuse(t, row({ booking: 'yes', min: '1', max: '2', slots: '1e2' }), `Row 2: ${SLOTS}`);
    await refuse(t, row({ booking: 'yes', min: '1', max: '2', slots: '1', ai: 'maybe' }), 'Row 2: AI Slot Selection must be yes or no.');
    const text = [
        REQUIRED_HEADER.join(','),
        ',,,,',
        '',
        `Port,NOPE,LAX,${today},40HC`
    ].join('\n');
    await refuse(t, file('lanes.csv', text), `Row 4: ${VISIBLE}`);
    const mounted = await toLanes(t);
    await click(mounted.container, 'Add lane');
    await upload(mounted.container, file('lanes.csv', text));
    const error = stepError(mounted.container, 3);
    assert.equal(error.includes('Row 2:'), false);
    assert.equal(error.includes('Row 3:'), false);
});

test('25 lane rows are accepted and 11 problems show the first 10', async t => {
    const accepted = await toLanes(t);
    await upload(accepted.container, file('lanes.csv', csvText(Array.from({ length: 25 }, () => laneRow()))));
    assert.equal(panel(accepted.container, 4).hidden, false);
    assert.equal(identities(accepted.container).length, 25);
    assert.equal(walk(accepted.container).find(node => node.tag === 'button' && node.textContent === 'Add lane').disabled, true);
    const lines = Array.from({ length: 11 }, () => laneRow({ origin: 'NOPE' }));
    await refuse(t, file('lanes.csv', csvText(lines)), 'Row 2:');
    const listed = await toLanes(t);
    await click(listed.container, 'Add lane');
    await upload(listed.container, file('lanes.csv', csvText(lines)));
    const error = stepError(listed.container, 3).split('\n');
    assert.equal(error.length, 11);
    assert.equal(error[0].startsWith('Row 2:'), true);
    assert.equal(error[9].startsWith('Row 11:'), true);
    assert.equal(error[10], 'and 1 more');
    assert.equal(error.some(line => line.startsWith('Row 12:')), false);
    assert.equal(lanes(listed.container).length, 1);
});

test('confirm no keeps the current lanes and confirm yes replaces them', async t => {
    const { CSV_MESSAGES } = await csv();
    const kept = await toLanes(t);
    await click(kept.container, 'Add lane');
    let message = '';
    window.confirm = text => {
        message = text;
        return false;
    };
    await upload(kept.container, file('lanes.csv', csvText([laneRow({ date: '2026-11-30', priority: 'high' })])));
    assert.equal(message, CSV_MESSAGES.confirm);
    assert.equal(panel(kept.container, 3).hidden, false);
    assert.equal(control(lanes(kept.container)[0], 'Sailing date').value, today);
    await click(kept.container, 'Next');
    await click(kept.container, 'Next');
    await click(kept.container, 'Save');
    assert.equal(kept.posts[0].body.lanes[0].sailingDate, today);
    assert.equal(kept.posts[0].body.lanes[0].priority, 'normal');

    const replaced = await toLanes(t);
    await click(replaced.container, 'Add lane');
    window.confirm = () => true;
    await upload(replaced.container, file('lanes.csv', csvText([laneRow({ date: '2026-11-30', priority: 'high' })])));
    assert.equal(panel(replaced.container, 4).hidden, false);
    assert.deepEqual(identities(replaced.container), ['Port SHA to LAX, 2026-11-30, 40HC']);
    assert.equal(control(lanes(replaced.container)[0], 'Priority').value, 'high');
    await click(replaced.container, 'Next');
    await click(replaced.container, 'Save');
    assert.equal(replaced.posts[0].body.lanes[0].sailingDate, '2026-11-30');
    assert.equal(replaced.posts[0].body.lanes[0].priority, 'high');
});

test('step 4 shows lane identity as text, including hostile cell text', async t => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const hostileOptions = {
        ...options,
        lanes: [{ rateType: 'Port', originPort: hostile, destinationPort: 'LAX', windows: [{ start: today, end: '2026-12-01' }] }]
    };
    const mounted = await toLanes(t, { optionsOverride: hostileOptions });
    await upload(mounted.container, file('lanes.csv', csvText([
        laneRow({ origin: hostile, priority: 'high' })
    ])));
    assert.deepEqual(identities(mounted.container), [`Port ${hostile} to LAX, ${today}, 40HC`]);
    assert.equal(tags(mounted.container).includes('script'), false);
    assert.equal(tags(mounted.container).includes('img'), false);
    await click(mounted.container, 'Back');
    await click(mounted.container, 'Add lane');
    await click(mounted.container, 'Next');
    const hand = identities(mounted.container);
    assert.equal(hand[1], `Port ${hostile} to LAX, ${today}, 40HC`);
    assert.equal(tags(mounted.container).includes('script'), false);
});

test('back to step 3 keeps uploaded lanes in the selects and Next does not change them', async t => {
    const mounted = await toLanes(t);
    await upload(mounted.container, file('lanes.csv', csvText([
        laneRow({ date: '2026-11-30', priority: 'high', alternatives: 'yes', flex: '3' }),
        laneRow({ date: '2026-11-25', priority: 'low' })
    ])));
    await click(mounted.container, 'Back');
    assert.equal(panel(mounted.container, 3).hidden, false);
    let rows = lanes(mounted.container);
    assert.equal(control(rows[0], 'Sailing date').value, '2026-11-30');
    assert.equal(control(rows[1], 'Sailing date').value, '2026-11-25');
    await click(rows[1], 'Up');
    rows = lanes(mounted.container);
    assert.equal(control(rows[0], 'Sailing date').value, '2026-11-25');
    await click(rows[0], 'Down');
    await click(lanes(mounted.container)[1], 'Remove');
    assert.equal(lanes(mounted.container).length, 1);
    await click(mounted.container, 'Add lane');
    assert.equal(lanes(mounted.container).length, 2);
    await click(mounted.container, 'Next');
    rows = lanes(mounted.container);
    assert.equal(control(rows[0], 'Priority').value, 'high');
    assert.equal(control(rows[0], 'Allow alternatives').checked, true);
    assert.equal(control(rows[0], 'Date flex (days)').value, '3');
    assert.equal(identities(mounted.container)[0], 'Port SHA to LAX, 2026-11-30, 40HC');
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.equal(mounted.posts[0].body.lanes[0].sailingDate, '2026-11-30');
    assert.equal(mounted.posts[0].body.lanes[0].priority, 'high');
    assert.equal(mounted.posts[0].body.lanes[0].dateFlexDays, 3);
    assert.equal(mounted.posts[0].body.lanes[1].sailingDate, today);
    assert.equal(mounted.posts[0].body.lanes[1].priority, 'normal');
});

test('the unedited template uploads and the download control is present', async t => {
    const { templateCsv } = await csv();
    const mounted = await toLanes(t);
    assert.equal(walk(mounted.container).some(node => node.tag === 'button' && node.textContent === 'Download template'), true);
    await click(mounted.container, 'Download template');
    await upload(mounted.container, file('swarm-lanes.csv', templateCsv(options)));
    assert.equal(stepError(mounted.container, 3), '');
    assert.equal(panel(mounted.container, 4).hidden, false);
    assert.deepEqual(identities(mounted.container), [`Port SHA to LAX, ${today}, 40HC`]);
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.deepEqual(mounted.posts[0].body.lanes, [savedLane]);
});

test('booking yes is refused when the company cannot request bookings', async t => {
    const mounted = await toLanes(t, { optionsOverride: { ...options, canRequestBooking: false } });
    await click(mounted.container, 'Add lane');
    window.confirm = () => { throw new Error('unexpected confirm'); };
    await upload(mounted.container, file('lanes.csv', csvText([laneRow({
        booking: 'yes', min: '1', max: '2', slots: '1', ai: 'yes'
    })])));
    assert.equal(panel(mounted.container, 3).hidden, false);
    assert.equal(stepError(mounted.container, 3).includes(`Row 2: ${BOOKING}`), true);
    assert.equal(lanes(mounted.container).length, 1);
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Next');
    await click(mounted.container, 'Save');
    assert.equal(mounted.posts[0].body.lanes[0].allowBookingRequest, false);
});

function readPolicy(container) {
    return lanes(container).map(row => ({
        identity: walk(row).find(node => node.className === 'swarm-lane-identity').textContent,
        priority: control(row, 'Priority').value,
        alternatives: control(row, 'Allow alternatives').checked,
        flex: control(row, 'Date flex (days)').value,
        booking: control(row, 'Allow booking').checked,
        min: control(row, 'Min price (USD)').value,
        max: control(row, 'Max price (USD)').value,
        slots: control(row, 'Slots').value,
        ai: control(row, 'Use AI for slot selection').checked
    }));
}
