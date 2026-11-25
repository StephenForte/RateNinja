'use strict';

const { mountSwarm, control, click, lanes, walk, options, today, lane } = require('./r1-63');

const customer = { signedIn: true, systemAdmin: false };
const FULL_HEADER = [
    'Rate Type', 'Origin Port', 'Destination Port', 'Sailing Date', 'Container Type',
    'Priority', 'Allow Alternatives', 'Date Flex Days', 'Allow Booking',
    'Min Price', 'Max Price', 'Slots', 'AI Slot Selection'
];
const REQUIRED_HEADER = FULL_HEADER.slice(0, 5);

function csvField(value) {
    const text = value == null ? '' : String(value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function csvText(rows, { headers = FULL_HEADER, line = '\n', bom = false } = {}) {
    const body = [headers.map(csvField).join(','), ...rows.map(row => row.map(csvField).join(','))].join(line);
    return bom ? `\uFEFF${body}` : body;
}

function laneRow(overrides = {}) {
    return [
        overrides.rateType ?? 'Port',
        overrides.origin ?? 'SHA',
        overrides.destination ?? 'LAX',
        overrides.date ?? today,
        overrides.container ?? '40HC',
        overrides.priority ?? 'normal',
        overrides.alternatives ?? 'no',
        overrides.flex ?? '0',
        overrides.booking ?? 'no',
        overrides.min ?? '',
        overrides.max ?? '',
        overrides.slots ?? '',
        overrides.ai ?? 'no'
    ];
}

function file(name, text) {
    return new File([text], name, { type: 'text/csv' });
}

function saved(body, id = 'swarm-new') {
    return Response.json({
        swarm: { id, canEdit: true, updatedAt: '2026-11-22T02:00:00.000Z', ...body }
    });
}

function customerFetch(onWrite, optionsOverride = options) {
    return call => {
        if (call.path === '/api/swarm/access' && call.method === 'GET') return Response.json({ enabled: true });
        if (call.path === '/api/swarms' && call.method === 'GET') return Response.json({ swarms: [] });
        if (call.path === '/api/managed-agents/options' && call.method === 'GET') return Response.json(optionsOverride);
        if (call.path === '/api/swarm-runs' && call.method === 'GET') return Response.json({ runs: [] });
        if (onWrite) return onWrite(call);
        return Response.json({ error: `unexpected ${call.method} ${call.path}` }, { status: 500 });
    };
}

async function openLanes(t, { onWrite, optionsOverride, name = 'North', instructions = 'Hold course' } = {}) {
    const posts = [];
    const mounted = await mountSwarm(t, {
        permissions: customer,
        respond: customerFetch(call => {
            posts.push(call);
            if (onWrite) return onWrite(call, posts);
            return saved(call.body);
        }, optionsOverride)
    });
    await click(mounted.container, 'New swarm');
    control(mounted.container, 'Name').value = name;
    control(mounted.container, 'Instructions').value = instructions;
    await click(mounted.container, 'Next');
    return { ...mounted, posts };
}

function panel(container, step) {
    return walk(container).find(node => String(node.className).split(' ').includes(`swarm-step-${step}`));
}

function stepError(container, step) {
    return walk(panel(container, step)).find(node => String(node.className).split(' ').includes('swarm-step-error')).textContent;
}

async function upload(container, csvFile) {
    const input = control(container, 'Upload CSV');
    input.files = [csvFile];
    await input.events.change();
}

const savedLane = lane();

module.exports = {
    FULL_HEADER, REQUIRED_HEADER, csvField, csvText, laneRow, file, saved, customerFetch, openLanes,
    panel, stepError, upload, savedLane, customer, control, click, lanes, walk, options, today, lane
};
