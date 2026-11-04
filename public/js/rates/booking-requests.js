import { request } from '../api.js';
import { errorBox, heading, paragraph } from '../dom.js';
import { refreshBookingNotifications } from '../booking-notifications.js';

const SIZES = [
    ['20D', '20\''],
    ['40D', '40\''],
    ['40HC', '40HC']
];

let alive = true;
let dialogBound = false;
let sending = false;
let listHost = null;
let pageError = null;

function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number);
}

function sizeChoices(rate) {
    return SIZES
        .map(([id, label]) => ({ id, label, price: rate[id === '20D' ? 'rate20D' : id === '40D' ? 'rate40D' : 'rate40HC'] }))
        .filter(choice => choice.price !== null && choice.price !== undefined && choice.price !== '' && Number.isFinite(Number(choice.price)));
}

function rateIsExpired(rate) {
    const value = rate?.rateExpirationDate;
    if (value == null || value === '' || value === 'N/A') return false;
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return true;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return true;
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return date.getTime() < todayUtc;
}

function showMessage(text, kind) {
    const message = document.getElementById('bookingDialogMessage');
    if (!message) return;
    message.textContent = text || '';
    message.classList.toggle('is-error', kind === 'error');
    message.classList.toggle('is-success', kind === 'success');
}

function bindDialog() {
    if (dialogBound) return;
    dialogBound = true;
    const dialog = document.getElementById('bookingDialog');
    const form = document.getElementById('bookingDialogForm');
    document.getElementById('bookingDialogClose').addEventListener('click', closeBookingDialog);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) closeBookingDialog();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (sending) return;
        const rateId = form.dataset.rateId || '';
        const slots = Number(document.getElementById('bookingDialogSlots').value);
        const containerSize = document.getElementById('bookingDialogSize').value;
        if (!Number.isInteger(slots) || slots < 1) {
            showMessage('Enter a whole number of slots.', 'error');
            return;
        }
        sending = true;
        const submit = document.getElementById('bookingDialogSubmit');
        submit.disabled = true;
        showMessage('', '');
        try {
            await request('/api/booking-requests', {
                method: 'POST',
                body: JSON.stringify({ rateId, containerSize, slots })
            });
            showMessage('Booking requested.', 'success');
            refreshBookingNotifications();
        } catch (error) {
            showMessage(error.message || 'Booking request failed.', 'error');
            submit.disabled = false;
        } finally {
            sending = false;
        }
    });
}

export function closeBookingDialog() {
    const dialog = document.getElementById('bookingDialog');
    if (dialog) dialog.hidden = true;
    sending = false;
}

export function openBookingDialog(rate) {
    bindDialog();
    const dialog = document.getElementById('bookingDialog');
    const form = document.getElementById('bookingDialogForm');
    const summary = document.getElementById('bookingDialogSummary');
    const select = document.getElementById('bookingDialogSize');
    const slots = document.getElementById('bookingDialogSlots');
    const submit = document.getElementById('bookingDialogSubmit');
    if (!dialog || !form || !rate || rate.predictive || rateIsExpired(rate)) return;
    const choices = sizeChoices(rate);
    form.dataset.rateId = rate.id || '';
    const route = `${rate.originPort || 'N/A'} → ${rate.destinationPort || 'N/A'}`;
    const owner = rate.ownerCompanyName || rate.contractOwner || '';
    summary.textContent = [rate.carrier, route, owner].filter(Boolean).join(' · ');
    select.replaceChildren();
    choices.forEach(choice => {
        const option = document.createElement('option');
        option.value = choice.id;
        option.textContent = `${choice.label} · ${money(choice.price)}`;
        select.append(option);
    });
    slots.value = '1';
    submit.disabled = choices.length === 0;
    showMessage(choices.length ? '' : 'This rate has no priced container size.', choices.length ? '' : 'error');
    dialog.hidden = false;
    if (choices.length) select.focus();
}

function cell(text, className) {
    const node = document.createElement('td');
    node.textContent = text ?? '';
    if (className) node.className = className;
    return node;
}

function statusLabel(status) {
    if (status === 'approved') return 'Approved';
    if (status === 'declined') return 'Declined';
    return 'Pending';
}

function renderRequests(body, requests) {
    const ownerView = requests.some(item => item.side === 'owner');
    const table = document.createElement('table');
    table.className = 'booking-requests-table';
    const head = document.createElement('tr');
    const headers = ['Route', 'Carrier', 'Size', 'Slots', 'Price', 'Status'];
    if (ownerView) headers.push('Requested by', '');
    headers.forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        if (!label) th.setAttribute('aria-label', 'Decision');
        head.append(th);
    });
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    if (!requests.length) {
        const row = document.createElement('tr');
        const empty = cell('No booking requests yet.');
        empty.colSpan = headers.length;
        row.append(empty);
        tbody.append(row);
    }
    requests.forEach(item => {
        const row = document.createElement('tr');
        if (item.unread) row.className = 'booking-request-unread';
        const route = `${item.originPort || 'N/A'} → ${item.destinationPort || 'N/A'}`;
        const status = document.createElement('td');
        status.textContent = statusLabel(item.status);
        if (item.unread) {
            const mark = document.createElement('span');
            mark.className = 'booking-unread-mark';
            mark.textContent = 'Unread';
            status.append(document.createTextNode(' '), mark);
        }
        row.append(
            cell(route),
            cell(item.carrier || 'N/A'),
            cell(item.containerSize),
            cell(String(item.slots)),
            cell(money(item.customerPrice)),
            status
        );
        if (ownerView) {
            row.append(cell(item.requestedBy?.name || ''));
            const actions = document.createElement('td');
            if (item.side === 'owner' && item.status === 'pending') {
                actions.append(decisionButton(item.id, 'approved', 'Approve'), decisionButton(item.id, 'declined', 'Decline'));
            }
            row.append(actions);
        }
        tbody.append(row);
    });
    table.append(thead, tbody);
    body.replaceChildren(table);
}

function decisionButton(id, decision, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = decision === 'approved' ? 'booking-approve' : 'booking-decline';
    button.textContent = label;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await request(`/api/booking-requests/${encodeURIComponent(id)}/decision`, {
                method: 'POST',
                body: JSON.stringify({ decision })
            });
            await reload();
        } catch (error) {
            if (pageError) pageError.show(error.message);
            button.disabled = false;
        }
    });
    return button;
}

async function reload() {
    if (!listHost) return;
    const payload = await request('/api/booking-requests');
    if (!alive) return;
    renderRequests(listHost, payload.requests || []);
    await request('/api/booking-requests/read', { method: 'POST', body: JSON.stringify({}) });
    if (pageError) pageError.hide();
    refreshBookingNotifications();
}

export async function mount(container) {
    alive = true;
    container.replaceChildren();
    pageError = errorBox();
    listHost = document.createElement('div');
    listHost.className = 'booking-requests';
    container.append(
        heading('Booking requests'),
        paragraph('pull-forward-subtitle', 'Approval does not reserve capacity. Rate and sailing records are not evidence of allocatable or transferable capacity.'),
        listHost,
        pageError.box
    );
    try {
        await reload();
    } catch (error) {
        if (!alive) return;
        pageError.show(error.message || 'Could not load booking requests.');
    }
}

export function unmount() {
    alive = false;
    listHost = null;
    pageError = null;
    closeBookingDialog();
}
