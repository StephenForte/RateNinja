import { fieldLabel, paragraph, textCell } from '../dom.js';
import { formatDollars } from '../money.js';
import { write } from './client.js';
import {
    CSV_BYTE_LIMIT, CSV_MESSAGES, DATE_FORMAT_MESSAGE, laneFromRecord, parseLaneCsv, problemLines, templateCsv
} from './lane-csv.js';

const MAX_LANES = 25;
const MAX_INSTRUCTIONS = 20000;
const PRIORITIES = ['high', 'normal', 'low'];
const NAME_MESSAGE = 'Enter a swarm name from 1 to 100 characters.';
const INSTRUCTIONS_MESSAGE = 'Enter instructions as text of at most 20000 characters.';
const LANE_COUNT_MESSAGE = 'Submit 1 to 25 lanes.';
const LANE_FIELDS_MESSAGE = 'Select a rate type, origin, destination, sailing date and container type for every lane.';
const LANE_VISIBLE_MESSAGE = 'Select a visible lane for this rate type.';
const DATE_MESSAGE = 'Choose a sailing date in a rate window for this lane.';
const FLEX_MESSAGE = 'Enter a whole number of flex days from 0 to 14.';
const PRICE_MESSAGE = 'Enter nonnegative minimum and maximum prices with minimum at or below maximum.';
const BOOKING_REASON = 'Your company cannot request bookings.';
const SPEND_MESSAGE = 'Enter a total spend cap greater than 0 when a lane allows booking.';
const SLOTS_CAP_MESSAGE = 'Enter a total slots cap from 1 to 10000 when a lane allows booking.';

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

function input(type, value) {
    const control = document.createElement('input');
    control.type = type;
    if (type === 'checkbox') control.checked = value === true;
    else control.value = value == null ? '' : String(value);
    return control;
}

function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
}

function unique(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value))].sort((a, b) => a.localeCompare(b));
}

function fillSelect(select, placeholder, values, selected) {
    const choices = unique(values);
    select.replaceChildren(option('', placeholder), ...choices.map(value => option(value, value)));
    if (choices.includes(selected)) select.value = selected;
    else if (!selected && choices.length === 1) select.value = choices[0];
    else select.value = '';
    select.disabled = choices.length === 0;
    return select.value;
}

function stepFor(error) {
    const message = String(error?.message || '');
    if (Number.isInteger(error?.position)) {
        if (/visible lane|sailing date|container type|20D, 40D or 40HC/.test(message)) return 3;
        return 4;
    }
    if (/swarm name|instructions/.test(message)) return 1;
    if (/spend cap|slots cap/.test(message)) return 2;
    if (/1 to 25 lanes/.test(message)) return 3;
    return 5;
}

function emptyState() {
    return { id: '', name: '', instructions: '', totalSpendCap: '', totalSlotsCap: '', lanes: [] };
}

export function openWizard(host, { options, swarm, onDone, onCancel }) {
    const canBook = options.canRequestBooking === true;
    const maxSlots = Number.isInteger(options.maxBookingSlots) ? options.maxBookingSlots : 10;
    const state = swarm ? copySwarm(swarm, canBook) : emptyState();
    const step3Rows = [];
    let policyRows = [];
    let step = 1;

    const root = document.createElement('div');
    root.className = 'swarm-wizard';
    const title = textCell(state.id ? 'Edit swarm' : 'New swarm', 'h3');
    const stepLabel = paragraph('swarm-step-label', 'Step 1 of 5');
    const panels = {};
    const stepErrors = {};
    for (let index = 1; index <= 5; index += 1) {
        const panel = document.createElement('div');
        panel.className = `swarm-step swarm-step-${index}`;
        panel.hidden = index !== 1;
        const error = paragraph('swarm-step-error', '');
        error.hidden = true;
        error.setAttribute('role', 'alert');
        panel.append(error);
        panels[index] = panel;
        stepErrors[index] = error;
    }

    const nameInput = input('text', state.name);
    nameInput.maxLength = 100;
    nameInput.required = true;
    const instructions = document.createElement('textarea');
    instructions.value = state.instructions;
    instructions.maxLength = MAX_INSTRUCTIONS;
    const count = paragraph('agent-hint swarm-count', '');
    const upload = input('file', '');
    upload.accept = '.md,.txt,text/markdown,text/plain';
    const spendInput = input('number', state.totalSpendCap);
    spendInput.min = '0';
    spendInput.step = 'any';
    const slotsInput = input('number', state.totalSlotsCap);
    slotsInput.min = '1';
    slotsInput.max = '10000';
    slotsInput.step = '1';
    const laneHost = document.createElement('div');
    laneHost.className = 'swarm-lanes';
    const policyHost = document.createElement('div');
    policyHost.className = 'swarm-policy';
    const review = document.createElement('div');
    review.className = 'swarm-review';

    function updateCount() {
        count.textContent = `${instructions.value.length} / ${MAX_INSTRUCTIONS}`;
    }
    instructions.addEventListener('input', updateCount);
    updateCount();

    upload.addEventListener('change', async () => {
        const file = upload.files && upload.files[0];
        if (!file) return;
        const filename = String(file.name || '').toLowerCase();
        if (!filename.endsWith('.md') && !filename.endsWith('.txt')) {
            showError(1, 'Choose a .md or .txt file.');
            return;
        }
        let text = '';
        try {
            text = await file.text();
        } catch {
            showError(1, 'Could not read that file.');
            return;
        }
        if (text.length > MAX_INSTRUCTIONS) {
            showError(1, INSTRUCTIONS_MESSAGE);
            upload.value = '';
            return;
        }
        instructions.value = text;
        updateCount();
        showError(1, '');
        upload.value = '';
    });

    const step1Fields = document.createElement('div');
    step1Fields.className = 'agent-fields';
    const instructionsLabel = fieldLabel('Instructions', instructions);
    instructionsLabel.append(count);
    step1Fields.append(fieldLabel('Name', nameInput), instructionsLabel, fieldLabel('Upload .md', upload));
    panels[1].append(step1Fields);

    const step2Fields = document.createElement('div');
    step2Fields.className = 'agent-fields';
    const spendLabel = fieldLabel('Total spend cap (USD)', spendInput);
    spendLabel.append(paragraph('agent-hint', 'The most this swarm may request in bookings, in US dollars.'));
    const slotsLabel = fieldLabel('Total slots cap', slotsInput);
    slotsLabel.append(paragraph('agent-hint', 'The most containers this swarm may request across all lanes.'));
    step2Fields.append(
        spendLabel,
        slotsLabel,
        paragraph('agent-hint', 'Both caps are required when any lane allows booking.')
    );
    panels[2].append(step2Fields);

    const addTop = button('Add lane', addLane, 'agent-button');
    const addBottom = button('Add lane', addLane, 'agent-button');
    const laneCount = paragraph('agent-hint swarm-lane-count', '');
    const addHint = paragraph('agent-hint swarm-lane-limit', '');
    const bottomHint = paragraph('agent-hint', '');
    laneCount.setAttribute('role', 'status');
    const csvUpload = input('file', '');
    csvUpload.accept = '.csv,text/csv';
    const csvTools = document.createElement('div');
    csvTools.className = 'swarm-csv swarm-lane-toolbar';
    csvTools.append(
        addTop,
        fieldLabel('Upload CSV', csvUpload),
        button('Download template', downloadTemplate, 'agent-button'),
        laneCount,
        addHint
    );
    panels[3].append(csvTools, laneHost, addBottom, bottomHint);

    panels[4].append(policyHost);
    panels[5].append(review);

    const back = button('Back', () => go(step - 1), 'agent-button');
    const saveAndRun = button('Save and run', null, 'agent-button agent-primary');
    const forward = button('Next', null, 'agent-button agent-primary');
    const cancel = button('Cancel', () => onCancel(), 'agent-button');
    const actions = document.createElement('div');
    actions.className = 'agent-actions swarm-actions';
    actions.append(back, saveAndRun, forward, cancel);
    root.append(title, stepLabel, panels[1], panels[2], panels[3], panels[4], panels[5], actions);
    host.replaceChildren(root);

    function showError(which, message) {
        const error = stepErrors[which];
        error.textContent = message || '';
        error.hidden = !message;
    }

    function clearMarks() {
        for (const row of [...step3Rows, ...policyRows]) {
            row.error.textContent = '';
            row.error.hidden = true;
            row.row.className = 'swarm-lane';
        }
        for (let index = 1; index <= 5; index += 1) showError(index, '');
    }

    function markLane(which, position, message) {
        const rows = which === 3 ? step3Rows : policyRows;
        const row = rows[position - 1];
        if (!row) return;
        row.error.textContent = message;
        row.error.hidden = false;
        row.row.className = 'swarm-lane swarm-lane-marked';
    }

    function laneRecord(rateType, origin, destination) {
        return (options.lanes || []).find(item => item.rateType === rateType
            && item.originPort === origin && item.destinationPort === destination);
    }

    function validWindows(record) {
        const today = options.today || '';
        return (record?.windows || []).filter(window => !today || window.end >= today).map(window => ({
            start: today && window.start < today ? today : window.start,
            end: window.end
        }));
    }

    function applyDate(row, keepValue) {
        const record = laneRecord(row.controls.rateType.value, row.controls.origin.value, row.controls.destination.value);
        const valid = validWindows(record);
        const date = row.controls.date;
        date.disabled = valid.length === 0;
        date.min = valid[0]?.start || options.today || '';
        date.max = valid.reduce((last, window) => window.end > last ? window.end : last, '');
        const allowed = valid.some(window => window.start <= date.value && date.value <= window.end);
        if (!keepValue || !allowed) date.value = valid[0]?.start || '';
        row.hint.textContent = valid.length
            ? valid.map(window => window.start === window.end ? window.start : `${window.start} to ${window.end}`).join(' · ')
            : record ? 'No current rate window for this lane.' : 'Select a lane to see available dates.';
        row.hint.setAttribute('title', row.hint.textContent);
    }

    function fillDestinations(row, selected, keepDate) {
        const destinations = (options.lanes || [])
            .filter(item => item.rateType === row.controls.rateType.value && item.originPort === row.controls.origin.value)
            .map(item => item.destinationPort);
        fillSelect(row.controls.destination, 'Select destination', destinations, selected);
        applyDate(row, keepDate);
    }

    function fillOrigins(row, selectedOrigin, selectedDestination, keepDate) {
        const origins = (options.lanes || [])
            .filter(item => item.rateType === row.controls.rateType.value)
            .map(item => item.originPort);
        fillSelect(row.controls.origin, 'Select origin', origins, selectedOrigin);
        fillDestinations(row, selectedDestination, keepDate);
    }

    function refreshLanes() {
        step3Rows.forEach((row, index) => {
            row.legend.textContent = row.number.textContent = `Lane ${index + 1}`;
            row.row.setAttribute('data-position', String(index + 1));
            row.up.disabled = index === 0;
            row.down.disabled = index === step3Rows.length - 1;
        });
        const atLimit = step3Rows.length >= MAX_LANES;
        addTop.disabled = addBottom.disabled = atLimit;
        laneCount.textContent = `${step3Rows.length} of ${MAX_LANES} lanes`;
        addHint.textContent = bottomHint.textContent = atLimit ? 'A swarm can have at most 25 lanes.' : '';
    }

    function moveRow(row, delta) {
        const index = step3Rows.indexOf(row);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= step3Rows.length) return;
        step3Rows.splice(index, 1);
        step3Rows.splice(next, 0, row);
        const [lane] = state.lanes.splice(index, 1);
        state.lanes.splice(next, 0, lane);
        laneHost.replaceChildren(...step3Rows.map(item => item.row));
        refreshLanes();
    }

    function removeRow(row) {
        const index = step3Rows.indexOf(row);
        if (index < 0) return;
        step3Rows.splice(index, 1);
        state.lanes.splice(index, 1);
        row.row.remove();
        refreshLanes();
    }

    function buildStep3Row(lane) {
        const row = document.createElement('fieldset');
        row.className = 'swarm-lane';
        const legend = textCell('', 'legend', 'swarm-lane-legend');
        const number = laneNumber('');
        const rateType = document.createElement('select');
        const origin = document.createElement('select');
        const destination = document.createElement('select');
        const date = input('date', lane.sailingDate);
        const container = document.createElement('select');
        const hint = textCell('', 'span', 'agent-hint swarm-date-hint');
        const error = paragraph('swarm-lane-error', '');
        error.hidden = true;
        error.setAttribute('role', 'alert');
        const controls = { rateType, origin, destination, date, container };
        const record = { row, legend, number, controls, hint, error, lane, up: null, down: null };
        const fields = document.createElement('div');
        fields.className = 'agent-fields swarm-lane-fields';
        const dateLabel = fieldLabel('Sailing date', date);
        dateLabel.append(hint);
        fields.append(
            fieldLabel('Rate type', rateType),
            fieldLabel('Origin port', origin),
            fieldLabel('Destination port', destination),
            dateLabel,
            fieldLabel('Container type', container)
        );
        const up = button('Up', () => moveRow(record, -1), 'agent-button');
        const down = button('Down', () => moveRow(record, 1), 'agent-button');
        const remove = button('Remove', () => removeRow(record), 'agent-button');
        record.up = up;
        record.down = down;
        const rowActions = document.createElement('div');
        rowActions.className = 'agent-actions swarm-lane-actions';
        rowActions.append(up, down, remove);
        const layout = document.createElement('div');
        layout.className = 'swarm-lane-layout';
        layout.append(number, fields, rowActions);
        row.append(legend, layout, error);
        fillSelect(rateType, 'Select rate type', options.rateTypes, lane.rateType);
        fillSelect(container, 'Select container type', options.containerTypes, lane.containerType);
        fillOrigins(record, lane.originPort, lane.destinationPort, true);
        rateType.addEventListener('change', () => fillOrigins(record, '', '', false));
        origin.addEventListener('change', () => fillDestinations(record, '', false));
        destination.addEventListener('change', () => applyDate(record, false));
        laneHost.append(row);
        return record;
    }

    function blankLane(previous) {
        return {
            rateType: previous?.rateType.value ?? '',
            originPort: previous?.origin.value ?? '',
            destinationPort: '',
            sailingDate: '',
            containerType: previous?.container.value ?? '',
            priority: 'normal', allowAlternativeRoutes: false, dateFlexDays: 0,
            allowBookingRequest: false, priceMin: '', priceMax: '', bookingSlots: '', acceptMaxSlots: false
        };
    }

    function addLane() {
        if (step3Rows.length >= MAX_LANES) return;
        const lane = blankLane(step3Rows.at(-1)?.controls);
        state.lanes.push(lane);
        step3Rows.push(buildStep3Row(lane));
        refreshLanes();
    }

    function policyControls(initial) {
        const priority = document.createElement('select');
        priority.replaceChildren(...PRIORITIES.map(value => option(value, value)));
        priority.value = PRIORITIES.includes(initial.priority) ? initial.priority : 'normal';
        const alternatives = input('checkbox', initial.allowAlternativeRoutes === true);
        const flex = input('number', initial.dateFlexDays ?? 0);
        flex.min = '0';
        flex.max = '14';
        flex.step = '1';
        const booking = input('checkbox', canBook && initial.allowBookingRequest === true);
        const accept = input('checkbox', initial.acceptMaxSlots === true);
        const priceMin = input('number', initial.priceMin);
        const priceMax = input('number', initial.priceMax);
        const slots = input('number', initial.bookingSlots);
        for (const price of [priceMin, priceMax]) {
            price.min = '0';
            price.step = 'any';
        }
        slots.min = '1';
        slots.max = String(maxSlots);
        slots.step = '1';
        if (!canBook) {
            booking.checked = false;
            booking.disabled = true;
        }
        function sync() {
            const on = booking.checked === true && canBook;
            priceMin.disabled = priceMax.disabled = slots.disabled = accept.disabled = !on;
        }
        booking.addEventListener('change', sync);
        sync();
        return { priority, alternatives, flex, booking, accept, priceMin, priceMax, slots, sync };
    }

    function readPolicy(fields) {
        const booking = canBook && fields.booking.checked === true;
        const flex = Number(fields.flex.value);
        return {
            priority: PRIORITIES.includes(fields.priority.value) ? fields.priority.value : 'normal',
            allowAlternativeRoutes: fields.alternatives.checked === true,
            dateFlexDays: flex,
            allowBookingRequest: booking,
            priceMin: fields.priceMin.value,
            priceMax: fields.priceMax.value,
            bookingSlots: fields.slots.value,
            acceptMaxSlots: booking && fields.accept.checked === true
        };
    }

    function writePolicy(fields, policy) {
        fields.priority.value = PRIORITIES.includes(policy.priority) ? policy.priority : 'normal';
        fields.alternatives.checked = policy.allowAlternativeRoutes === true;
        fields.flex.value = String(policy.dateFlexDays ?? 0);
        fields.booking.checked = canBook && policy.allowBookingRequest === true;
        fields.priceMin.value = policy.priceMin ?? '';
        fields.priceMax.value = policy.priceMax ?? '';
        fields.slots.value = policy.bookingSlots ?? '';
        fields.accept.checked = policy.acceptMaxSlots === true;
        fields.sync();
    }

    function laneNumber(text) {
        const number = textCell(text, 'span', 'swarm-lane-number');
        number.setAttribute('aria-hidden', 'true');
        return number;
    }

    function policyFieldset(fields, legendText, heading) {
        const box = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = legendText;
        if (heading) legend.className = 'swarm-lane-legend';
        const wrap = document.createElement('div');
        wrap.className = 'agent-fields swarm-policy-fields';
        wrap.append(
            fieldLabel('Priority', fields.priority),
            fieldLabel('Allow alternatives', fields.alternatives),
            fieldLabel('Date flex (days)', fields.flex),
            fieldLabel('Allow booking', fields.booking),
            fieldLabel('Use AI for slot selection', fields.accept),
            fieldLabel('Min price (USD)', fields.priceMin),
            fieldLabel('Max price (USD)', fields.priceMax),
            fieldLabel('Slots', fields.slots)
        );
        box.append(legend);
        if (heading) {
            const layout = document.createElement('div');
            layout.className = 'swarm-policy-layout';
            layout.append(heading, wrap);
            box.append(layout);
        } else {
            box.append(wrap);
        }
        if (!canBook) box.append(paragraph('agent-hint', BOOKING_REASON));
        return box;
    }

    function laneIdentity(lane) {
        return `${lane.rateType} ${lane.originPort} to ${lane.destinationPort}, ${lane.sailingDate}, ${lane.containerType}`;
    }

    function renderPolicy() {
        policyHost.replaceChildren();
        policyRows = [];
        const template = policyControls({
            priority: 'normal', allowAlternativeRoutes: false, dateFlexDays: 0, allowBookingRequest: false,
            priceMin: '', priceMax: '', bookingSlots: '', acceptMaxSlots: false
        });
        const templateBox = policyFieldset(template, 'Policy to copy');
        templateBox.className = 'swarm-policy-template';
        const selectAll = input('checkbox', false);
        selectAll.className = 'swarm-select-all';
        const selectedCount = paragraph('agent-hint swarm-selected-count', '');
        selectedCount.setAttribute('role', 'status');
        function updateSelection() {
            const count = policyRows.filter(row => row.selected.checked).length;
            selectAll.checked = count > 0 && count === policyRows.length;
            selectAll.indeterminate = count > 0 && count < policyRows.length;
            selectedCount.textContent = `${count} selected`;
        }
        const apply = button('Apply to selected', () => {
            const policy = readPolicy(template);
            for (const row of policyRows) {
                if (row.selected.checked !== true) continue;
                writePolicy(row.fields, policy);
                Object.assign(row.lane, policy);
            }
        }, 'agent-button');
        selectAll.addEventListener('change', () => {
            for (const row of policyRows) row.selected.checked = selectAll.checked === true;
            updateSelection();
        });
        const tools = document.createElement('div');
        tools.className = 'agent-actions swarm-policy-actions';
        tools.append(fieldLabel('Select all', selectAll), apply, selectedCount);
        const toolbar = document.createElement('div');
        toolbar.className = 'swarm-policy-toolbar';
        toolbar.append(templateBox, tools);
        policyHost.append(toolbar);
        state.lanes.forEach((lane, index) => {
            const fields = policyControls(lane);
            const selected = input('checkbox', false);
            selected.className = 'swarm-select';
            selected.addEventListener('change', updateSelection);
            const error = paragraph('swarm-lane-error', '');
            error.hidden = true;
            error.setAttribute('role', 'alert');
            const number = `Lane ${index + 1}`;
            const identity = document.createElement('div');
            identity.className = 'swarm-policy-heading';
            identity.append(
                fieldLabel('Select', selected),
                laneNumber(number),
                paragraph('swarm-lane-identity', laneIdentity(lane))
            );
            const box = policyFieldset(fields, number, identity);
            box.className = 'swarm-lane';
            box.setAttribute('data-position', String(index + 1));
            box.append(error);
            policyHost.append(box);
            policyRows.push({ row: box, fields, selected, error, lane });
        });
        updateSelection();
    }

    function readStep3() {
        state.lanes = step3Rows.map(row => {
            const lane = {
                ...row.lane,
                rateType: row.controls.rateType.value,
                originPort: row.controls.origin.value,
                destinationPort: row.controls.destination.value,
                sailingDate: row.controls.date.value,
                containerType: row.controls.container.value
            };
            row.lane = lane;
            return lane;
        });
    }

    function readStep4() {
        if (!policyRows.length) return;
        for (const row of policyRows) Object.assign(row.lane, readPolicy(row.fields));
    }

    function readCurrent() {
        if (step === 1) {
            state.name = nameInput.value;
            state.instructions = instructions.value;
        } else if (step === 2) {
            state.totalSpendCap = spendInput.value;
            state.totalSlotsCap = slotsInput.value;
        } else if (step === 3) readStep3();
        else if (step === 4) readStep4();
    }

    function identityMessage(lane) {
        const containers = options.containerTypes || [];
        if (!lane.rateType || !lane.originPort || !lane.destinationPort || !lane.sailingDate || !lane.containerType
            || !containers.includes(lane.containerType)) {
            return LANE_FIELDS_MESSAGE;
        }
        const record = laneRecord(lane.rateType, lane.originPort, lane.destinationPort);
        if (!record) return LANE_VISIBLE_MESSAGE;
        const today = options.today || '';
        const windows = record.windows || [];
        if ((today && lane.sailingDate < today) || !windows.some(window => window.start <= lane.sailingDate && lane.sailingDate <= window.end)) {
            return DATE_MESSAGE;
        }
        return '';
    }

    function priceValue(value) {
        if (typeof value === 'string' && value.trim() === '') return null;
        if (value == null) return null;
        const price = Number(value);
        return Number.isFinite(price) ? price : null;
    }

    function policyMessage(lane) {
        if (!Number.isInteger(lane.dateFlexDays) || lane.dateFlexDays < 0 || lane.dateFlexDays > 14) return FLEX_MESSAGE;
        if (!lane.allowBookingRequest) return '';
        const min = priceValue(lane.priceMin);
        const max = priceValue(lane.priceMax);
        const slots = Number(lane.bookingSlots);
        if (min === null || max === null || min < 0 || max < 0 || min > max) return PRICE_MESSAGE;
        if (!Number.isInteger(slots) || slots < 1 || slots > maxSlots) {
            return `Enter a whole number of slots from 1 to ${maxSlots}.`;
        }
        return '';
    }

    function anyBooking() {
        return state.lanes.some(lane => lane.allowBookingRequest === true);
    }

    function validate(which) {
        clearMarks();
        if (which === 1) {
            const name = state.name.trim();
            if (name.length < 1 || name.length > 100) {
                showError(1, NAME_MESSAGE);
                return false;
            }
            if (state.instructions.length > MAX_INSTRUCTIONS) {
                showError(1, INSTRUCTIONS_MESSAGE);
                return false;
            }
        }
        if (which === 3) {
            if (state.lanes.length < 1 || state.lanes.length > MAX_LANES) {
                showError(3, LANE_COUNT_MESSAGE);
                return false;
            }
            let ok = true;
            state.lanes.forEach((lane, index) => {
                const message = identityMessage(lane);
                if (!message) return;
                ok = false;
                markLane(3, index + 1, message);
                if (stepErrors[3].hidden) showError(3, message);
            });
            if (!ok) return false;
        }
        if (which === 4) {
            let ok = true;
            state.lanes.forEach((lane, index) => {
                const message = policyMessage(lane);
                if (!message) return;
                ok = false;
                markLane(4, index + 1, message);
                if (stepErrors[4].hidden) showError(4, message);
            });
            if (!ok) return false;
        }
        return true;
    }

    function paint() {
        for (let index = 1; index <= 5; index += 1) panels[index].hidden = index !== step;
        back.hidden = step === 1;
        forward.textContent = step === 5 ? 'Save' : 'Next';
        saveAndRun.hidden = step !== 5;
        stepLabel.textContent = `Step ${step} of 5`;
    }

    function renderReview() {
        review.replaceChildren();
        const list = document.createElement('dl');
        list.className = 'agent-details';
        const booking = anyBooking();
        addFact(list, 'Name', state.name.trim(), 'swarm-name');
        addFact(list, 'Total spend cap', booking ? formatDollars(state.totalSpendCap, 'None') : 'None');
        addFact(list, 'Total slots cap', booking ? state.totalSlotsCap || 'None' : 'None');
        addFact(list, 'Lanes', String(state.lanes.length));
        review.append(
            list,
            textCell('Instructions', 'h4'),
            paragraph('swarm-instructions', state.instructions || '—'),
            textCell('Lanes', 'h4'),
            reviewLaneTable(state.lanes)
        );
    }

    function go(next) {
        if (next < 1 || next > 5) return;
        readCurrent();
        if (next > step && !validate(step)) return;
        if (next === 4) renderPolicy();
        if (next === 5) renderReview();
        step = next;
        paint();
    }

    function laneBody(lane) {
        const booking = lane.allowBookingRequest === true;
        return {
            rateType: lane.rateType,
            originPort: lane.originPort,
            destinationPort: lane.destinationPort,
            sailingDate: lane.sailingDate,
            containerType: lane.containerType,
            allowAlternativeRoutes: lane.allowAlternativeRoutes === true,
            allowBookingRequest: booking,
            priceMin: booking ? priceValue(lane.priceMin) : null,
            priceMax: booking ? priceValue(lane.priceMax) : null,
            bookingSlots: booking ? Number(lane.bookingSlots) : null,
            acceptMaxSlots: booking && lane.acceptMaxSlots === true,
            priority: lane.priority,
            dateFlexDays: lane.dateFlexDays
        };
    }

    function capProblem() {
        if (!anyBooking()) return '';
        const spend = state.totalSpendCap === '' ? null : Number(state.totalSpendCap);
        const slots = state.totalSlotsCap === '' ? null : Number(state.totalSlotsCap);
        if (spend === null || !Number.isFinite(spend) || spend <= 0) return SPEND_MESSAGE;
        if (!Number.isInteger(slots) || slots < 1 || slots > 10000) return SLOTS_CAP_MESSAGE;
        return '';
    }

    async function save(runAfter) {
        readCurrent();
        if (!validate(4)) {
            step = 4;
            paint();
            return;
        }
        const problem = capProblem();
        if (problem) {
            step = 2;
            paint();
            showError(2, problem);
            return;
        }
        const booking = anyBooking();
        const body = {
            name: state.name.trim(),
            instructions: state.instructions,
            totalSpendCap: booking ? Number(state.totalSpendCap) : null,
            totalSlotsCap: booking ? Number(state.totalSlotsCap) : null,
            lanes: state.lanes.map(laneBody)
        };
        forward.disabled = true;
        saveAndRun.disabled = true;
        try {
            const path = state.id ? `/api/swarms/${encodeURIComponent(state.id)}` : '/api/swarms';
            const result = await write(path, state.id ? 'PUT' : 'POST', body);
            if (result && result.swarm) await onDone(result.swarm, { run: runAfter === true });
            else showError(5, 'Could not save the swarm.');
        } catch (error) {
            const which = stepFor(error);
            if (which === 4 && !policyRows.length) renderPolicy();
            clearMarks();
            step = which;
            paint();
            const message = error.message || 'Request failed.';
            showError(which, message);
            if (Number.isInteger(error.position) && error.position >= 1) markLane(which, error.position, message);
        } finally {
            forward.disabled = false;
            saveAndRun.disabled = false;
        }
    }

    function showCsvProblems(messages) {
        showError(3, problemLines(messages).join('\n'));
    }

    function replaceLanes(nextLanes) {
        state.lanes = nextLanes;
        for (const row of step3Rows) row.row.remove();
        step3Rows.length = 0;
        for (const lane of state.lanes) step3Rows.push(buildStep3Row(lane));
        refreshLanes();
        renderPolicy();
        step = 4;
        paint();
        showError(3, '');
        showError(4, '');
    }

    function downloadTemplate() {
        const blob = new Blob([templateCsv(options)], { type: 'text/csv' });
        const link = document.createElement('a');
        link.download = 'swarm-lanes.csv';
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
        const url = URL.createObjectURL(blob);
        link.href = url;
        root.append(link);
        if (typeof link.click === 'function') link.click();
        link.remove();
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }

    csvUpload.addEventListener('change', async () => {
        const file = csvUpload.files && csvUpload.files[0];
        csvUpload.value = '';
        if (!file) return;
        const filename = String(file.name || '');
        if (!filename.toLowerCase().endsWith('.csv')) {
            showError(3, CSV_MESSAGES.name);
            return;
        }
        if (Number(file.size) > CSV_BYTE_LIMIT) {
            showError(3, CSV_MESSAGES.size);
            return;
        }
        let text = '';
        try {
            text = await file.text();
        } catch {
            showError(3, CSV_MESSAGES.read);
            return;
        }
        const parsed = parseLaneCsv(text);
        if (!parsed.ok) {
            showCsvProblems(parsed.messages);
            return;
        }
        const problems = [];
        const nextLanes = [];
        for (const record of parsed.records) {
            const built = laneFromRecord(record, options);
            const rowProblems = built.messages.slice();
            if (built.lane && !built.messages.includes(DATE_FORMAT_MESSAGE)) {
                const identity = identityMessage(built.lane);
                if (identity) rowProblems.push(identity);
            }
            if (rowProblems.length === 0) {
                if (built.lane.allowBookingRequest === true && options.canRequestBooking !== true) {
                    rowProblems.push(BOOKING_REASON);
                }
                const policy = policyMessage(built.lane);
                if (policy) rowProblems.push(policy);
            }
            if (rowProblems.length) {
                for (const message of rowProblems) problems.push(`Row ${record.rowNumber}: ${message}`);
            } else {
                nextLanes.push(built.lane);
            }
        }
        if (problems.length) {
            showCsvProblems(problems);
            return;
        }
        if (step3Rows.length > 0 && window.confirm(CSV_MESSAGES.confirm) !== true) return;
        replaceLanes(nextLanes);
    });

    forward.addEventListener('click', () => {
        if (forward.disabled) return;
        if (step === 5) return save(false);
        go(step + 1);
    });
    saveAndRun.addEventListener('click', () => {
        if (saveAndRun.disabled || forward.disabled) return;
        return save(true);
    });

    for (const lane of state.lanes) step3Rows.push(buildStep3Row(lane));
    refreshLanes();
    paint();
}

function copySwarm(swarm, canBook) {
    return {
        id: swarm.id || '',
        name: swarm.name || '',
        instructions: swarm.instructions || '',
        totalSpendCap: swarm.totalSpendCap == null ? '' : String(swarm.totalSpendCap),
        totalSlotsCap: swarm.totalSlotsCap == null ? '' : String(swarm.totalSlotsCap),
        lanes: (swarm.lanes || []).map(lane => ({
            rateType: lane.rateType || '',
            originPort: lane.originPort || '',
            destinationPort: lane.destinationPort || '',
            sailingDate: lane.sailingDate || '',
            containerType: lane.containerType || '',
            priority: PRIORITIES.includes(lane.priority) ? lane.priority : 'normal',
            allowAlternativeRoutes: lane.allowAlternativeRoutes === true,
            dateFlexDays: Number.isInteger(lane.dateFlexDays) ? lane.dateFlexDays : 0,
            allowBookingRequest: canBook && lane.allowBookingRequest === true,
            priceMin: lane.priceMin == null ? '' : String(lane.priceMin),
            priceMax: lane.priceMax == null ? '' : String(lane.priceMax),
            bookingSlots: lane.bookingSlots == null ? '' : String(lane.bookingSlots),
            acceptMaxSlots: lane.acceptMaxSlots === true
        }))
    };
}

function addFact(list, term, value, className = '') {
    const item = document.createElement('div');
    item.append(textCell(term, 'dt'), textCell(value, 'dd', className));
    list.append(item);
}

function reviewLaneTable(lanes) {
    const scroll = document.createElement('div');
    scroll.className = 'agent-grid-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Review lanes');
    const table = document.createElement('table');
    table.className = 'agent-grid swarm-review-lanes';
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of ['#', 'Lane', 'Sailing date', 'Container', 'Priority', 'Alternatives', 'Date flex', 'Booking', 'Min', 'Max', 'Slots', 'AI slots']) {
        const cell = textCell(label, 'th');
        cell.setAttribute('scope', 'col');
        header.append(cell);
    }
    head.append(header);
    const body = document.createElement('tbody');
    lanes.forEach((lane, index) => {
        const row = document.createElement('tr');
        const booking = lane.allowBookingRequest;
        row.append(
            textCell(String(index + 1)),
            textCell(`${lane.rateType} ${lane.originPort} → ${lane.destinationPort}`),
            textCell(lane.sailingDate),
            textCell(lane.containerType),
            textCell(lane.priority),
            textCell(lane.allowAlternativeRoutes ? 'Yes' : 'No'),
            textCell(String(lane.dateFlexDays)),
            textCell(booking ? 'Yes' : 'No'),
            textCell(booking ? formatDollars(lane.priceMin, '') : ''),
            textCell(booking ? formatDollars(lane.priceMax, '') : ''),
            textCell(booking ? lane.bookingSlots : ''),
            textCell(booking ? (lane.acceptMaxSlots ? 'Yes' : 'No') : '')
        );
        body.append(row);
    });
    table.append(head, body);
    scroll.append(table);
    return scroll;
}
