import { request } from '../api.js';
import { RATE_FIELDS, summarizeView } from './grouping.js';

let host = null;
let views = [];
let fields = RATE_FIELDS.map(field => ({ ...field }));
let pageSizes = [20, 50, 100];
let maxGroupFields = 2;
let maxSortRules = 3;
let select;
let nameInput;
let options;
let optionsButton;
let columnList;
let groupSlots = [];
let sortSlots = [];
let pageSizeSelect;
let status;
let syncing = false;
let defaultId = '';

function button(id, text) {
    const node = document.createElement('button');
    node.type = 'button';
    node.id = id;
    node.className = 'rates-preference-btn';
    node.textContent = text;
    return node;
}

function setStatus(message, isError) {
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('rates-preference-error', Boolean(isError));
}

function selected() {
    return views.find(view => view.id === select.value) || null;
}

function fieldOptions(selectedId, allowEmpty) {
    const fragment = document.createDocumentFragment();
    if (allowEmpty) fragment.append(new Option('None', ''));
    fields.forEach(field => {
        const option = new Option(field.label, field.id);
        if (field.id === selectedId) option.selected = true;
        fragment.append(option);
    });
    return fragment;
}

function readView() {
    const current = host.view();
    const columnOrder = [...columnList.querySelectorAll('[data-column]')].map(node => node.dataset.column);
    const hiddenColumns = [...columnList.querySelectorAll('[data-column]')].filter(node => !node.checked).map(node => node.dataset.column);
    const groupBy = [];
    groupSlots.forEach(slot => {
        if (slot.value && !groupBy.includes(slot.value)) groupBy.push(slot.value);
    });
    const sort = [];
    sortSlots.forEach(slot => {
        if (!slot.field.value || sort.some(rule => rule.field === slot.field.value)) return;
        sort.push({ field: slot.field.value, direction: slot.direction.value === 'desc' ? 'desc' : 'asc' });
    });
    return {
        columnOrder: columnOrder.length ? columnOrder : current.columnOrder,
        hiddenColumns,
        groupBy,
        sort,
        pageSize: Number(pageSizeSelect.value) || current.pageSize
    };
}

function publish() {
    if (syncing) return;
    host.setView(readView());
    host.setSummary(summarizeView(host.view(), fields));
}

function paintColumns(view) {
    columnList.replaceChildren();
    const hidden = new Set(view.hiddenColumns || []);
    const order = view.columnOrder && view.columnOrder.length ? view.columnOrder : fields.map(field => field.id);
    order.forEach((id, index) => {
        const field = fields.find(item => item.id === id);
        if (!field) return;
        const row = document.createElement('div');
        row.className = 'rates-column-row';
        const up = button('', 'Up');
        up.disabled = index === 0;
        up.addEventListener('click', () => moveColumn(id, -1));
        const down = button('', 'Down');
        down.disabled = index === order.length - 1;
        down.addEventListener('click', () => moveColumn(id, 1));
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.column = id;
        box.checked = !hidden.has(id);
        box.addEventListener('change', publish);
        label.append(box, document.createTextNode(` ${field.label}`));
        row.append(up, down, label);
        columnList.append(row);
    });
}

function moveColumn(id, direction) {
    const view = readView();
    const index = view.columnOrder.indexOf(id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= view.columnOrder.length) return;
    const order = view.columnOrder.slice();
    const [moved] = order.splice(index, 1);
    order.splice(next, 0, moved);
    view.columnOrder = order;
    host.setView(view);
    paintColumns(view);
    host.setSummary(summarizeView(view, fields));
}

function paintChoices(view) {
    syncing = true;
    groupSlots.forEach((slot, index) => {
        const value = view.groupBy[index] || '';
        slot.replaceChildren(fieldOptions(value, true));
        slot.value = value;
    });
    sortSlots.forEach((slot, index) => {
        const rule = view.sort[index];
        slot.field.replaceChildren(fieldOptions(rule ? rule.field : '', true));
        slot.field.value = rule ? rule.field : '';
        slot.direction.value = rule && rule.direction === 'desc' ? 'desc' : 'asc';
    });
    pageSizeSelect.value = String(view.pageSize);
    syncing = false;
}

export function syncViewControls(view) {
    if (!columnList) return;
    paintColumns(view);
    paintChoices(view);
    const match = views.find(item => item.id === select.value);
    if (match && match.name) nameInput.value = match.name;
}

function fillSelect(selectedId) {
    syncing = true;
    const current = selectedId === undefined ? select.value : selectedId;
    select.replaceChildren(new Option('Standard view', ''));
    views.forEach(view => {
        const suffix = view.needsAttention ? ' (needs attention)' : '';
        const star = view.isDefault ? ' · default' : '';
        select.add(new Option(`${view.name}${star}${suffix}`, view.id));
    });
    if (views.some(view => view.id === current)) select.value = current;
    else select.value = '';
    syncing = false;
    defaultId = (views.find(view => view.isDefault) || {}).id || '';
}

async function reload(selectedId) {
    const payload = await request('/api/preferences/views');
    views = payload.views || [];
    fillSelect(selectedId);
}

function applyRecord(view) {
    host.setView(view.view, {
        id: view.id,
        isDefault: view.isDefault,
        needsAttention: view.needsAttention
    });
    syncViewControls(view.view);
    host.setSummary(summarizeView(view.view, fields));
    if (view.needsAttention) setStatus('This view needs attention. A column is no longer available and was removed.', true);
    else setStatus('', false);
}

export function mountViews(container, nextHost) {
    host = nextHost;
    const row = document.createElement('div');
    row.className = 'rates-preference-row';
    const label = document.createElement('label');
    label.textContent = 'View ';
    select = document.createElement('select');
    select.id = 'savedViewSelect';
    select.setAttribute('aria-label', 'Saved views');
    label.append(select);
    nameInput = document.createElement('input');
    nameInput.id = 'savedViewName';
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.placeholder = 'View name';
    nameInput.setAttribute('aria-label', 'View name');
    const save = button('saveViewBtn', 'Save');
    const update = button('updateViewBtn', 'Update');
    const rename = button('renameViewBtn', 'Rename');
    const remove = button('deleteViewBtn', 'Delete');
    const makeDefault = button('setDefaultViewBtn', 'Set default');
    const clearDefault = button('clearDefaultViewBtn', 'Clear default');
    optionsButton = button('viewOptionsBtn', 'Columns and grouping');
    optionsButton.setAttribute('aria-expanded', 'false');
    optionsButton.setAttribute('aria-controls', 'viewOptions');
    row.append(label, nameInput, save, update, rename, remove, makeDefault, clearDefault, optionsButton);

    options = document.createElement('div');
    options.id = 'viewOptions';
    options.hidden = true;
    columnList = document.createElement('div');
    columnList.id = 'columnList';
    columnList.className = 'rates-column-list';
    const groupBlock = document.createElement('div');
    groupBlock.className = 'rates-rule-block';
    const sortBlock = document.createElement('div');
    sortBlock.className = 'rates-rule-block';
    const pageLabel = document.createElement('label');
    pageLabel.textContent = 'Page size ';
    pageSizeSelect = document.createElement('select');
    pageSizeSelect.id = 'pageSizeSelect';
    pageSizeSelect.setAttribute('aria-label', 'Page size');
    pageLabel.append(pageSizeSelect);
    options.append(columnList, groupBlock, sortBlock, pageLabel);

    status = document.createElement('p');
    status.id = 'viewStatus';
    status.className = 'rates-preference-status';
    status.hidden = true;
    container.append(row, options, status);

    buildSlots(groupBlock, sortBlock);
    select.addEventListener('change', () => {
        if (syncing) return;
        const view = selected();
        if (!view) {
            host.restoreStandard();
            syncViewControls(host.view());
            host.setSummary(summarizeView(host.view(), fields));
            setStatus('', false);
            return;
        }
        nameInput.value = view.name;
        applyRecord(view);
    });
    optionsButton.addEventListener('click', () => {
        options.hidden = !options.hidden;
        optionsButton.setAttribute('aria-expanded', String(!options.hidden));
    });
    save.addEventListener('click', () => storeView(false));
    update.addEventListener('click', () => storeView(true));
    rename.addEventListener('click', () => renameView());
    remove.addEventListener('click', () => deleteView());
    makeDefault.addEventListener('click', () => setDefault(false));
    clearDefault.addEventListener('click', () => setDefault(true));
    syncViewControls(host.view());
}

function buildSlots(groupBlock, sortBlock) {
    groupSlots = [];
    sortSlots = [];
    groupBlock.replaceChildren();
    sortBlock.replaceChildren();
    for (let index = 0; index < maxGroupFields; index += 1) {
        const label = document.createElement('label');
        label.textContent = index === 0 ? 'Group by ' : 'Then ';
        const slot = document.createElement('select');
        slot.id = `groupField${index}`;
        slot.setAttribute('aria-label', index === 0 ? 'Group by' : 'Then group by');
        slot.addEventListener('change', publish);
        label.append(slot);
        groupBlock.append(label);
        groupSlots.push(slot);
    }
    for (let index = 0; index < maxSortRules; index += 1) {
        const label = document.createElement('label');
        label.textContent = index === 0 ? 'Sort by ' : 'Then ';
        const field = document.createElement('select');
        field.id = `sortField${index}`;
        field.setAttribute('aria-label', index === 0 ? 'Sort by' : 'Then sort by');
        const direction = document.createElement('select');
        direction.id = `sortDir${index}`;
        direction.setAttribute('aria-label', `Sort direction ${index + 1}`);
        direction.append(new Option('Ascending', 'asc'), new Option('Descending', 'desc'));
        field.addEventListener('change', publish);
        direction.addEventListener('change', publish);
        label.append(field, direction);
        sortBlock.append(label);
        sortSlots.push({ field, direction });
    }
    pageSizeSelect.replaceChildren();
    pageSizes.forEach(size => pageSizeSelect.add(new Option(String(size), String(size))));
    pageSizeSelect.onchange = publish;
}

export async function loadViews() {
    try {
        const catalog = await request('/api/preferences/fields');
        fields = catalog.fields;
        pageSizes = catalog.pageSizes;
        maxGroupFields = catalog.maxGroupFields;
        maxSortRules = catalog.maxSortRules;
        const groupBlock = options.querySelector('.rates-rule-block');
        const blocks = options.querySelectorAll('.rates-rule-block');
        buildSlots(blocks[0] || groupBlock, blocks[1]);
        await reload(host.activeViewId());
        const current = views.find(view => view.id === host.activeViewId());
        if (host.activeViewId() && !current) host.restoreStandard();
        else if (current && host.noteAttention) host.noteAttention(current.needsAttention);
        syncViewControls(host.view());
        host.setSummary(summarizeView(host.view(), fields));
        if (host.viewAttention()) setStatus('This view needs attention. A column is no longer available and was removed.', true);
    } catch (error) {
        setStatus(error.message, true);
    }
}

export function refreshViewControls() {
    syncViewControls(host.view());
    host.setSummary(summarizeView(host.view(), fields));
}

async function storeView(overwrite) {
    const current = selected();
    const name = nameInput.value.trim();
    const view = options.hidden ? host.view() : readView();
    host.setView(view);
    try {
        if (overwrite) {
            if (!current) {
                setStatus('Choose a view to update.', true);
                return;
            }
            const payload = await request(`/api/preferences/views/${encodeURIComponent(current.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ view })
            });
            await reload(payload.view.id);
            applyRecord(payload.view);
            setStatus('View updated.', false);
            return;
        }
        if (!name) {
            setStatus('Enter a name, then save.', true);
            return;
        }
        const payload = await request('/api/preferences/views', {
            method: 'POST',
            body: JSON.stringify({ name, view })
        });
        await reload(payload.view.id);
        nameInput.value = payload.view.name;
        host.setActiveView(payload.view.id, payload.view.isDefault);
        setStatus('View saved.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function renameView() {
    const current = selected();
    const name = nameInput.value.trim();
    if (!current) {
        setStatus('Choose a view to rename.', true);
        return;
    }
    if (!name) {
        setStatus('Enter the new name.', true);
        return;
    }
    try {
        const payload = await request(`/api/preferences/views/${encodeURIComponent(current.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        });
        await reload(payload.view.id);
        setStatus('View renamed.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function deleteView() {
    const current = selected();
    if (!current) {
        setStatus('Choose a view to delete.', true);
        return;
    }
    const active = current.id === host.activeViewId();
    try {
        await request(`/api/preferences/views/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
        if (current.id === defaultId) defaultId = '';
        await reload('');
        nameInput.value = '';
        if (active) {
            host.restoreStandard();
            syncViewControls(host.view());
            host.setSummary(summarizeView(host.view(), fields));
        }
        setStatus('View deleted.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function setDefault(clear) {
    const current = selected();
    if (!clear && !current) {
        setStatus('Choose a view to use as the default.', true);
        return;
    }
    try {
        await request('/api/preferences/default-view', {
            method: 'PUT',
            body: JSON.stringify({ id: clear ? null : current.id })
        });
        await reload(clear ? select.value : current.id);
        setStatus(clear ? 'Default view cleared.' : 'Default view saved. It loads on the next visit.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}
