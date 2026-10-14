import { companyOperationGate } from '../confirm.js';
import { request } from '../api.js';

const STEPS = ['dataset', 'upload', 'sheet', 'inspect', 'mapping', 'conversions', 'validate', 'review', 'commit'];
const STEP_LABELS = {
    dataset: 'Dataset',
    upload: 'Upload',
    sheet: 'Sheet',
    inspect: 'Inspect',
    mapping: 'Mapping',
    conversions: 'Conversions',
    validate: 'Validate',
    review: 'Review',
    commit: 'Commit'
};
const HEADER_TARGETS = {
    'Rate Type': 'rateType',
    'Origin Port': 'originPort',
    'Destination Port/Via Port': 'destinationPort',
    'Inland Delivery Location': 'inlandDeliveryLocation',
    Carrier: 'carrier',
    'Contract Number': 'contractNumber',
    'Contract Owner': 'contractOwner',
    '20D Rate': 'rate20D',
    '40D rate': 'rate40D',
    '40HC Rate': 'rate40HC',
    'Effective Date': 'rateEffectiveDate',
    'Expiry Date': 'rateExpirationDate',
    'Notes 1': 'notes1',
    'Transit Time': 'transitTime',
    Departure: 'departure',
    Arrival: 'arrival',
    'Departure Port': 'departurePort',
    'Arrival Port': 'arrivalPort',
    Voyage: 'voyage',
    Service: 'service',
    Vessel: 'vessel'
};
const NUMBERS_MESSAGE = 'Apple Numbers files are not supported. Export the file to Excel (.xlsx). Round 1 imports accept CSV and Excel (.xlsx) only.';

const state = {
    step: 'dataset',
    dataset: 'rates',
    limits: null,
    upload: null,
    detail: null,
    dateOrder: '',
    validation: null,
    suggestions: null,
    excluded: new Set(),
    confirmedSample: false
};

let permissions = null;
let root = null;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function button(label, className = '') {
    const node = el('button', `button ${className}`.trim(), label);
    node.type = 'button';
    return node;
}

function showError(message) {
    const node = root.querySelector('.import-error');
    node.hidden = !message;
    node.textContent = message || '';
}

async function fail(error) {
    showError(error.message || 'The import could not continue.');
}

function mappingFromControls() {
    return [...root.querySelectorAll('[data-source]')].map(select => ({
        source: select.dataset.source,
        target: select.value || null
    }));
}

function seedMapping(headers, targets) {
    const used = new Set();
    return headers.map(header => {
        const target = HEADER_TARGETS[header] || null;
        const allowed = target && targets.some(item => item.id === target) && !used.has(target);
        if (allowed) used.add(target);
        return { source: header, target: allowed ? target : null };
    });
}

function currentMapping() {
    if (root && root.querySelector('[data-source]')) return mappingFromControls();
    if (state.mapping) return state.mapping;
    if (state.detail) return seedMapping(state.detail.headers, state.detail.targets);
    return [];
}

function render() {
    root.replaceChildren();
    const shell = el('div', 'import-wizard');
    shell.append(el('h2', '', 'Imports'));
    const steps = el('ol', 'import-steps');
    for (const step of STEPS) {
        const item = el('li', step === state.step ? 'is-current' : '', STEP_LABELS[step]);
        steps.append(item);
    }
    shell.append(steps);
    const error = el('p', 'import-error error');
    error.hidden = true;
    shell.append(error);
    const panel = el('div', 'import-panel');
    shell.append(panel);
    root.append(shell);
    const draw = {
        dataset: drawDataset,
        upload: drawUpload,
        sheet: drawSheet,
        inspect: drawInspect,
        mapping: drawMapping,
        conversions: drawConversions,
        validate: drawValidate,
        review: drawReview,
        commit: drawCommit
    };
    draw[state.step](panel);
}

function drawDataset(panel) {
    panel.append(el('p', '', 'Choose what this file contains. Rates is the usual import. Sailings uses the same steps.'));
    const rates = button('Rates', state.dataset === 'rates' ? '' : 'back-btn');
    const sailings = button('Sailings', state.dataset === 'sailings' ? '' : 'back-btn');
    rates.addEventListener('click', () => { state.dataset = 'rates'; render(); });
    sailings.addEventListener('click', () => { state.dataset = 'sailings'; render(); });
    const actions = el('div', 'import-actions');
    actions.append(rates, sailings);
    panel.append(actions);
    panel.append(el('p', 'import-note', `Required rate fields are origin, destination, carrier, both dates, and at least one USD price. Required sailing fields are carrier, departure port, and departure. Contract number and arrival port are optional. ${NUMBERS_MESSAGE}`));
    const templates = el('p', '');
    const rateLink = el('a', '', 'Rates template');
    rateLink.href = '/templates/rates.csv';
    rateLink.download = 'rates.csv';
    const sailingLink = el('a', '', 'Sailings template');
    sailingLink.href = '/templates/sailings.csv';
    sailingLink.download = 'sailings.csv';
    const fieldsLink = el('a', '', 'Which fields are optional');
    fieldsLink.href = '/templates/fields.txt';
    templates.append(rateLink, el('span', '', ' · '), sailingLink, el('span', '', ' · '), fieldsLink);
    panel.append(templates);
    const next = button('Continue');
    next.addEventListener('click', () => { state.step = 'upload'; render(); });
    panel.append(next);
}

function drawUpload(panel) {
    const limits = state.limits;
    if (!limits) {
        panel.append(el('p', '', 'Loading limits…'));
        return;
    }
    panel.append(el('p', '', `Limits for ${limits.company.name}: files up to ${limits.maxBytes.toLocaleString('en-US')} bytes, ${limits.maxRows.toLocaleString('en-US')} data rows, and a Claude sample of ${limits.sampleRows} rows or ${limits.sampleChars.toLocaleString('en-US')} characters. Uploads are deleted after commit, cancel, or ${limits.retentionHours} hours.`));
    panel.append(el('p', 'import-note', NUMBERS_MESSAGE));
    const input = el('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const upload = button('Upload');
    upload.addEventListener('click', async () => {
        const file = input.files && input.files[0];
        if (!file) {
            showError('Choose a CSV or Excel file.');
            return;
        }
        showError('');
        try {
            state.upload = await request('/api/admin/imports/uploads', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Import-Filename': file.name,
                    'X-Import-Dataset': state.dataset
                },
                body: file
            });
            state.step = 'sheet';
            render();
        } catch (error) {
            fail(error);
        }
    });
    panel.append(input, upload);
}

function drawSheet(panel) {
    const upload = state.upload;
    panel.append(el('p', '', `${upload.filename} (${upload.byteSize.toLocaleString('en-US')} bytes). Non-data sheets are ignored.`));
    const dataSheets = upload.sheets.filter(sheet => sheet.data && !sheet.ignored);
    if (!dataSheets.length) {
        panel.append(el('p', '', 'This file has no data sheet.'));
        return;
    }
    const select = el('select');
    select.id = 'importSheet';
    for (const sheet of dataSheets) {
        const option = el('option', '', sheet.name);
        option.value = sheet.name;
        if (sheet.name === upload.suggestedSheet) option.selected = true;
        select.append(option);
    }
    if (upload.requireSheetChoice) panel.append(el('p', '', 'More than one sheet could be the table, or none matched the required headers. Choose the sheet to import.'));
    else panel.append(el('p', '', `Suggested sheet: ${upload.suggestedSheet}.`));
    const next = button('Use this sheet');
    next.addEventListener('click', async () => {
        try {
            state.detail = await request(`/api/admin/imports/${state.upload.jobId}/sheet`, {
                method: 'POST',
                body: JSON.stringify({ sheetName: select.value, companyId: permissions.companyContext?.id })
            });
            state.confirmedSample = false;
            state.suggestions = null;
            state.step = 'inspect';
            render();
        } catch (error) {
            fail(error);
        }
    });
    panel.append(select, next);
}

function drawInspect(panel) {
    const detail = state.detail;
    panel.append(el('p', '', `${detail.sheetName}: ${detail.rowCount.toLocaleString('en-US')} data rows. Cells are read by their header, not by column position.`));
    const table = el('table', 'import-table');
    const head = el('tr');
    head.append(el('th', '', 'Row'));
    for (const header of detail.headers) head.append(el('th', '', header));
    table.append(head);
    for (const row of detail.preview) {
        const line = el('tr');
        line.append(el('td', '', String(row.row)));
        for (const cell of row.cells) line.append(el('td', '', cell == null ? '—' : String(cell)));
        table.append(line);
    }
    panel.append(table);
    const next = button('Map columns');
    next.addEventListener('click', () => { state.step = 'mapping'; render(); });
    panel.append(next);
}

function mappingSelect(header, targets, selected) {
    const select = el('select');
    select.dataset.source = header;
    const empty = el('option', '', 'Do not import');
    empty.value = '';
    select.append(empty);
    for (const target of targets) {
        const option = el('option', '', `${target.label}${target.required ? ' (required)' : ''}`);
        option.value = target.id;
        if (target.id === selected) option.selected = true;
        select.append(option);
    }
    return select;
}

function pairsFrom(headers, source) {
    return headers.map(header => {
        const found = source.find(item => item.source === header);
        return { source: header, target: found ? found.target : null };
    });
}

function drawMapping(panel) {
    const detail = state.detail;
    const pairs = state.mapping
        ? pairsFrom(detail.headers, state.mapping)
        : state.suggestions
            ? pairsFrom(detail.headers, state.suggestions)
            : seedMapping(detail.headers, detail.targets);
    panel.append(el('p', '', 'Map each header yourself, or ask Claude after you confirm the sample below. Claude only proposes header-to-field pairs. It cannot fill a cell.'));
    const table = el('table', 'import-table');
    for (const pair of pairs) {
        const row = el('tr');
        const target = el('td');
        target.append(mappingSelect(pair.source, detail.targets, pair.target));
        row.append(el('td', '', pair.source), target);
        table.append(row);
    }
    panel.append(table);
    if (state.suggestions) {
        const reasons = el('ul', 'import-reasons');
        for (const item of state.suggestions) {
            reasons.append(el('li', '', `${item.source} → ${item.target || 'unmapped'} (${item.confidence}): ${item.reason}`));
        }
        panel.append(reasons);
    }
    const sample = el('pre', 'import-sample');
    sample.textContent = JSON.stringify(detail.sample, null, 2);
    const check = el('label', 'import-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = state.confirmedSample;
    box.addEventListener('change', () => { state.confirmedSample = box.checked; });
    check.append(box, el('span', '', ` Send these headers and at most ${state.limits.sampleRows} rows (${JSON.stringify(detail.sample).length} characters) to Claude. Nothing is sent until this is checked.`));
    const suggest = button('Suggest with Claude', 'back-btn');
    suggest.addEventListener('click', async () => {
        if (!state.confirmedSample) {
            showError('Confirm the sample before sending it. You can keep mapping by hand.');
            return;
        }
        showError('');
        try {
            const result = await request(`/api/admin/imports/${state.upload.jobId}/suggest`, {
                method: 'POST',
                body: JSON.stringify({ confirmed: true, companyId: permissions.companyContext?.id })
            });
            if (!result.suggestions) {
                state.suggestions = null;
                showError('Claude did not return a usable mapping. Continue with the manual mapping.');
                return;
            }
            state.suggestions = result.suggestions;
            state.mapping = null;
            render();
        } catch (error) {
            fail(error);
        }
    });
    const next = button('Continue');
    next.addEventListener('click', () => {
        state.mapping = mappingFromControls();
        state.step = 'conversions';
        render();
    });
    panel.append(sample, check, suggest, next);
}

function drawConversions(panel) {
    panel.append(el('p', '', 'These conversions are fixed. Blank prices stay blank. Prices keep cents. Text is trimmed. Non-USD prices are rejected and are not converted. Dates use the UTC calendar day.'));
    panel.append(el('p', '', 'A slash date such as 06/10/2026 is ambiguous. Choose the order before validation. A month name without a year cannot be guessed.'));
    const order = el('select');
    order.id = 'importDateOrder';
    for (const [value, label] of [['', 'No ambiguous dates'], ['mdy', 'Month/day/year'], ['dmy', 'Day/month/year']]) {
        const option = el('option', '', label);
        option.value = value;
        if (value === state.dateOrder) option.selected = true;
        order.append(option);
    }
    const next = button('Validate rows');
    next.addEventListener('click', async () => {
        state.dateOrder = order.value;
        try {
            state.validation = await postValidate();
            state.excluded = new Set(state.validation.errors.filter(error => error.excluded).map(error => error.row));
            if (state.validation.blocked) {
                showError(`Required fields are not mapped: ${state.validation.unmappedRequired.join(', ')}.`);
                state.step = 'mapping';
                render();
                showError(`Required fields are not mapped: ${state.validation.unmappedRequired.join(', ')}.`);
                return;
            }
            state.step = 'validate';
            render();
        } catch (error) {
            fail(error);
        }
    });
    panel.append(order, next);
}

async function postValidate() {
    return request(`/api/admin/imports/${state.upload.jobId}/validate`, {
        method: 'POST',
        body: JSON.stringify({
            companyId: permissions.companyContext?.id,
            sheetName: state.detail.sheetName,
            mapping: currentMapping(),
            dateOrder: state.dateOrder || null,
            excludedRows: [...state.excluded]
        })
    });
}

function drawValidate(panel) {
    const result = state.validation;
    panel.append(el('p', '', `${result.acceptedCount} rows accepted, ${result.rejectedCount} rejected.`));
    if (result.needsDateChoice) panel.append(el('p', 'import-note', 'An ambiguous date still needs a month/day choice, or the row must be excluded.'));
    const rows = new Map();
    for (const error of result.errors) {
        if (!rows.has(error.row)) rows.set(error.row, []);
        rows.get(error.row).push(`${error.field}: ${error.message}`);
    }
    if (rows.size) {
        const table = el('table', 'import-table');
        for (const [row, messages] of rows) {
            const line = el('tr');
            const check = el('input');
            check.type = 'checkbox';
            check.checked = state.excluded.has(row);
            check.addEventListener('change', () => {
                if (check.checked) state.excluded.add(row);
                else state.excluded.delete(row);
            });
            const cell = el('td');
            cell.append(check, el('span', '', ` Exclude row ${row}`));
            line.append(cell, el('td', '', messages.join(' ')));
            table.append(line);
        }
        panel.append(table);
    }
    const refresh = button('Apply exclusions', 'back-btn');
    refresh.addEventListener('click', async () => {
        try {
            state.validation = await postValidate();
            render();
        } catch (error) {
            fail(error);
        }
    });
    const next = button('Review');
    next.addEventListener('click', async () => {
        try {
            state.validation = await postValidate();
            if (state.validation.errors.some(error => !state.excluded.has(error.row))) {
                showError('Exclude every invalid row, or go back and fix the mapping. Nothing has been saved.');
                render();
                showError('Exclude every invalid row, or go back and fix the mapping. Nothing has been saved.');
                return;
            }
            state.step = 'review';
            render();
        } catch (error) {
            fail(error);
        }
    });
    panel.append(refresh, next);
}

function drawReview(panel) {
    const result = state.validation;
    panel.append(el('p', '', result.appendWarning));
    panel.append(el('p', '', `${result.acceptedCount} ${state.dataset} rows will be appended for ${state.limits.company.name}. ${result.rejectedCount} rejected rows stay out.`));
    const commit = button('Commit import');
    commit.addEventListener('click', async () => {
        const gate = companyOperationGate(permissions, `Import ${result.acceptedCount} ${state.dataset} rows.`);
        if (!gate.allowed) {
            showError(gate.message);
            return;
        }
        if (!window.confirm(gate.message)) return;
        try {
            const outcome = await request(`/api/admin/imports/${state.upload.jobId}/commit`, {
                method: 'POST',
                body: JSON.stringify({
                    companyId: permissions.companyContext?.id,
                    sheetName: state.detail.sheetName,
                    mapping: currentMapping(),
                    dateOrder: state.dateOrder || null,
                    excludedRows: [...state.excluded],
                    submissionId: crypto.randomUUID(),
                    acknowledgeAppend: true
                })
            });
            state.outcome = outcome;
            state.step = 'commit';
            render();
        } catch (error) {
            fail(error);
        }
    });
    const cancel = button('Cancel import', 'back-btn');
    cancel.addEventListener('click', async () => {
        try {
            await request(`/api/admin/imports/${state.upload.jobId}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ companyId: permissions.companyContext?.id })
            });
            state.step = 'dataset';
            state.upload = null;
            render();
        } catch (error) {
            fail(error);
        }
    });
    panel.append(commit, cancel);
}

function drawCommit(panel) {
    const outcome = state.outcome;
    panel.append(el('p', '', `Imported ${outcome.acceptedCount} ${outcome.dataset} rows for ${outcome.company.name}. ${outcome.rejectedCount} rows were rejected. The upload has been deleted.`));
    panel.append(el('p', '', 'Undo this import from Data → History while the restore window is open. Undo removes only these rows, and it stops if one of them was edited later.'));
}

export async function mount(container, ctx) {
    permissions = ctx.permissions;
    root = container;
    state.step = 'dataset';
    state.dataset = 'rates';
    state.upload = null;
    state.detail = null;
    state.validation = null;
    state.suggestions = null;
    state.excluded = new Set();
    state.confirmedSample = false;
    state.dateOrder = '';
    container.replaceChildren();
    try {
        state.limits = await request('/api/admin/imports/limits');
    } catch (error) {
        container.append(el('p', 'error', error.message));
        return;
    }
    render();
}

export function unmount() {
    if (root) root.replaceChildren();
    root = null;
}
