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

function setEditorOptions(select, placeholder, choices, value) {
    setOptions(select, placeholder, choices, value);
    if (!value && choices.length === 1) select.value = choices[0][0];
}

function editor(options, initial = {}) {
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
    const queryField = fieldLabel('Start from a saved query (optional)', savedQuery);
    queryField.className = 'agent-query-field';
    queryField.append(queryNote);
    fields.append(
        queryField, fieldLabel('Rate type', rateType), fieldLabel('Origin port', originPort),
        fieldLabel('Destination port', destinationPort), dateField,
        fieldLabel('Container type', containerType)
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

    let previousLane;
    function updateDate() {
        const lane = options.lanes.find(item => item.rateType === rateType.value
            && item.originPort === originPort.value && item.destinationPort === destinationPort.value);
        const valid = (lane?.windows || []).filter(window => window.end >= options.today)
            .map(window => ({ start: window.start < options.today ? options.today : window.start, end: window.end }));
        sailingDate.disabled = !valid.length;
        sailingDate.min = valid[0]?.start || options.today;
        sailingDate.max = valid.reduce((last, window) => window.end > last ? window.end : last, '');
        if (!valid.length || (previousLane && previousLane !== lane) || !sailingDate.value) {
            sailingDate.value = valid[0]?.start || '';
        }
        previousLane = lane;
        windows.textContent = valid.length
            ? valid.map(({ start, end }) => start === end ? start : `${start} to ${end}`).join(' · ')
            : lane ? 'No current rate window for this lane.' : 'Select a lane to see available dates.';
    }

    function updateDestinations(value) {
        const destinations = options.lanes.filter(lane => lane.rateType === rateType.value && lane.originPort === originPort.value);
        setEditorOptions(destinationPort, 'Select destination', stringsAsOptions(destinations.map(lane => lane.destinationPort)), value);
        destinationPort.disabled = !destinations.length;
        updateDate();
    }

    function updateOrigins(origin, destination) {
        const origins = options.lanes.filter(lane => lane.rateType === rateType.value);
        setEditorOptions(originPort, 'Select origin', stringsAsOptions(origins.map(lane => lane.originPort)), origin);
        originPort.disabled = !origins.length;
        updateDestinations(destination);
    }

    const rateTypes = stringsAsOptions(options.rateTypes);
    setEditorOptions(rateType, 'Select rate type', rateTypes, initial.rateType);
    setEditorOptions(containerType, 'Select container type', stringsAsOptions(options.containerTypes), initial.containerType);
    const queryChoices = options.savedQueries.map(query => [query.id, query.name]);
    if (initial.savedQueryId && !options.savedQueries.some(query => query.id === initial.savedQueryId)) {
        queryChoices.unshift([initial.savedQueryId, 'Keep existing saved query reference']);
    }
    setOptions(savedQuery, 'Choose a saved query', queryChoices, initial.savedQueryId);
    updateOrigins(initial.originPort, initial.destinationPort);
    togglePrices();

    let pendingQuery;
    function resetQuery() {
        pendingQuery = null;
        if (savedQuery.value !== initial.savedQueryId) savedQuery.value = '';
        queryNote.textContent = '';
    }

    function applyQuery(query) {
        pendingQuery = null;
        queryNote.textContent = '';
        updateOrigins(query.originPort || originPort.value, query.destinationPort || destinationPort.value);
        if ((query.originPort && query.originPort !== originPort.value)
            || (query.destinationPort && query.destinationPort !== destinationPort.value)) {
            savedQuery.value = '';
            queryNote.textContent = 'This query contains a port that is unavailable for this rate type. Select an available lane.';
        }
    }

    rateType.addEventListener('change', () => {
        if (pendingQuery) {
            applyQuery(pendingQuery);
            return;
        }
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
        pendingQuery = null;
        const query = options.savedQueries.find(item => item.id === savedQuery.value);
        queryNote.textContent = '';
        if (!query) return;
        const matchingTypes = new Set(options.lanes.filter(lane =>
            (!query.originPort || lane.originPort === query.originPort)
            && (!query.destinationPort || lane.destinationPort === query.destinationPort)
        ).map(lane => lane.rateType));
        if (!matchingTypes.has(rateType.value) && matchingTypes.size === 1) {
            const [matchingType] = matchingTypes;
            rateType.value = matchingType;
        }
        if (!rateType.value && rateTypes.length === 1) rateType.value = rateTypes[0][0];
        if (!rateType.value && matchingTypes.size) {
            pendingQuery = query;
            queryNote.textContent = 'Select a rate type to use this saved query.';
            return;
        }
        applyQuery(query);
    });
    booking.addEventListener('change', togglePrices);
    card.addEventListener('input', () => rowError.hide());
    legend.textContent = 'Search and settings';
    windows.id = 'agent-date-windows';
    sailingDate.setAttribute('aria-describedby', windows.id);
    card.append(legend, fields, permissions, prices, rowError.box);

    return {
        card,
        clearSearch() {
            resetQuery();
            rateType.value = '';
            updateOrigins('', '');
        },
        focus: () => savedQuery.focus(),
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

const searchFields = ['originPort', 'destinationPort', 'rateType', 'companyName', 'creatorName', 'resultSummary'];

const filters = [
    ['Status', 'status', agent => agent.status],
    ['Container', 'container', agent => agent.containerType],
    ['Booking', 'booking', agent => agent.allowBookingRequest ? 'On' : 'Off'],
    ['Creator', 'creator', agent => agent.creatorName],
    ['Company', 'company', agent => agent.companyName]
];

function formatTime(value) {
    return value ? new Date(value).toLocaleString() : '—';
}

function timeCell(value) {
    const cell = document.createElement('td');
    cell.className = 'agent-grid-time';
    if (!value) {
        cell.textContent = '—';
        return cell;
    }
    const timestamp = new Date(value);
    const time = document.createElement('time');
    time.dateTime = value;
    time.append(
        textCell(timestamp.toLocaleDateString(), 'span'),
        textCell(timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'span')
    );
    cell.append(time);
    return cell;
}

function compareAgents(a, b, key, direction) {
    const left = a[key];
    const right = b[key];
    if (left === right) return 0;
    if (left == null || left === '') return right == null || right === '' ? 0 : 1;
    if (right == null || right === '') return -1;
    if (key === 'createdAt' || key === 'finishedAt' || key === 'sailingDate') {
        return direction * (left < right ? -1 : 1);
    }
    return direction * left.localeCompare(right);
}

function agentDetail(agent, edit, remove) {
    const card = document.createElement('div');
    card.className = 'agent-detail-panel';
    const values = [
        ['Alternative routes', agent.allowAlternativeRoutes ? 'Allowed' : 'Off'],
        ['Booking request', agent.allowBookingRequest ? 'Allowed' : 'Off']
    ];
    if (agent.allowBookingRequest) {
        values.push(['Slots', String(agent.bookingSlots)]);
        values.push(['Price (USD per container)', `${currency.format(agent.priceMin)} – ${currency.format(agent.priceMax)}`]);
    }
    if (agent.savedQueryId) values.push(['Saved query', agent.savedQueryId]);
    if (agent.startedAt) values.push(['Started', formatTime(agent.startedAt)]);
    if (agent.finishedAt) values.push(['Finished', formatTime(agent.finishedAt)]);
    const details = document.createElement('dl');
    details.className = 'agent-details';
    for (const [label, value] of values) {
        const item = document.createElement('div');
        item.append(textCell(label, 'dt'), textCell(value, 'dd'));
        details.append(item);
    }
    card.append(details);
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

function agentRows(agent, showCompany, expanded, edit, remove) {
    const row = document.createElement('tr');
    row.className = 'agent-grid-row';
    const lane = `${agent.originPort} → ${agent.destinationPort}`;
    const detailRow = document.createElement('tr');
    detailRow.className = 'agent-grid-detail';
    const detail = agentDetail(agent, edit, remove);
    detail.id = `agent-detail-${agent.id}`;
    const detailCell = document.createElement('td');
    detailCell.colSpan = showCompany ? 11 : 10;
    detailCell.append(detail);
    detailRow.append(detailCell);

    const expand = button('', () => {
        if (expanded.has(agent.id)) expanded.delete(agent.id);
        else expanded.add(agent.id);
        updateExpansion();
    }, 'agent-button agent-expand');
    expand.setAttribute('aria-controls', detail.id);

    function updateExpansion() {
        const isOpen = expanded.has(agent.id);
        expand.textContent = isOpen ? '−' : '+';
        expand.setAttribute('aria-expanded', String(isOpen));
        expand.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Show'} details for ${lane}`);
        detailRow.hidden = !isOpen;
    }

    updateExpansion();
    const expandCell = document.createElement('td');
    expandCell.append(expand);
    const statusCell = document.createElement('td');
    statusCell.append(textCell(agent.status, 'span', `agent-status agent-status-${agent.status}`));
    const booking = agent.allowBookingRequest
        ? `${agent.bookingSlots} ${agent.bookingSlots === 1 ? 'slot' : 'slots'}`
        : 'Off';
    row.append(
        expandCell, statusCell, textCell(lane), textCell(agent.rateType), textCell(agent.sailingDate),
        textCell(agent.containerType), textCell(booking), timeCell(agent.createdAt), timeCell(agent.finishedAt)
    );
    if (showCompany) row.append(textCell(agent.companyName || '—'));
    row.append(textCell(agent.creatorName || '—'));
    return [row, detailRow];
}

function agentGrid(host, edit, remove) {
    const expanded = new Set();
    let sortKey = 'createdAt';
    let direction = -1;
    let agents = [];
    let showCompany;

    const search = input('search', '');
    search.placeholder = 'Search agents';
    const controls = document.createElement('div');
    controls.className = 'agent-fields agent-filters';
    controls.append(fieldLabel('Search', search));
    const filterControls = filters.map(([label, key, valueOf]) => {
        const select = document.createElement('select');
        const field = fieldLabel(label, select);
        select.addEventListener('change', () => {
            updateFilters();
            renderRows();
        });
        if (key !== 'company') controls.append(field);
        return { key, field, select, valueOf };
    });

    const count = paragraph('agent-hint agent-count', '');
    count.setAttribute('role', 'status');
    const noMatches = paragraph('agent-hint', 'No agents match');
    const reset = button('Reset filters and search', () => {
        search.value = '';
        for (const { select } of filterControls) select.value = '';
        updateFilters();
        renderRows();
        search.focus();
    }, 'agent-button');

    const table = document.createElement('table');
    table.className = 'agent-grid';
    table.setAttribute('aria-label', 'Managed agents');
    const head = document.createElement('thead');
    const body = document.createElement('tbody');
    table.append(head, body);
    const scrollArea = document.createElement('div');
    scrollArea.className = 'agent-grid-scroll';
    scrollArea.tabIndex = 0;
    scrollArea.setAttribute('role', 'region');
    scrollArea.setAttribute('aria-label', 'Managed agents table');
    scrollArea.append(table);
    const scrollHint = paragraph('agent-hint agent-grid-hint', 'Scroll the table to see more columns.');
    host.append(controls, count, scrollHint, scrollArea, noMatches, reset);

    const sortButtons = new Map();
    function sortButton(label, key) {
        const control = button(label, () => {
            direction = sortKey === key ? -direction : key === 'createdAt' ? -1 : 1;
            sortKey = key;
            updateSortButtons();
            renderRows();
        }, 'agent-sort');
        sortButtons.set(key, { control, label });
        return control;
    }

    function updateSortButtons() {
        for (const [key, { control, label }] of sortButtons) {
            const active = sortKey === key;
            const order = direction === 1 ? 'ascending' : 'descending';
            control.textContent = active ? `${label} ${direction === 1 ? '↑' : '↓'}` : label;
            control.setAttribute('aria-pressed', String(active));
            control.setAttribute('aria-label', active ? `Sort by ${label}, currently ${order}` : `Sort by ${label}`);
        }
    }

    function renderHeader() {
        const row = document.createElement('tr');
        sortButtons.clear();
        const headings = [
            ['Details'], [sortButton('Status', 'status')],
            [sortButton('Origin', 'originPort'), ' → ', sortButton('Destination', 'destinationPort')],
            ['Rate type'], [sortButton('Sailing date', 'sailingDate')], ['Container'], ['Booking'],
            [sortButton('Created', 'createdAt')], [sortButton('Finished', 'finishedAt')]
        ];
        if (showCompany) headings.push(['Company']);
        headings.push(['Creator']);
        for (const contents of headings) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.append(...contents);
            row.append(cell);
        }
        head.replaceChildren(row);
        updateSortButtons();
    }

    function updateFilters() {
        for (const { key, select, valueOf } of filterControls) {
            const available = key !== 'company' || showCompany;
            const values = available ? agents.map(valueOf).filter(Boolean) : [];
            // Retain an active value even if the last matching agent was deleted or edited.
            if (select.value && available) values.push(select.value);
            setOptions(select, 'All', stringsAsOptions(values));
        }
    }

    function renderRows() {
        const term = search.value.trim().toLowerCase();
        const visible = agents.filter(agent => filterControls.every(({ select, valueOf }) =>
            !select.value || select.value === valueOf(agent))
            && (!term || searchFields.some(key => agent[key]?.toLowerCase().includes(term))));
        visible.sort((a, b) => compareAgents(a, b, sortKey, direction));
        body.replaceChildren(...visible.flatMap(agent => agentRows(agent, showCompany, expanded,
            () => edit(agent), () => remove(agent))));
        count.textContent = `Showing ${visible.length} of ${agents.length} agents`;
        scrollArea.hidden = scrollHint.hidden = !visible.length;
        noMatches.hidden = reset.hidden = visible.length > 0
            || (!term && filterControls.every(({ select }) => !select.value));
    }

    search.addEventListener('input', renderRows);
    return {
        update(nextAgents) {
            agents = nextAgents;
            expanded.clear();
            // An empty refresh carries no new information about which columns were supplied.
            const hasCompany = agents.length ? agents.some(agent => Object.hasOwn(agent, 'companyName')) : Boolean(showCompany);
            if (showCompany !== hasCompany) {
                showCompany = hasCompany;
                const companyField = filterControls.find(({ key }) => key === 'company').field;
                if (showCompany) controls.append(companyField);
                else companyField.remove();
                renderHeader();
            }
            updateFilters();
            renderRows();
        }
    };
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
    formHost.className = 'agent-form-host';
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

    const newButton = button('New agent', () => showForm(), 'agent-button agent-primary');
    if (options.canManageAgents) toolbar.append(newButton);
    else announcement.textContent = 'Your account must belong to a company to manage agents.';

    const grid = agentGrid(listHost, editAgent, deleteAgent);

    function renderList() {
        listHost.querySelector('.agent-empty')?.remove();
        grid.update(agents);
        if (!agents.length && options.canManageAgents && !openForm) {
            listHost.append(paragraph('agent-empty', 'No managed agents yet. Select New agent to queue your first search.'));
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
        const confirmation = paragraph('agent-confirmation', '');
        confirmation.setAttribute('role', 'status');
        const fields = editor(formOptions, agent);
        let queued = 0;

        const save = button(agent ? 'Save changes' : 'Queue agent', null, 'agent-button agent-primary');
        const another = agent ? null : button('Queue and add another', null, 'agent-button');
        const cancel = button('Cancel', () => {
            if (!busy) {
                closeForm();
                renderList();
                newButton.focus();
            }
        }, 'agent-button');
        actions.append(save);
        if (another) actions.append(another);
        actions.append(cancel);
        form.append(textCell(agent ? 'Edit agent' : 'New agent', 'h3'), confirmation, fields.card, actions);
        formHost.replaceChildren(form);
        openForm = { agentId: agent?.id };
        newButton.hidden = true;
        listHost.querySelector('.agent-empty')?.remove();
        fields.focus();

        function setSubmitting(submitting) {
            save.disabled = cancel.disabled = fields.card.disabled = submitting;
            if (another) another.disabled = submitting;
        }

        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            pageError.hide();
            fields.hideError();
            const value = fields.value();
            if (!value.sailingDate) {
                fields.showError('Select a lane with a current rate window and enter a sailing date.');
                return;
            }
            const keepOpen = another && event.submitter === another;
            busy = true;
            setSubmitting(true);
            let result;
            try {
                const path = agent ? `${endpoint}/${encodeURIComponent(agent.id)}` : endpoint;
                result = await request(path, {
                    method: agent ? 'PUT' : 'POST',
                    body: JSON.stringify(agent ? value : [value])
                });
            } catch (error) {
                if (active) {
                    setSubmitting(false);
                    fields.showError(error.message.replace(/^Row 1: /, ''));
                }
                return;
            } finally {
                busy = false;
            }

            if (!active) return;
            setSubmitting(false);
            agents = agent
                ? agents.map(item => item.id === agent.id ? result.agent : item)
                : [...result.agents, ...agents];
            if (keepOpen) {
                queued += 1;
                fields.clearSearch();
                confirmation.textContent = `Queued ${value.originPort} → ${value.destinationPort} (${queued} queued this session)`;
                renderList();
                fields.focus();
            } else {
                closeForm();
                renderList();
                announcement.textContent = agent ? 'Agent updated.' : '1 agent queued.';
                newButton.focus();
            }
        });
    }

    renderList();
}

export function unmount() {
    deactivate?.();
    deactivate = null;
}
