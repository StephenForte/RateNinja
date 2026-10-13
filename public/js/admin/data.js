import { companyOperationGate } from '../confirm.js';
import { request } from '../api.js';
import { adminFailureMessage } from '../permissions.js';
import { errorBox, fieldLabel, heading, paragraph, textCell } from '../dom.js';

const PAGE_SIZE = 20;
const NOTICE_KEY = 'r108-notice';

const state = {
    dataset: 'rates',
    page: 1,
    total: 0,
    records: [],
    mode: 'none',
    ids: new Set(),
    filter: {}
};

let dialog;
let dialogErrors;
let editing = null;
let permissions = null;

function input(id, type = 'text') {
    const node = document.createElement('input');
    node.id = id;
    node.type = type;
    return node;
}

function button(id, text, className = 'save-btn') {
    const node = document.createElement('button');
    node.type = 'button';
    node.id = id;
    node.className = className;
    node.textContent = text;
    return node;
}

function readFilters() {
    const carrier = document.getElementById('dataFilterCarrier').value.trim();
    const from = document.getElementById('dataFilterFrom').value;
    const to = document.getElementById('dataFilterTo').value;
    if (state.dataset === 'rates') {
        return {
            origin: document.getElementById('dataFilterOrigin').value.trim(),
            destination: document.getElementById('dataFilterDestination').value.trim(),
            carrier,
            effectiveFrom: from,
            effectiveTo: to
        };
    }
    return {
        departurePort: document.getElementById('dataFilterOrigin').value.trim(),
        carrier,
        departureFrom: from,
        departureTo: to
    };
}

function queryString(filter, page) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
        if (value) params.set(key, value);
    }
    params.set('page', String(page));
    params.set('pageSize', String(PAGE_SIZE));
    return params.toString();
}

function selectionBanner() {
    const banner = document.getElementById('dataSelectionBanner');
    const pageCount = state.records.length;
    if (state.mode === 'all') {
        banner.className = 'data-banner data-banner-all';
        banner.textContent = `All ${state.total} matching ${state.dataset} are selected. This is not limited to this page (${pageCount} shown).`;
        return;
    }
    if (state.ids.size) {
        banner.className = 'data-banner data-banner-page';
        banner.textContent = `${state.ids.size} on this page selected. This is not all ${state.total} matching.`;
        return;
    }
    banner.className = 'data-banner';
    banner.textContent = 'No rows selected.';
}

function syncSelectAllLabel() {
    document.getElementById('dataSelectAll').textContent = `Select all ${state.total} matching`;
}

function renderRows() {
    const body = document.getElementById('dataTableBody');
    body.replaceChildren();
    const columns = state.dataset === 'rates' ? 9 : 7;
    if (!state.records.length) {
        const row = document.createElement('tr');
        const cell = textCell('No matching records');
        cell.colSpan = columns;
        row.append(cell);
        body.append(row);
        return;
    }
    for (const record of state.records) {
        const row = document.createElement('tr');
        const checkCell = document.createElement('td');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = state.mode === 'all' || state.ids.has(record.id);
        check.setAttribute('aria-label', `Select ${record.id}`);
        check.addEventListener('change', () => {
            if (state.mode === 'all') {
                state.mode = 'ids';
                state.ids = new Set(state.records.map(item => item.id));
            }
            if (check.checked) state.ids.add(record.id);
            else state.ids.delete(record.id);
            if (!state.ids.size) state.mode = 'none';
            else state.mode = 'ids';
            selectionBanner();
            renderRows();
        });
        checkCell.append(check);
        row.append(checkCell);
        if (state.dataset === 'rates') {
            row.append(
                textCell(record.originPort || ''),
                textCell(record.destinationPort || ''),
                textCell(record.carrier || ''),
                textCell(record.rateEffectiveDate || ''),
                textCell(record.rateExpirationDate || ''),
                textCell(record.rate20D ?? ''),
                textCell(record.rate40D ?? ''),
                textCell(record.rate40HC ?? '')
            );
        } else {
            row.append(
                textCell(record.carrier || ''),
                textCell(record.departurePort || ''),
                textCell(record.departure || ''),
                textCell(record.arrival || ''),
                textCell(record.vessel || '')
            );
        }
        const action = document.createElement('td');
        const edit = button('', 'Edit', 'back-btn');
        edit.addEventListener('click', () => openEdit(record));
        action.append(edit);
        row.append(action);
        body.append(row);
    }
}

function renderHistory(operations) {
    const body = document.getElementById('dataHistoryBody');
    body.replaceChildren();
    if (!operations.length) {
        const row = document.createElement('tr');
        const cell = textCell('No operations yet');
        cell.colSpan = 7;
        row.append(cell);
        body.append(row);
        return;
    }
    for (const operation of operations) {
        const row = document.createElement('tr');
        row.append(
            textCell(operation.type),
            textCell(operation.dataset),
            textCell(operation.actor?.displayName || operation.actor?.username || ''),
            textCell(operation.createdAt || ''),
            textCell(operation.company?.name || ''),
            textCell(String(operation.affectedCount))
        );
        const action = document.createElement('td');
        action.append(document.createTextNode(operation.status));
        if (operation.type === 'delete') {
            const restore = button('', 'Restore', 'back-btn');
            restore.addEventListener('click', () => restoreOperation(operation));
            action.append(document.createTextNode(' '), restore);
        }
        row.append(action);
        body.append(row);
    }
}

async function load() {
    const errors = document.getElementById('dataErrors');
    errors.hidden = true;
    state.filter = readFilters();
    const payload = await request(`/api/admin/data/${state.dataset}?${queryString(state.filter, state.page)}`);
    state.total = payload.total;
    state.records = payload.records;
    if (state.mode === 'ids') {
        const visible = new Set(state.records.map(record => record.id));
        state.ids = new Set([...state.ids].filter(id => visible.has(id)));
        if (!state.ids.size) state.mode = 'none';
    }
    document.getElementById('dataMatchCount').textContent = `Matching: ${payload.total}`;
    document.getElementById('dataPageInfo').textContent = `Page ${payload.page}`;
    document.getElementById('dataCompany').textContent = payload.company?.name || '';
    syncSelectAllLabel();
    selectionBanner();
    renderRows();
    const history = await request('/api/admin/data/operations');
    renderHistory(history.operations);
}

function showFailure(error) {
    const box = document.getElementById('dataErrors');
    box.hidden = false;
    box.textContent = adminFailureMessage(error, error.message);
}

function rememberNotice(text) {
    sessionStorage.setItem(NOTICE_KEY, text);
}

function showStoredNotice() {
    const text = sessionStorage.getItem(NOTICE_KEY);
    const note = document.getElementById('dataNotice');
    if (!text) {
        note.hidden = true;
        return;
    }
    sessionStorage.removeItem(NOTICE_KEY);
    note.hidden = false;
    note.textContent = text;
}

function finish(text) {
    rememberNotice(text);
    location.reload();
}

function selectedPayload() {
    if (state.mode === 'all') return { filter: state.filter };
    return { ids: [...state.ids] };
}

async function deleteSelection(ctx) {
    if (state.mode !== 'all' && !state.ids.size) {
        showFailure(new Error('Select this page or all matching records first.'));
        return;
    }
        const gate = companyOperationGate(permissions, 'Delete records.');
    if (!gate.allowed) {
        showFailure(new Error(gate.message));
        return;
    }
    try {
        const preview = await request('/api/admin/data/delete/preview', {
            method: 'POST',
            body: JSON.stringify({
                dataset: state.dataset,
                companyId: permissions.companyContext?.id,
                selection: selectedPayload()
            })
        });
        const summary = document.getElementById('dataPreview');
        summary.hidden = false;
        summary.textContent = `Delete preview: ${preview.count} ${preview.dataset} at ${preview.company.name}.`;
        const confirmGate = companyOperationGate(
            permissions,
            `Delete ${preview.count} ${preview.dataset}.`
        );
        if (!window.confirm(confirmGate.message)) return;
        await request('/api/admin/data/delete', {
            method: 'POST',
            body: JSON.stringify({
                previewId: preview.previewId,
                submissionId: crypto.randomUUID(),
                companyId: permissions.companyContext?.id
            })
        });
        finish(`Deleted ${preview.count} ${preview.dataset} at ${preview.company.name}.`);
    } catch (error) {
        showFailure(error);
    }
}

async function restoreOperation(operation) {
    const gate = companyOperationGate(permissions, `Restore ${operation.affectedCount} ${operation.dataset}.`);
    if (!gate.allowed) {
        showFailure(new Error(gate.message));
        return;
    }
    if (!window.confirm(gate.message)) return;
    try {
        const result = await request(`/api/admin/data/operations/${operation.id}/restore`, {
            method: 'POST',
            body: JSON.stringify({
                submissionId: crypto.randomUUID(),
                companyId: permissions.companyContext?.id
            })
        });
        finish(`Restored ${result.affectedCount} ${result.dataset} at ${result.company.name}.`);
    } catch (error) {
        showFailure(error);
    }
}

function setDialogField(id, value) {
    const node = document.getElementById(id);
    node.value = value ?? '';
}

function openEdit(record) {
    editing = record;
    dialogErrors.hide();
    document.getElementById('dataEditTitle').textContent = state.dataset === 'rates' ? 'Edit rate' : 'Edit sailing';
    const rateFields = document.getElementById('dataRateFields');
    const sailingFields = document.getElementById('dataSailingFields');
    rateFields.hidden = state.dataset !== 'rates';
    sailingFields.hidden = state.dataset === 'rates';
    if (state.dataset === 'rates') {
        setDialogField('editOrigin', record.originPort);
        setDialogField('editDestination', record.destinationPort);
        setDialogField('editCarrier', record.carrier);
        setDialogField('editEffective', record.rateEffectiveDate);
        setDialogField('editExpiration', record.rateExpirationDate);
        setDialogField('edit20', record.rate20D);
        setDialogField('edit40', record.rate40D);
        setDialogField('edit40hc', record.rate40HC);
        setDialogField('editRateType', record.rateType);
        setDialogField('editNotes', record.notes1);
    } else {
        setDialogField('editSailingCarrier', record.carrier);
        setDialogField('editDeparturePort', record.departurePort);
        setDialogField('editDeparture', record.departure ? String(record.departure).slice(0, 10) : '');
        setDialogField('editArrival', record.arrival ? String(record.arrival).slice(0, 10) : '');
        setDialogField('editVessel', record.vessel);
    }
    dialog.showModal();
}

function priceOrNull(id) {
    const text = document.getElementById(id).value.trim();
    if (!text) return null;
    return Number(text);
}

// The date input only edits the calendar day. Keep the stored time of day.
function withOriginalClock(original, dateValue) {
    if (!dateValue) return null;
    const source = original == null ? '' : String(original);
    const clock = source.slice(10);
    if (clock.startsWith('T')) return `${dateValue}${clock}`;
    return `${dateValue}T00:00:00.000Z`;
}

function editBody() {
    if (state.dataset === 'rates') {
        return {
            originPort: document.getElementById('editOrigin').value,
            destinationPort: document.getElementById('editDestination').value,
            carrier: document.getElementById('editCarrier').value,
            rateEffectiveDate: document.getElementById('editEffective').value,
            rateExpirationDate: document.getElementById('editExpiration').value,
            rate20D: priceOrNull('edit20'),
            rate40D: priceOrNull('edit40'),
            rate40HC: priceOrNull('edit40hc'),
            rateType: document.getElementById('editRateType').value,
            notes1: document.getElementById('editNotes').value,
            expectedRowVersion: editing.rowVersion,
            companyId: permissions.companyContext?.id
        };
    }
    const departure = document.getElementById('editDeparture').value;
    const arrival = document.getElementById('editArrival').value;
    return {
        carrier: document.getElementById('editSailingCarrier').value,
        departurePort: document.getElementById('editDeparturePort').value,
        departure: withOriginalClock(editing.departure, departure) || '',
        arrival: withOriginalClock(editing.arrival, arrival),
        vessel: document.getElementById('editVessel').value,
        expectedRowVersion: editing.rowVersion,
        companyId: permissions.companyContext?.id
    };
}

async function saveEdit() {
    dialogErrors.hide();
    try {
        await request(`/api/admin/data/${state.dataset}/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(editBody())
        });
        dialog.close();
        finish('Saved the record.');
    } catch (error) {
        dialogErrors.show(error.message);
    }
}

function buildDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'dataEditDialog';
    dialog.className = 'data-dialog';
    const title = document.createElement('h3');
    title.id = 'dataEditTitle';
    title.textContent = 'Edit';
    dialogErrors = errorBox();
    const rateFields = document.createElement('div');
    rateFields.id = 'dataRateFields';
    rateFields.className = 'data-form';
    const sailingFields = document.createElement('div');
    sailingFields.id = 'dataSailingFields';
    sailingFields.className = 'data-form';
    sailingFields.hidden = true;
    const rateInputs = [
        ['editOrigin', 'Origin', 'text'],
        ['editDestination', 'Destination', 'text'],
        ['editCarrier', 'Carrier', 'text'],
        ['editEffective', 'Effective', 'date'],
        ['editExpiration', 'Expiration', 'date'],
        ['edit20', '20D price', 'number'],
        ['edit40', '40D price', 'number'],
        ['edit40hc', '40HC price', 'number'],
        ['editRateType', 'Rate type', 'text'],
        ['editNotes', 'Notes', 'text']
    ];
    for (const [id, label, type] of rateInputs) {
        const node = input(id, type);
        if (type === 'number') {
            node.min = '0';
            node.step = 'any';
        }
        rateFields.append(fieldLabel(label, node));
    }
    const sailingInputs = [
        ['editSailingCarrier', 'Carrier', 'text'],
        ['editDeparturePort', 'Departure port', 'text'],
        ['editDeparture', 'Departure', 'date'],
        ['editArrival', 'Arrival', 'date'],
        ['editVessel', 'Vessel', 'text']
    ];
    for (const [id, label, type] of sailingInputs) {
        sailingFields.append(fieldLabel(label, input(id, type)));
    }
    const actions = document.createElement('div');
    actions.className = 'data-actions';
    const save = button('dataEditSave', 'Save');
    const cancel = button('dataEditCancel', 'Cancel', 'back-btn');
    save.addEventListener('click', saveEdit);
    cancel.addEventListener('click', () => dialog.close());
    actions.append(save, cancel);
    dialog.append(title, dialogErrors.box, rateFields, sailingFields, actions);
    return dialog;
}

function setDataset(dataset) {
    state.dataset = dataset;
    state.page = 1;
    state.mode = 'none';
    state.ids = new Set();
    document.getElementById('dataDatasetRates').setAttribute('aria-pressed', dataset === 'rates' ? 'true' : 'false');
    document.getElementById('dataDatasetSailings').setAttribute('aria-pressed', dataset === 'sailings' ? 'true' : 'false');
    document.getElementById('dataOriginLabel').textContent = dataset === 'rates' ? 'Origin' : 'Departure port';
    document.getElementById('dataDestinationWrap').hidden = dataset !== 'rates';
    document.getElementById('dataDateFromLabel').textContent = dataset === 'rates' ? 'Effective from' : 'Departure from';
    document.getElementById('dataDateToLabel').textContent = dataset === 'rates' ? 'Effective to' : 'Departure to';
    const head = document.getElementById('dataTableHead');
    head.replaceChildren();
    const labels = dataset === 'rates'
        ? ['', 'Origin', 'Destination', 'Carrier', 'Effective', 'Expiration', '20D', '40D', '40HC', '']
        : ['', 'Carrier', 'Departure port', 'Departure', 'Arrival', 'Vessel', ''];
    for (const label of labels) head.append(textCell(label, 'th'));
}

export async function mount(container, ctx) {
    permissions = ctx.permissions;
    container.replaceChildren();
    const workspace = document.createElement('div');
    workspace.id = 'dataWorkspace';
    workspace.className = 'data-workspace';
    const notice = document.createElement('p');
    notice.id = 'dataNotice';
    notice.className = 'data-notice';
    notice.hidden = true;
    const errors = document.createElement('p');
    errors.id = 'dataErrors';
    errors.className = 'error';
    errors.hidden = true;
    const company = document.createElement('p');
    company.id = 'dataCompany';
    company.className = 'data-company';
    const toggle = document.createElement('div');
    toggle.className = 'data-toolbar';
    const rates = button('dataDatasetRates', 'Rates');
    const sailings = button('dataDatasetSailings', 'Sailings', 'back-btn');
    rates.setAttribute('aria-pressed', 'true');
    sailings.setAttribute('aria-pressed', 'false');
    toggle.append(rates, sailings);
    const filters = document.createElement('div');
    filters.className = 'data-filters';
    const origin = input('dataFilterOrigin');
    const originLabel = document.createElement('span');
    originLabel.id = 'dataOriginLabel';
    originLabel.textContent = 'Origin';
    const originWrap = fieldLabel('', origin);
    originWrap.insertBefore(originLabel, origin);
    const destination = input('dataFilterDestination');
    const destinationWrap = fieldLabel('Destination', destination);
    destinationWrap.id = 'dataDestinationWrap';
    const carrier = input('dataFilterCarrier');
    const from = input('dataFilterFrom', 'date');
    const to = input('dataFilterTo', 'date');
    const fromLabel = document.createElement('span');
    fromLabel.id = 'dataDateFromLabel';
    fromLabel.textContent = 'Effective from';
    const fromWrap = fieldLabel('', from);
    fromWrap.insertBefore(fromLabel, from);
    const toLabel = document.createElement('span');
    toLabel.id = 'dataDateToLabel';
    toLabel.textContent = 'Effective to';
    const toWrap = fieldLabel('', to);
    toWrap.insertBefore(toLabel, to);
    const apply = button('dataApplyFilter', 'Filter', 'back-btn');
    filters.append(originWrap, destinationWrap, fieldLabel('Carrier', carrier), fromWrap, toWrap, apply);
    const match = document.createElement('p');
    match.id = 'dataMatchCount';
    match.textContent = 'Matching: 0';
    const banner = document.createElement('p');
    banner.id = 'dataSelectionBanner';
    banner.className = 'data-banner';
    banner.textContent = 'No rows selected.';
    const preview = document.createElement('p');
    preview.id = 'dataPreview';
    preview.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'data-actions';
    const selectPage = button('dataSelectPage', 'Select this page', 'back-btn');
    const selectAll = button('dataSelectAll', 'Select all 0 matching', 'back-btn');
    const clear = button('dataClearSelection', 'Clear selection', 'back-btn');
    const remove = button('dataDelete', 'Delete');
    actions.append(selectPage, selectAll, clear, remove);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const headRow = document.createElement('tr');
    headRow.id = 'dataTableHead';
    const head = document.createElement('thead');
    head.append(headRow);
    const body = document.createElement('tbody');
    body.id = 'dataTableBody';
    table.append(head, body);
    tableWrap.append(table);
    const pager = document.createElement('div');
    pager.className = 'data-toolbar';
    const prev = button('dataPrev', 'Previous page', 'back-btn');
    const next = button('dataNext', 'Next page', 'back-btn');
    const pageInfo = document.createElement('span');
    pageInfo.id = 'dataPageInfo';
    pageInfo.textContent = 'Page 1';
    pager.append(prev, pageInfo, next);
    const historyTitle = heading('History');
    historyTitle.id = 'dataHistoryTitle';
    const historyWrap = document.createElement('div');
    historyWrap.className = 'admin-table-container';
    const historyTable = document.createElement('table');
    historyTable.className = 'admin-table';
    const historyHead = document.createElement('tr');
    for (const label of ['Type', 'Dataset', 'Actor', 'Timestamp', 'Company', 'Affected', 'Status']) {
        historyHead.append(textCell(label, 'th'));
    }
    const historyHeadWrap = document.createElement('thead');
    historyHeadWrap.append(historyHead);
    const historyBody = document.createElement('tbody');
    historyBody.id = 'dataHistoryBody';
    historyTable.append(historyHeadWrap, historyBody);
    historyWrap.append(historyTable);
    workspace.append(
        heading('Data'),
        paragraph('pull-forward-subtitle', 'Search rates or sailings, then edit, delete, or restore them.'),
        notice,
        company,
        errors,
        toggle,
        filters,
        match,
        banner,
        preview,
        actions,
        tableWrap,
        pager,
        historyTitle,
        historyWrap,
        buildDialog()
    );
    container.append(workspace);
    setDataset('rates');
    rates.addEventListener('click', async () => {
        setDataset('rates');
        try { await load(); } catch (error) { showFailure(error); }
    });
    sailings.addEventListener('click', async () => {
        setDataset('sailings');
        try { await load(); } catch (error) { showFailure(error); }
    });
    apply.addEventListener('click', async () => {
        state.page = 1;
        state.mode = 'none';
        state.ids = new Set();
        try { await load(); } catch (error) { showFailure(error); }
    });
    selectPage.addEventListener('click', () => {
        state.ids = new Set(state.records.map(record => record.id));
        state.mode = state.ids.size ? 'ids' : 'none';
        selectionBanner();
        renderRows();
    });
    selectAll.addEventListener('click', () => {
        state.mode = 'all';
        state.ids = new Set();
        selectionBanner();
        renderRows();
    });
    clear.addEventListener('click', () => {
        state.mode = 'none';
        state.ids = new Set();
        selectionBanner();
        renderRows();
    });
    remove.addEventListener('click', () => deleteSelection(ctx));
    prev.addEventListener('click', async () => {
        if (state.page <= 1) return;
        state.page -= 1;
        state.mode = state.mode === 'all' ? 'all' : 'none';
        state.ids = new Set();
        try { await load(); } catch (error) { showFailure(error); }
    });
    next.addEventListener('click', async () => {
        if (state.page * PAGE_SIZE >= state.total) return;
        state.page += 1;
        state.mode = state.mode === 'all' ? 'all' : 'none';
        state.ids = new Set();
        try { await load(); } catch (error) { showFailure(error); }
    });
    showStoredNotice();
    try {
        await load();
    } catch (error) {
        showFailure(error);
    }
}

export function unmount() {
    editing = null;
    permissions = null;
    state.mode = 'none';
    state.ids = new Set();
    if (dialog && dialog.open) dialog.close();
}
