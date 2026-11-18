import { request } from '../api.js';
import { errorBox, fieldLabel, heading, paragraph, textCell } from '../dom.js';

const endpoint = '/api/managed-agents';
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 20 });
let deactivate;

function button(text, action, kind = '') {
    const control = textCell(text, 'button', kind);
    control.type = action ? 'button' : 'submit';
    if (action) control.addEventListener('click', action);
    return control;
}

function setOptions(select, placeholder, choices, value = select.value) {
    select.replaceChildren(new Option(placeholder, ''), ...choices.map(([key, label]) => new Option(label, key)));
    select.value = choices.some(([key]) => key === value) ? value : '';
}

function stringsAsOptions(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b)).map(value => [value, value]);
}

function input(type, value) {
    const control = document.createElement('input');
    control.type = type;
    if (type === 'checkbox') control.checked = value === true;
    else control.value = value ?? '';
    return control;
}

function checkbox(text, control) {
    const label = fieldLabel(text, control);
    label.className = 'agent-check';
    label.prepend(control);
    return label;
}

function editor(options, initial, remove) {
    const card = document.createElement('fieldset');
    card.className = 'agent-card agent-editor';
    const legend = document.createElement('legend');
    const fields = document.createElement('div');
    fields.className = 'agent-fields';
    const rateType = document.createElement('select');
    const originPort = document.createElement('select');
    const destinationPort = document.createElement('select');
    const containerType = document.createElement('select');
    const savedQuery = document.createElement('select');
    const sailingDate = input('date', initial.sailingDate);
    const alternative = input('checkbox', initial.allowAlternativeRoutes);
    const booking = input('checkbox', options.canRequestBooking && initial.allowBookingRequest);
    const priceMin = input('number', initial.priceMin);
    const priceMax = input('number', initial.priceMax);
    const bookingSlots = input('number', initial.bookingSlots);
    bookingSlots.min = '1';
    bookingSlots.max = String(options.maxBookingSlots);
    bookingSlots.step = '1';
    const windows = textCell('', 'span', 'agent-hint');
    const queryNote = textCell('', 'span', 'agent-hint');
    const rowError = errorBox();
    rowError.box.setAttribute('role', 'alert');
    queryNote.setAttribute('role', 'status');
    [rateType, originPort, destinationPort, sailingDate, containerType, priceMin, priceMax, bookingSlots]
        .forEach(control => { control.required = true; });
    for (const price of [priceMin, priceMax]) {
        price.min = '0';
        price.step = 'any';
    }

    const dateField = fieldLabel('Sailing date', sailingDate);
    dateField.append(windows);
    const queryField = fieldLabel('Use saved query', savedQuery);
    queryField.append(queryNote);
    fields.append(
        fieldLabel('Rate type', rateType), fieldLabel('Origin port', originPort),
        fieldLabel('Destination port', destinationPort), dateField,
        queryField, fieldLabel('Container type', containerType)
    );

    const permissions = document.createElement('div');
    permissions.className = 'agent-permissions';
    permissions.append(checkbox('Allow AI Agent to search for alternative routes', alternative));
    if (options.canRequestBooking) {
        permissions.append(checkbox('Allow AI Agent to request a booking', booking));
    }
    const prices = document.createElement('div');
    prices.className = 'agent-fields agent-prices';
    prices.append(
        fieldLabel('Min price (USD per container)', priceMin),
        fieldLabel('Max price (USD per container)', priceMax),
        fieldLabel('Slots', bookingSlots)
    );

    function togglePrices() {
        prices.hidden = !booking.checked;
        priceMin.disabled = priceMax.disabled = bookingSlots.disabled = !booking.checked;
    }

    function updateDate() {
        const lane = options.lanes.find(item => item.rateType === rateType.value
            && item.originPort === originPort.value && item.destinationPort === destinationPort.value);
        const valid = (lane?.windows || []).filter(window => window.end >= options.today)
            .map(window => ({ start: window.start < options.today ? options.today : window.start, end: window.end }));
        sailingDate.disabled = !valid.length;
        sailingDate.min = valid[0]?.start || options.today;
        sailingDate.max = valid.reduce((last, window) => window.end > last ? window.end : last, '');
        windows.textContent = valid.length
            ? valid.map(({ start, end }) => start === end ? start : `${start} to ${end}`).join(' · ')
            : lane ? 'No current rate window for this lane.' : 'Select a lane to see available dates.';
    }

    function updateDestinations(value) {
        const destinations = options.lanes.filter(lane => lane.rateType === rateType.value && lane.originPort === originPort.value);
        setOptions(destinationPort, 'Select destination', stringsAsOptions(destinations.map(lane => lane.destinationPort)), value);
        destinationPort.disabled = !destinations.length;
        updateDate();
    }

    function updateOrigins(origin, destination) {
        const origins = options.lanes.filter(lane => lane.rateType === rateType.value);
        setOptions(originPort, 'Select origin', stringsAsOptions(origins.map(lane => lane.originPort)), origin);
        originPort.disabled = !origins.length;
        updateDestinations(destination);
        savedQuery.disabled = !rateType.value || !queryChoices.length;
    }

    setOptions(rateType, 'Select rate type', stringsAsOptions(options.rateTypes), initial.rateType);
    setOptions(containerType, 'Select container type', options.containerTypes.map(type => [type, type]), initial.containerType);
    const queryChoices = options.savedQueries.map(query => [query.id, query.name]);
    if (initial.savedQueryId && !options.savedQueries.some(query => query.id === initial.savedQueryId)) {
        queryChoices.unshift([initial.savedQueryId, 'Keep existing saved query reference']);
    }
    setOptions(savedQuery, 'Choose a saved query', queryChoices, initial.savedQueryId);
    updateOrigins(initial.originPort, initial.destinationPort);
    togglePrices();

    function resetQuery() {
        if (savedQuery.value !== initial.savedQueryId) savedQuery.value = '';
        queryNote.textContent = '';
    }

    rateType.addEventListener('change', () => {
        resetQuery();
        updateOrigins('', '');
    });
    originPort.addEventListener('change', () => {
        resetQuery();
        updateDestinations('');
    });
    destinationPort.addEventListener('change', () => {
        resetQuery();
        updateDate();
    });
    savedQuery.addEventListener('change', () => {
        const query = options.savedQueries.find(item => item.id === savedQuery.value);
        queryNote.textContent = '';
        if (!query) return;
        updateOrigins(query.originPort || originPort.value, query.destinationPort || destinationPort.value);
        if ((query.originPort && !originPort.value) || (query.destinationPort && !destinationPort.value)) {
            queryNote.textContent = 'This query contains a port that is unavailable for this rate type. Select an available lane.';
        }
    });
    booking.addEventListener('change', togglePrices);
    card.addEventListener('input', () => rowError.hide());
    card.append(legend, fields, permissions, prices, rowError.box);
    const removeButton = remove && button('Remove', remove, 'agent-button');
    if (removeButton) card.append(removeButton);

    return {
        card,
        number(index, canRemove) {
            legend.textContent = remove ? `Agent ${index}` : 'Search and settings';
            windows.id = `agent-date-windows-${index}`;
            sailingDate.setAttribute('aria-describedby', windows.id);
            if (removeButton) {
                removeButton.disabled = !canRemove;
                removeButton.setAttribute('aria-label', `Remove agent ${index}`);
            }
        },
        focus: () => rateType.focus(),
        showError(message) {
            rowError.show(message);
            rowError.box.tabIndex = -1;
            rowError.box.focus();
        },
        hideError: () => rowError.hide(),
        value: () => ({
            rateType: rateType.value,
            originPort: originPort.value,
            destinationPort: destinationPort.value,
            sailingDate: sailingDate.value,
            savedQueryId: savedQuery.value || null,
            containerType: containerType.value,
            allowAlternativeRoutes: alternative.checked,
            allowBookingRequest: booking.checked,
            priceMin: booking.checked ? priceMin.valueAsNumber : null,
            priceMax: booking.checked ? priceMax.valueAsNumber : null,
            bookingSlots: booking.checked ? bookingSlots.valueAsNumber : null
        })
    };
}

function agentCard(agent, edit, remove) {
    const card = document.createElement('article');
    card.className = 'agent-card';
    const top = document.createElement('div');
    top.className = 'agent-bar';
    top.append(
        textCell(`${agent.originPort} → ${agent.destinationPort}`, 'h3'),
        textCell(agent.status, 'span', `agent-status agent-status-${agent.status}`)
    );
    const created = new Date(agent.createdAt).toLocaleString();
    const values = [
        ['Rate type', agent.rateType],
        ['Sailing date', agent.sailingDate],
        ['Container', agent.containerType],
        ['Alternative routes', agent.allowAlternativeRoutes ? 'Allowed' : 'Off'],
        ['Booking request', agent.allowBookingRequest ? 'Allowed' : 'Off']
    ];
    if (agent.allowBookingRequest) {
        values.push(['Slots', String(agent.bookingSlots)]);
        values.push(['Price (USD per container)', `${currency.format(agent.priceMin)} – ${currency.format(agent.priceMax)}`]);
    }
    if (agent.finishedAt) values.push(['Finished', new Date(agent.finishedAt).toLocaleString()]);
    const details = document.createElement('dl');
    details.className = 'agent-details';
    for (const [label, value] of values) {
        const item = document.createElement('div');
        item.append(textCell(label, 'dt'), textCell(value, 'dd'));
        details.append(item);
    }
    card.append(top, paragraph('agent-hint', [agent.companyName, agent.creatorName, created].filter(Boolean).join(' · ')), details);
    if (agent.resultSummary) card.append(paragraph('agent-result-summary', agent.resultSummary));
    if (agent.bookingRequestId) {
        const link = textCell('View booking requests', 'a');
        link.href = '/profile/booking-requests';
        card.append(link);
    }
    if (agent.canEdit || agent.canDelete) {
        const actions = document.createElement('div');
        actions.className = 'agent-actions';
        if (agent.canEdit) actions.append(button('Edit', edit, 'agent-button'));
        if (agent.canDelete) actions.append(button('Delete', remove, 'agent-button agent-delete'));
        card.append(actions);
    }
    return card;
}

export async function mount(container) {
    let active = true;
    deactivate = () => { active = false; };
    container.className = 'managed-agents';
    const pageError = errorBox();
    pageError.box.setAttribute('role', 'alert');
    const announcement = paragraph('agent-hint', 'Loading managed agents…');
    announcement.setAttribute('role', 'status');
    const toolbar = document.createElement('div');
    toolbar.className = 'agent-bar';
    toolbar.append(heading('Managed agents'));
    const formHost = document.createElement('div');
    const listHost = document.createElement('div');
    listHost.className = 'agent-list';
    container.append(toolbar, announcement, pageError.box, formHost, listHost);

    let options;
    let agents;
    try {
        [options, { agents }] = await Promise.all([request(`${endpoint}/options`), request(endpoint)]);
    } catch (error) {
        if (active) {
            announcement.textContent = '';
            pageError.show(error.message);
        }
        return;
    }
    if (!active) return;
    announcement.textContent = '';
    let busy = false;
    let openForm = null;

    const newButton = button('New agents', () => showForm(), 'agent-button agent-primary');
    if (options.canManageAgents) toolbar.append(newButton);
    else announcement.textContent = 'Your account must belong to a company to manage agents.';

    function renderList() {
        listHost.replaceChildren(...agents.map(agent => agentCard(agent, () => editAgent(agent), () => deleteAgent(agent))));
        if (!agents.length && options.canManageAgents && !openForm) {
            listHost.append(paragraph('agent-empty', 'No managed agents yet. Select New agents to queue your first search.'));
        }
    }

    function closeForm() {
        openForm = null;
        formHost.replaceChildren();
        newButton.hidden = false;
    }

    async function deleteAgent(agent) {
        if (busy || !window.confirm(`Delete the queued agent for ${agent.originPort} → ${agent.destinationPort}?`)) return;
        pageError.hide();
        busy = true;
        try {
            await request(`${endpoint}/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
            if (!active) return;
            agents = agents.filter(item => item.id !== agent.id);
            if (openForm?.agentId === agent.id) closeForm();
            renderList();
            announcement.textContent = 'Agent deleted.';
            if (!openForm) newButton.focus();
        } catch (error) {
            if (active) pageError.show(error.message);
        } finally {
            busy = false;
        }
    }

    async function editAgent(agent) {
        if (busy) return;
        busy = true;
        pageError.hide();
        announcement.textContent = 'Loading editing options…';
        let editOptions;
        try {
            editOptions = await request(`${endpoint}/options?agentId=${encodeURIComponent(agent.id)}`);
        } catch (error) {
            if (active) {
                announcement.textContent = '';
                pageError.show(error.message);
            }
        } finally {
            busy = false;
        }
        if (active && editOptions) showForm(agent, editOptions);
    }

    function showForm(agent, formOptions = options) {
        if (busy) return;
        pageError.hide();
        announcement.textContent = '';
        const form = document.createElement('form');
        form.className = 'agent-list';
        const actions = document.createElement('div');
        actions.className = 'agent-actions';
        const count = paragraph('agent-hint', '');
        count.setAttribute('role', 'status');
        const rowsHost = document.createElement('div');
        rowsHost.className = 'agent-list';
        const rows = [];

        const add = button('Add agent', () => { if (!busy) addRow(); }, 'agent-button');
        const cancel = button('Cancel', () => {
            if (!busy) {
                closeForm();
                renderList();
                newButton.focus();
            }
        }, 'agent-button');
        const save = button(agent ? 'Save changes' : 'Queue agents', null, 'agent-button agent-primary');

        function updateCount() {
            rows.forEach((row, index) => row.number(index + 1, rows.length > 1));
            count.textContent = `${rows.length} of ${formOptions.maxSearches}`;
            add.disabled = rows.length >= formOptions.maxSearches;
        }

        function addRow(initial = {}) {
            if (rows.length >= formOptions.maxSearches) return;
            const row = editor(formOptions, initial, agent ? null : () => {
                if (busy || rows.length <= 1) return;
                const index = rows.indexOf(row);
                rows.splice(index, 1);
                row.card.remove();
                updateCount();
                rows[Math.min(index, rows.length - 1)].focus();
            });
            rows.push(row);
            rowsHost.append(row.card);
            updateCount();
            row.focus();
        }

        form.append(textCell(agent ? 'Edit agent' : 'New agents', 'h3'), rowsHost);
        if (!agent) actions.append(add, count);
        actions.append(save, cancel);
        form.append(actions);
        formHost.replaceChildren(form);
        openForm = { agentId: agent?.id };
        newButton.hidden = true;
        listHost.querySelector('.agent-empty')?.remove();
        addRow(agent);

        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            pageError.hide();
            rows.forEach(row => row.hideError());
            const values = rows.map(row => row.value());
            const missingDate = values.findIndex(value => !value.sailingDate);
            if (missingDate !== -1) {
                rows[missingDate].showError('Select a lane with a current rate window and enter a sailing date.');
                return;
            }
            busy = true;
            save.disabled = cancel.disabled = add.disabled = true;
            rows.forEach(row => { row.card.disabled = true; });
            let focusRow = null;
            try {
                const path = agent ? `${endpoint}/${encodeURIComponent(agent.id)}` : endpoint;
                const result = await request(path, {
                    method: agent ? 'PUT' : 'POST',
                    body: JSON.stringify(agent ? values[0] : values)
                });
                if (!active) return;
                agents = agent
                    ? agents.map(item => item.id === agent.id ? result.agent : item)
                    : [...result.agents.reverse(), ...agents];
                closeForm();
                renderList();
                announcement.textContent = agent ? 'Agent updated.' : `${values.length} ${values.length === 1 ? 'agent' : 'agents'} queued.`;
                newButton.focus();
            } catch (error) {
                if (!active) return;
                const row = /^Row (\d+): (.*)$/.exec(error.message);
                if (row && rows[Number(row[1]) - 1]) focusRow = row;
                else pageError.show(error.message);
            } finally {
                busy = false;
                if (active && form.isConnected) {
                    save.disabled = cancel.disabled = false;
                    rows.forEach(row => { row.card.disabled = false; });
                    updateCount();
                    if (focusRow) rows[Number(focusRow[1]) - 1].showError(focusRow[2]);
                }
            }
        });
    }

    renderList();
}

export function unmount() {
    deactivate?.();
    deactivate = null;
}
