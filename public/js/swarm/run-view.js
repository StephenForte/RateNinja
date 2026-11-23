import { paragraph, textCell } from '../dom.js';

const BOOKING_REQUESTS = '/profile/booking-requests';

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

function againstCap(booked, cap) {
    const amount = booked == null ? '0' : String(booked);
    const limit = cap == null ? 'None' : String(cap);
    return `${amount} / ${limit}`;
}

function addFact(list, term, value, className = '') {
    const label = document.createElement('dt');
    label.textContent = term;
    const fact = document.createElement('dd');
    fact.textContent = value == null ? '' : String(value);
    if (className) fact.className = className;
    list.append(label, fact);
}

function laneText(agent) {
    if (!agent || agent.role === 'master' || agent.lanePosition == null) return '';
    return `${agent.lanePosition}, ${agent.originPort || ''} to ${agent.destinationPort || ''}, ${agent.sailingDate || ''}`;
}

function bookingCell(value) {
    const cell = document.createElement('td');
    if (value == null || value === '') return cell;
    cell.append(document.createTextNode(String(value)));
    const link = document.createElement('a');
    link.href = BOOKING_REQUESTS;
    link.setAttribute('href', BOOKING_REQUESTS);
    link.textContent = 'Booking requests';
    cell.append(document.createTextNode(' '), link);
    return cell;
}

export function renderRunTable(host, runs, { onOpen } = {}) {
    host.replaceChildren();
    const rows = Array.isArray(runs) ? runs : [];
    if (!rows.length) {
        host.append(paragraph('agent-empty', 'No runs yet.'));
        return;
    }
    const table = document.createElement('table');
    table.className = 'agent-grid swarm-run-table';
    const head = document.createElement('tr');
    for (const label of ['Swarm', 'Status', 'Started', 'Finished', 'Spend booked', 'Slots booked']) {
        head.append(textCell(label, 'th'));
    }
    head.append(textCell('', 'th'));
    const body = document.createElement('tbody');
    for (const run of rows) {
        const row = document.createElement('tr');
        row.append(
            textCell(run.swarmName || '', 'td', 'swarm-run-name'),
            textCell(run.status || '', 'td', 'swarm-run-status'),
            textCell(run.startedAt || '', 'td'),
            textCell(run.finishedAt || '', 'td'),
            textCell(againstCap(run.spendBooked, run.totalSpendCap), 'td'),
            textCell(againstCap(run.slotsBooked, run.totalSlotsCap), 'td')
        );
        const actions = document.createElement('td');
        actions.append(button('Open', () => {
            if (typeof onOpen === 'function') return onOpen(run);
        }, 'agent-button'));
        row.append(actions);
        body.append(row);
    }
    table.append(head, body);
    host.append(table);
}

export function renderRunDetail(host, run, { onCancel, showTokens } = {}) {
    host.replaceChildren();
    if (!run) return;
    const facts = document.createElement('dl');
    facts.className = 'agent-details swarm-run-facts';
    addFact(facts, 'Status', run.status || '');
    addFact(facts, 'Started', run.startedAt || '');
    addFact(facts, 'Finished', run.finishedAt || '');
    addFact(facts, 'Summary', run.summary || '', 'swarm-summary');
    addFact(facts, 'Failure reason', run.failureReason || '', 'swarm-failure-reason');
    addFact(facts, 'Spend', againstCap(run.spendBooked, run.totalSpendCap));
    addFact(facts, 'Slots', againstCap(run.slotsBooked, run.totalSlotsCap));
    addFact(facts, 'Master turns', run.masterTurns == null ? '' : String(run.masterTurns));
    if (showTokens === true) {
        addFact(facts, 'Input tokens', run.inputTokens == null ? '' : String(run.inputTokens), 'swarm-input-tokens');
        addFact(facts, 'Output tokens', run.outputTokens == null ? '' : String(run.outputTokens), 'swarm-output-tokens');
    }
    host.append(facts);
    if (run.status === 'running' && run.cancelRequested === true) {
        host.append(paragraph('swarm-cancel-requested', 'Cancel requested'));
    }
    if (typeof onCancel === 'function') {
        const actions = document.createElement('div');
        actions.className = 'agent-actions swarm-run-actions';
        actions.append(button('Cancel', () => onCancel(), 'agent-button'));
        host.append(actions);
    }
    const table = document.createElement('table');
    table.className = 'agent-grid swarm-agent-table';
    const head = document.createElement('tr');
    for (const label of ['Role', 'Lane', 'Attempt', 'Status', 'Started', 'Finished', 'Report', 'Rate id', 'Price', 'Slots', 'Booking request id']) {
        head.append(textCell(label, 'th'));
    }
    const body = document.createElement('tbody');
    const agents = Array.isArray(run.agents) ? run.agents : [];
    for (const agent of agents) {
        const row = document.createElement('tr');
        row.append(
            textCell(agent.role || '', 'td'),
            textCell(laneText(agent), 'td', 'swarm-agent-lane'),
            textCell(agent.attempt == null ? '' : String(agent.attempt), 'td'),
            textCell(agent.status || '', 'td'),
            textCell(agent.startedAt || '', 'td'),
            textCell(agent.finishedAt || '', 'td'),
            textCell(agent.report || '', 'td', 'swarm-report'),
            textCell(agent.rateId || '', 'td'),
            textCell(agent.price == null ? '' : String(agent.price), 'td'),
            textCell(agent.slots == null ? '' : String(agent.slots), 'td'),
            bookingCell(agent.bookingRequestId)
        );
        body.append(row);
    }
    table.append(head, body);
    host.append(table);
}
