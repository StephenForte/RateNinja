import { heading, paragraph, textCell } from '../dom.js';
import { formatDollars } from '../money.js';
import { bookingLabel, laneResultsCsv, laneResultsFilename, latestAgent, resultText, searchLabel } from './run-csv.js';
import { formatDuration, formatWhen } from './time.js';

const BOOKING_REQUESTS = '/profile/booking-requests';

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

function againstCap(booked, cap, money = false) {
    const amount = booked == null ? '0' : String(booked);
    const limit = cap == null ? 'None' : String(cap);
    if (!money) return `${amount} / ${limit}`;
    const shownAmount = booked == null ? formatDollars(0, '0') : formatDollars(booked, amount);
    const shownLimit = cap == null ? 'None' : formatDollars(cap, limit);
    return `${shownAmount} / ${shownLimit}`;
}

function addFact(list, term, value, { className = '', title = '', fullWidth = false } = {}) {
    const item = document.createElement('div');
    if (fullWidth) item.className = 'swarm-run-fact-full';
    const fact = textCell(value == null ? '' : String(value), 'dd', className);
    if (title) fact.setAttribute('title', title);
    item.append(textCell(term, 'dt'), fact);
    list.append(item);
}

function timeOptions(time) {
    return time && typeof time === 'object' ? time : {};
}

function timeText(value, time) {
    return formatWhen(value, timeOptions(time));
}

function timedCell(value, time, tagName = 'td') {
    const when = timeText(value, time);
    const cell = textCell(when.text, tagName);
    if (when.title) cell.setAttribute('title', when.title);
    return cell;
}

function runDuration(run, time) {
    const options = timeOptions(time);
    const running = run.status === 'running' && (run.finishedAt == null || run.finishedAt === '');
    return formatDuration(run.startedAt, running ? null : run.finishedAt, options);
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

function statusCell(status) {
    const cell = document.createElement('td');
    const badge = document.createElement('span');
    const name = status || '';
    badge.className = name ? `agent-status agent-status-${name}` : 'agent-status';
    badge.textContent = name;
    cell.append(badge);
    return cell;
}

function scrollTable(table) {
    const wrap = document.createElement('div');
    wrap.className = 'agent-grid-scroll';
    wrap.append(table);
    return wrap;
}

function downloadLaneResults(run, parent) {
    const blob = new Blob([laneResultsCsv(run)], { type: 'text/csv' });
    const link = document.createElement('a');
    const filename = laneResultsFilename(run);
    link.download = filename;
    link.setAttribute('download', filename);
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(blob);
    link.href = url;
    parent.append(link);
    if (typeof link.click === 'function') link.click();
    link.remove();
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function bookingLaneCell(label) {
    const cell = document.createElement('td');
    cell.className = 'swarm-lane-booking';
    cell.append(document.createTextNode(label.text));
    if (!label.link) return cell;
    cell.append(document.createTextNode(' '));
    const link = document.createElement('a');
    link.href = BOOKING_REQUESTS;
    link.setAttribute('href', BOOKING_REQUESTS);
    link.textContent = 'Booking requests';
    cell.append(link);
    return cell;
}

function renderLaneTable(lanes, run) {
    const agents = Array.isArray(run.agents) ? run.agents : [];
    const title = heading(`Lane results (${lanes.length} lanes)`);
    title.className = 'swarm-lane-heading';
    const headingRow = document.createElement('div');
    headingRow.className = 'swarm-lane-heading-row';
    headingRow.append(title);
    if (lanes.length > 0) {
        headingRow.append(button('Download CSV', () => downloadLaneResults(run, headingRow), 'agent-button swarm-lane-csv'));
    }
    const table = document.createElement('table');
    table.className = 'agent-grid swarm-lane-table';
    const head = document.createElement('tr');
    for (const label of ['#', 'Lane', 'Sailing date', 'Container', 'Priority', 'Search', 'Price', 'Booking', 'Result']) {
        head.append(textCell(label, 'th'));
    }
    const body = document.createElement('tbody');
    for (const lane of lanes) {
        const search = latestAgent(agents, lane.position, 'search');
        const booking = latestAgent(agents, lane.position, 'booking');
        const row = document.createElement('tr');
        const price = search && search.price != null && search.price !== ''
            ? formatDollars(search.price, '')
            : '';
        const result = textCell(resultText(search, booking), 'td', 'swarm-lane-result');
        row.append(
            textCell(lane.position == null ? '' : String(lane.position), 'td'),
            textCell(`${lane.rateType || ''}, ${lane.originPort || ''} to ${lane.destinationPort || ''}`, 'td', 'swarm-lane-name'),
            textCell(lane.sailingDate || '', 'td'),
            textCell(lane.containerType || '', 'td'),
            textCell(lane.priority || '', 'td'),
            textCell(searchLabel(search, run.status), 'td', 'swarm-lane-search'),
            textCell(price, 'td', 'swarm-lane-price'),
            bookingLaneCell(bookingLabel(lane, booking)),
            result
        );
        body.append(row);
    }
    table.append(head, body);
    return [headingRow, scrollTable(table)];
}

export function renderRunTable(host, runs, { onOpen, time } = {}) {
    host.replaceChildren();
    const rows = Array.isArray(runs) ? runs : [];
    if (!rows.length) {
        host.append(paragraph('agent-empty', 'No runs yet.'));
        return;
    }
    const table = document.createElement('table');
    table.className = 'agent-grid swarm-run-table';
    const head = document.createElement('tr');
    for (const label of ['Swarm', 'Status', 'Started', 'Duration', 'Lanes', 'Spend booked', 'Slots booked']) {
        head.append(textCell(label, 'th'));
    }
    head.append(textCell('', 'th'));
    const body = document.createElement('tbody');
    for (const run of rows) {
        const row = document.createElement('tr');
        row.append(
            textCell(run.swarmName || '', 'td', 'swarm-run-name'),
            statusCell(run.status || ''),
            timedCell(run.startedAt, time),
            textCell(runDuration(run, time), 'td', 'swarm-run-duration'),
            textCell(run.laneCount == null ? '' : String(run.laneCount), 'td', 'swarm-run-lanes'),
            textCell(againstCap(run.spendBooked, run.totalSpendCap, true), 'td'),
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

export function renderRunDetail(host, run, { onCancel, showTokens, time } = {}) {
    host.replaceChildren();
    if (!run) return;
    const facts = document.createElement('dl');
    facts.className = 'agent-details swarm-run-facts';
    const started = timeText(run.startedAt, time);
    const finished = timeText(run.finishedAt, time);
    addFact(facts, 'Status', run.status || '');
    addFact(facts, 'Started', started.text, { title: started.title });
    addFact(facts, 'Finished', finished.text, { title: finished.title });
    addFact(facts, 'Duration', runDuration(run, time), { className: 'swarm-run-duration' });
    addFact(facts, 'Summary', run.summary || '', { className: 'swarm-summary', fullWidth: true });
    addFact(facts, 'Failure reason', run.failureReason || '', { className: 'swarm-failure-reason', fullWidth: true });
    addFact(facts, 'Spend', againstCap(run.spendBooked, run.totalSpendCap, true));
    addFact(facts, 'Slots', againstCap(run.slotsBooked, run.totalSlotsCap));
    addFact(facts, 'Master turns', run.masterTurns == null ? '' : String(run.masterTurns));
    if (showTokens === true) {
        addFact(facts, 'Input tokens', run.inputTokens, { className: 'swarm-input-tokens' });
        addFact(facts, 'Output tokens', run.outputTokens, { className: 'swarm-output-tokens' });
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
    if (Array.isArray(run.lanes)) host.append(...renderLaneTable(run.lanes, run));
    const activity = heading('Agent activity');
    activity.className = 'swarm-agent-heading';
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
            timedCell(agent.startedAt, time),
            timedCell(agent.finishedAt, time),
            textCell(agent.report || '', 'td', 'swarm-report'),
            textCell(agent.rateId || '', 'td'),
            textCell(agent.price == null || agent.price === '' ? '' : formatDollars(agent.price, ''), 'td'),
            textCell(agent.slots == null ? '' : String(agent.slots), 'td'),
            bookingCell(agent.bookingRequestId)
        );
        body.append(row);
    }
    table.append(head, body);
    host.append(activity, scrollTable(table));
}
