import { csvField } from './lane-csv.js';

const COLUMNS = [
    '#',
    'Rate Type',
    'Origin',
    'Destination',
    'Sailing Date',
    'Container',
    'Priority',
    'Search',
    'Price USD',
    'Booking',
    'Slots Requested',
    'Booking Request Id',
    'Result'
];

const FORMULA_START = /^[=+\-@\t\r]/;

export function latestAgent(agents, position, role) {
    let chosen = null;
    for (const agent of agents) {
        if (agent.role !== role || agent.lanePosition !== position) continue;
        if (!chosen || Number(agent.attempt) > Number(chosen.attempt)) chosen = agent;
    }
    return chosen;
}

export function searchLabel(agent, runStatus) {
    if (!agent) return runStatus === 'running' ? 'Waiting' : 'Not searched';
    if (agent.status === 'running') return 'Searching';
    if (agent.status === 'completed') return agent.rateId ? 'Rate found' : 'No rate';
    if (agent.status === 'failed') return 'Failed';
    if (agent.status === 'cancelled') return 'Cancelled';
    return '';
}

export function bookingLabel(lane, agent) {
    if (lane.allowBookingRequest !== true) return { text: 'Not allowed', link: false };
    if (!agent) return { text: 'Not attempted', link: false };
    if (agent.bookingRequestId) {
        const slots = agent.slots == null ? '0' : String(agent.slots);
        return { text: `Requested, ${slots} slots`, link: true };
    }
    if (agent.status === 'running') return { text: 'Booking', link: false };
    if (agent.status === 'completed') return { text: 'Not booked', link: false };
    if (agent.status === 'failed') return { text: 'Failed', link: false };
    if (agent.status === 'cancelled') return { text: 'Cancelled', link: false };
    return { text: '', link: false };
}

export function resultText(searchAgent, bookingAgent) {
    const search = searchAgent && searchAgent.report ? String(searchAgent.report) : '';
    const booking = bookingAgent && bookingAgent.report ? String(bookingAgent.report) : '';
    if (search && booking) return `${search}\n${booking}`;
    return search || booking;
}

function plainPrice(agent) {
    if (!agent || agent.price == null || agent.price === '') return '';
    return String(agent.price);
}

function bookingFields(agent) {
    if (!agent || !agent.bookingRequestId) return ['', ''];
    const slots = agent.slots == null || agent.slots === '' ? '' : String(agent.slots);
    return [slots, String(agent.bookingRequestId)];
}

function guardField(value) {
    const text = value == null ? '' : String(value);
    return FORMULA_START.test(text) ? `'${text}` : text;
}

function csvCell(value) {
    return csvField(guardField(value));
}

function laneRow(lane, run, agents) {
    const search = latestAgent(agents, lane.position, 'search');
    const booking = latestAgent(agents, lane.position, 'booking');
    const [slots, bookingRequestId] = bookingFields(booking);
    const values = [
        lane.position == null ? '' : String(lane.position),
        lane.rateType || '',
        lane.originPort || '',
        lane.destinationPort || '',
        lane.sailingDate || '',
        lane.containerType || '',
        lane.priority || '',
        searchLabel(search, run.status),
        plainPrice(search),
        bookingLabel(lane, booking).text,
        slots,
        bookingRequestId,
        resultText(search, booking)
    ];
    return values.map(csvCell).join(',');
}

export function laneResultsCsv(run) {
    const lanes = Array.isArray(run && run.lanes) ? run.lanes : [];
    const agents = Array.isArray(run && run.agents) ? run.agents : [];
    const lines = [COLUMNS.map(csvCell).join(',')];
    for (const lane of lanes) lines.push(laneRow(lane, run || {}, agents));
    return `\uFEFF${lines.map(line => `${line}\r\n`).join('')}`;
}

function swarmSlug(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '');
    return slug;
}

function startDate(run) {
    const value = run && typeof run.startedAt === 'string' ? run.startedAt.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return value;
}

export function laneResultsFilename(run) {
    const parts = ['swarm-run', swarmSlug(run && run.swarmName), startDate(run)].filter(Boolean);
    return `${parts.join('-')}.csv`;
}
