import { fullDaysUntil, parseIsoDate } from '../dates.js';
import { request } from '../api.js';
import {
    RATE_FIELDS,
    FILTER_FIELDS,
    availableValues,
    applySavedQuery,
    emptyCriteria,
    headerText,
    layoutPage,
    standardView,
    summarizeView
} from './grouping.js';
import { loadQueries, mountQueries } from './queries.js';
import { loadViews, mountViews, refreshViewControls } from './views.js';

const state = {
    rates: [],
    filteredRates: [],
    currentPage: 1,
    pageCount: 1,
    predictive: false,
    predictiveAfter: '',
    loaded: false,
    viewReady: false,
    preferenceError: '',
    criteria: emptyCriteria(),
    view: standardView(),
    fields: RATE_FIELDS,
    collapsed: new Set(),
    activeViewId: '',
    viewIsDefault: false,
    viewAttention: false
};

const filterDefinitions = [
    ['carrierFilter', 'carrier', 'All Carriers'],
    ['originPortFilter', 'originPort', 'All Origin Ports'],
    ['destinationPortFilter', 'destinationPort', 'All Destination Ports'],
    ['contractOwnerFilter', 'contractOwner', 'All Contract Owners']
];

const searchFields = [
    'rateType',
    'originPort',
    'destinationPort',
    'inlandDeliveryLocation',
    'commodityType',
    'carrier',
    'contractOwner',
    'rate20D',
    'rate40D',
    'rate40HC',
    'rateEffectiveDate',
    'rateExpirationDate',
    'notes1'
];

let elements;
let bound = false;

const host = {
    criteria() {
        return { ...state.criteria };
    },
    commitCriteria() {
        state.criteria = readCriteriaFromControls();
    },
    applySaved(criteria) {
        const applied = applySavedQuery({
            criteria,
            available: availableValues(state.rates),
            predictive: state.predictive,
            predictiveAfter: state.predictiveAfter
        });
        state.criteria = applied.criteria;
        state.currentPage = applied.page;
        writeCriteriaToControls(applied.criteria);
        applyFilters();
    },
    view() {
        return {
            columnOrder: state.view.columnOrder.slice(),
            hiddenColumns: state.view.hiddenColumns.slice(),
            groupBy: state.view.groupBy.slice(),
            sort: state.view.sort.map(rule => ({ ...rule })),
            pageSize: state.view.pageSize
        };
    },
    setView(next, meta = {}) {
        state.view = {
            columnOrder: next.columnOrder.slice(),
            hiddenColumns: next.hiddenColumns.slice(),
            groupBy: next.groupBy.slice(),
            sort: next.sort.map(rule => ({ ...rule })),
            pageSize: next.pageSize
        };
        state.collapsed = new Set();
        state.currentPage = 1;
        if (Object.prototype.hasOwnProperty.call(meta, 'id')) {
            state.activeViewId = meta.id || '';
            state.viewIsDefault = Boolean(meta.isDefault);
            state.viewAttention = Boolean(meta.needsAttention);
        }
        renderTable();
    },
    setSummary(text) {
        const summary = document.getElementById('ratesViewSummary');
        if (summary) summary.textContent = text;
    },
    restoreStandard() {
        state.view = standardView(state.fields);
        state.activeViewId = '';
        state.viewIsDefault = false;
        state.viewAttention = false;
        state.collapsed = new Set();
        state.currentPage = 1;
        renderTable();
    },
    activeViewId() {
        return state.activeViewId;
    },
    setActiveView(id, isDefault) {
        state.activeViewId = id || '';
        state.viewIsDefault = Boolean(isDefault);
    },
    viewAttention() {
        return state.viewAttention;
    },
    noteAttention(needsAttention) {
        state.viewAttention = Boolean(needsAttention);
    },
    clearPreferenceError() {
        state.preferenceError = '';
    }
};

export function mount() {
    if (bound) return;
    bound = true;
    elements = {
        loading: document.getElementById('loading'),
        error: document.getElementById('error'),
        errorMessage: document.getElementById('errorMessage'),
        tableBody: document.getElementById('ratesTableBody'),
        search: document.getElementById('searchInput'),
        refresh: document.getElementById('refreshBtn'),
        predictiveToggle: document.getElementById('predictiveToggle'),
        predictiveDate: document.getElementById('predictiveDate'),
        predictiveDateError: document.getElementById('predictiveDateError'),
        predictiveBanner: document.getElementById('predictiveBanner'),
        predictiveBannerText: document.getElementById('predictiveBannerText'),
        previous: document.getElementById('prevBtn'),
        next: document.getElementById('nextBtn'),
        pageInfo: document.getElementById('pageInfo'),
        sailingsModal: document.getElementById('sailingsModal'),
        contractModal: document.getElementById('contractModal')
    };
    elements.predictiveDate.min = predictiveMinDate();
    mountPreferences();
    bindEvents();
    renderHeader();
}

export async function showRates() {
    mount();
    if (state.loaded) {
        await refreshSavedLists();
        return;
    }
    await loadRates();
}

export function unmount() {}

function mountPreferences() {
    const bar = document.getElementById('ratesPreferenceBar');
    const querySlot = document.createElement('div');
    const viewSlot = document.createElement('div');
    const summary = document.createElement('p');
    summary.id = 'ratesViewSummary';
    summary.setAttribute('aria-live', 'polite');
    const warning = document.createElement('p');
    warning.id = 'ratesQueryWarning';
    warning.className = 'rates-query-warning';
    warning.hidden = true;
    bar.replaceChildren(querySlot, viewSlot, summary, warning);
    mountQueries(querySlot, host);
    mountViews(viewSlot, host);
    host.setSummary(summarizeView(state.view, state.fields));
}

function bindEvents() {
    elements.search.addEventListener('input', debounce(onCriteriaEdited, 250));
    filterDefinitions.forEach(([id]) => document.getElementById(id).addEventListener('change', onCriteriaEdited));
    elements.refresh.addEventListener('click', () => loadRates());
    elements.predictiveToggle.addEventListener('change', onPredictiveToggle);
    elements.predictiveDate.addEventListener('change', () => {
        if (state.predictive) loadPredictiveRates(nextPredictiveGeneration());
    });
    elements.previous.addEventListener('click', () => changePage(-1));
    elements.next.addEventListener('click', () => changePage(1));
    document.getElementById('closeModal').addEventListener('click', closeSailingsModal);
    document.getElementById('closeContractModal').addEventListener('click', closeContractModal);
    window.addEventListener('click', event => {
        if (event.target === elements.sailingsModal) closeSailingsModal();
        if (event.target === elements.contractModal) closeContractModal();
    });
}

function onCriteriaEdited() {
    state.criteria = readCriteriaFromControls();
    state.currentPage = 1;
    applyFilters();
}

async function ensureView() {
    if (state.viewReady) return;
    try {
        const catalog = await request('/api/preferences/fields');
        const { views } = await request('/api/preferences/views');
        state.fields = catalog.fields;
        if (!state.activeViewId) {
            const preferred = views.find(view => view.isDefault);
            if (preferred) {
                state.view = preferred.view;
                state.activeViewId = preferred.id;
                state.viewIsDefault = true;
                state.viewAttention = Boolean(preferred.needsAttention);
            } else {
                state.view = standardView(state.fields);
            }
        }
        state.viewReady = true;
        state.preferenceError = '';
    } catch (error) {
        state.preferenceError = error.message || 'Saved views could not be loaded.';
        const status = document.getElementById('viewStatus');
        if (status) {
            status.textContent = state.preferenceError;
            status.hidden = false;
            status.classList.add('rates-preference-error');
        }
    }
}

async function refreshSavedLists() {
    await Promise.all([loadQueries(), loadViews()]);
}

async function loadRates() {
    if (state.predictive) {
        await loadPredictiveRates(nextPredictiveGeneration());
        return;
    }
    hidePredictiveBanner();
    showLoading();
    try {
        await ensureView();
        const preferenceLoad = Promise.all([loadQueries(), loadViews()]);
        const { rates } = await request('/api/rates');
        state.rates = rates;
        state.loaded = true;
        state.currentPage = 1;
        await preferenceLoad;
        populateFilters();
        applyFilters();
    } catch (error) {
        showError(`Failed to load shipping rates: ${error.message}`);
        elements.tableBody.replaceChildren();
    } finally {
        hideLoading();
    }
}

function predictiveMinDate() {
    const today = new Date();
    const min = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 91));
    return min.toISOString().slice(0, 10);
}

function validatePredictiveDate(value) {
    const date = parseIsoDate(value);
    if (!date) return 'Please choose a valid departure date.';
    if (fullDaysUntil(date) <= 90) return 'Departing after must be more than 90 days in the future.';
    return null;
}

let predictiveGeneration = 0;

function nextPredictiveGeneration() {
    predictiveGeneration += 1;
    return predictiveGeneration;
}

function onPredictiveToggle() {
    const on = elements.predictiveToggle.checked;
    elements.predictiveDate.disabled = !on;
    hidePredictiveDateError();
    if (on) {
        state.predictive = true;
        if (!elements.predictiveDate.value) elements.predictiveDate.value = predictiveMinDate();
        loadPredictiveRates(nextPredictiveGeneration());
    } else {
        nextPredictiveGeneration();
        state.predictive = false;
        state.predictiveAfter = '';
        hidePredictiveBanner();
        loadRates();
    }
}

async function loadPredictiveRates(generation) {
    const after = elements.predictiveDate.value;
    const validationError = validatePredictiveDate(after);
    if (generation !== predictiveGeneration) return;
    if (validationError) {
        showPredictiveDateError(validationError);
        hidePredictiveBanner();
        hideLoading();
        elements.tableBody.replaceChildren();
        return;
    }
    hidePredictiveDateError();
    showLoading();
    try {
        await ensureView();
        const lists = refreshSavedLists();
        const { rates } = await request(`/api/rates/predictive?after=${encodeURIComponent(after)}`);
        await lists;
        if (generation !== predictiveGeneration || !elements.predictiveToggle.checked) return;
        state.rates = rates;
        state.predictive = true;
        state.predictiveAfter = after;
        state.currentPage = 1;
        populateFilters();
        applyFilters();
        showPredictiveBanner(after);
    } catch (error) {
        if (generation !== predictiveGeneration) return;
        hidePredictiveBanner();
        showError(`Failed to load predictive rates: ${error.message}`);
        elements.tableBody.replaceChildren();
    } finally {
        if (generation === predictiveGeneration) hideLoading();
    }
}

function showPredictiveBanner(after) {
    elements.predictiveBannerText.textContent = `Showing predictive rates for departures after ${formatDate(after)} - not saved data`;
    elements.predictiveBanner.hidden = false;
}

function hidePredictiveBanner() {
    elements.predictiveBanner.hidden = true;
}

function showPredictiveDateError(message) {
    elements.predictiveDateError.textContent = message;
    elements.predictiveDateError.hidden = false;
}

function hidePredictiveDateError() {
    elements.predictiveDateError.hidden = true;
}

function showLoading() {
    elements.loading.hidden = false;
    elements.error.hidden = true;
    elements.tableBody.replaceChildren();
}

function hideLoading() {
    elements.loading.hidden = true;
}

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.error.hidden = false;
}

function readCriteriaFromControls() {
    const criteria = emptyCriteria();
    criteria.search = elements.search.value;
    filterDefinitions.forEach(([id, field]) => {
        criteria[field] = document.getElementById(id).value;
    });
    return criteria;
}

function writeCriteriaToControls(criteria) {
    elements.search.value = criteria.search;
    filterDefinitions.forEach(([id, field, label]) => {
        const select = document.getElementById(id);
        const value = criteria[field] || '';
        const exists = [...select.options].some(option => option.value === value);
        if (value && !exists) select.add(new Option(`${value} (unavailable)`, value));
        if (!value || [...select.options].some(option => option.value === value)) select.value = value;
        if (!value) select.value = '';
        if (!select.options.length) select.add(new Option(label, ''));
    });
}

function populateFilters() {
    filterDefinitions.forEach(([id, field, label]) => {
        const select = document.getElementById(id);
        const values = [...new Set(state.rates.map(rate => String(rate[field] || '')).filter(Boolean))]
            .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        select.replaceChildren(new Option(label, ''));
        values.forEach(value => select.add(new Option(value, value)));
        const wanted = state.criteria[field] || '';
        if (wanted && values.includes(wanted)) select.value = wanted;
        else if (wanted) {
            select.add(new Option(`${wanted} (unavailable)`, wanted));
            select.value = wanted;
        } else select.value = '';
    });
}

function applyFilters() {
    const applied = applySavedQuery({
        criteria: state.criteria,
        available: availableValues(state.rates),
        predictive: state.predictive,
        predictiveAfter: state.predictiveAfter
    });
    state.queryUnavailable = Boolean(applied.warning);
    const warning = document.getElementById('ratesQueryWarning');
    if (warning) {
        warning.textContent = applied.warning || '';
        warning.hidden = !applied.warning;
    }
    if (!applied.ok) {
        state.filteredRates = [];
    } else {
        const searchTerm = state.criteria.search.trim().toLowerCase();
        state.filteredRates = state.rates.filter(rate => {
            const matchesSearch = rateMatchesSearch(rate, searchTerm);
            const matchesFilters = FILTER_FIELDS.every(field => !state.criteria[field] || rate[field] === state.criteria[field]);
            return matchesSearch && matchesFilters;
        });
    }
    renderTable();
}

function visibleColumns() {
    const hidden = new Set(state.view.hiddenColumns || []);
    const known = new Set(state.fields.map(field => field.id));
    return (state.view.columnOrder || []).filter(id => known.has(id) && !hidden.has(id));
}

function renderHeader() {
    const head = document.getElementById('ratesTableHead');
    if (!head) return;
    const row = document.createElement('tr');
    visibleColumns().forEach(id => {
        const field = state.fields.find(item => item.id === id);
        const cell = document.createElement('th');
        const rule = (state.view.sort || []).find(item => item.field === id);
        if (field && field.sortable) {
            cell.className = 'sortable';
            cell.dataset.column = id;
            if (rule) cell.classList.add('active', rule.direction);
            const icon = document.createElement('i');
            icon.className = 'fas fa-sort';
            icon.setAttribute('aria-hidden', 'true');
            cell.append(document.createTextNode(`${field.label} `), icon);
            cell.addEventListener('click', () => onHeaderSort(id));
        } else {
            cell.textContent = field ? field.label : id;
        }
        row.append(cell);
    });
    head.replaceChildren(row);
}

function onHeaderSort(column) {
    const current = state.view.sort || [];
    const direction = current.length === 1 && current[0].field === column && current[0].direction === 'asc' ? 'desc' : 'asc';
    state.view = { ...state.view, sort: [{ field: column, direction }] };
    state.currentPage = 1;
    renderTable();
    refreshViewControls();
}

function renderTable() {
    renderHeader();
    const summary = document.getElementById('ratesViewSummary');
    if (summary) {
        const text = summarizeView(state.view, state.fields);
        summary.textContent = state.viewAttention ? `Needs attention. ${text}` : text;
    }
    const layout = layoutPage(state.filteredRates, {
        fields: state.fields,
        groupBy: state.view.groupBy,
        sort: state.view.sort,
        page: state.currentPage,
        pageSize: state.view.pageSize,
        collapsed: [...state.collapsed]
    });
    state.currentPage = layout.page;
    state.pageCount = layout.pageCount;
    elements.tableBody.replaceChildren();
    if (!layout.items.length) {
        const row = document.createElement('tr');
        const cell = textCell(state.queryUnavailable
            ? 'This saved query is unavailable. No rates are shown.'
            : 'No shipping rates found matching your criteria', 'td');
        cell.colSpan = Math.max(1, visibleColumns().length);
        cell.className = 'empty-table-message';
        row.append(cell);
        elements.tableBody.append(row);
    } else {
        layout.items.forEach(item => {
            elements.tableBody.append(item.type === 'header' ? createGroupRow(item) : createRateRow(item.rate));
        });
    }
    updatePagination(layout);
}

function createGroupRow(item) {
    const row = document.createElement('tr');
    row.className = 'group-header';
    row.dataset.depth = String(item.depth || 0);
    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, visibleColumns().length);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-toggle';
    toggle.setAttribute('aria-expanded', item.collapsed ? 'false' : 'true');
    toggle.textContent = headerText(item);
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(item.count);
    toggle.addEventListener('click', () => {
        if (state.collapsed.has(item.pathKey)) state.collapsed.delete(item.pathKey);
        else state.collapsed.add(item.pathKey);
        renderTable();
    });
    cell.append(toggle, count);
    row.append(cell);
    return row;
}

function createRateRow(rate) {
    const row = document.createElement('tr');
    if (rate.predictive) row.classList.add('predictive-rate');
    const columns = visibleColumns();
    const cells = columns.map(id => rateCellFor(id, rate));
    if (rate.predictive) {
        const badge = document.createElement('span');
        badge.className = 'predictive-indicator';
        badge.textContent = 'Predictive';
        if (cells[0]) cells[0].prepend(badge);
        else {
            const cell = document.createElement('td');
            cell.append(badge);
            cells.push(cell);
        }
    }
    row.append(...cells);
    return row;
}

function rateCellFor(id, rate) {
    if (id === 'carrier') {
        return rateLink(rate.carrier, 'carrier-link', event => {
            event.preventDefault();
            openSailingsModal(rate);
        });
    }
    if (id === 'contractOwner') {
        const label = rate.ownerCompanyName && rate.ownerCompanyName !== rate.contractOwner
            ? `${rate.contractOwner} · ${rate.ownerCompanyName}`
            : rate.contractOwner;
        return rateLink(label, 'contract-link', event => {
            event.preventDefault();
            openContractModal(rate);
        });
    }
    if (id === 'rate20D' || id === 'rate40D' || id === 'rate40HC') return rateCell(rate[id]);
    if (id === 'rateEffectiveDate' || id === 'rateExpirationDate') return textCell(formatDate(rate[id]), 'td', 'validity-date');
    if (id === 'notes1') return textCell(rate.notes1, 'td', 'notes');
    return textCell(rate[id]);
}

function textCell(value, tagName = 'td', className = '') {
    const cell = document.createElement(tagName);
    cell.textContent = value ?? '';
    if (className) cell.className = className;
    return cell;
}

function rateCell(value) {
    const cell = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'rate-value';
    span.textContent = priceText(value);
    cell.append(span);
    return cell;
}

function rateLink(value, className, listener) {
    const cell = document.createElement('td');
    const link = document.createElement('a');
    link.href = '#';
    link.className = className;
    link.textContent = value ?? '';
    link.addEventListener('click', listener);
    cell.append(link);
    return cell;
}

function rateMatchesSearch(rate, searchTerm) {
    if (!searchTerm) return true;
    if (searchFields.some(field => String(rate[field] ?? '').toLowerCase().includes(searchTerm))) return true;
    const displayValues = [
        priceText(rate.rate20D),
        priceText(rate.rate40D),
        priceText(rate.rate40HC),
        formatNumber(rate.rate20D),
        formatNumber(rate.rate40D),
        formatNumber(rate.rate40HC),
        formatDate(rate.rateEffectiveDate),
        formatDate(rate.rateExpirationDate)
    ];
    return displayValues.some(value => String(value).toLowerCase().includes(searchTerm));
}

function updatePagination(layout) {
    elements.previous.disabled = layout.page <= 1;
    elements.next.disabled = layout.page >= layout.pageCount;
    elements.pageInfo.textContent = `Page ${layout.page} of ${layout.pageCount}`;
}

function changePage(direction) {
    const page = state.currentPage + direction;
    if (page >= 1 && page <= state.pageCount) {
        state.currentPage = page;
        renderTable();
    }
}

function priceText(value) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `$${formatNumber(number)}`;
}

function formatNumber(value) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(number);
}

function formatDate(value) {
    if (!value || value === 'N/A') return 'N/A';
    const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnly) return `${dateOnly[2]}/${dateOnly[3]}/${dateOnly[1].slice(-2)}`;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }).format(date);
}

function debounce(callback, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => callback(...args), wait);
    };
}

function openSailingsModal(rate) {
    ensureArrivalPortColumn();
    elements.sailingsModal.hidden = false;
    document.getElementById('modalTitle').textContent = `Available Sailings - ${rate.carrier}`;
    document.getElementById('sailingsLoading').hidden = false;
    document.getElementById('sailingsContent').hidden = true;
    document.getElementById('sailingsError').hidden = true;
    loadSailings(rate);
}

function closeSailingsModal() {
    elements.sailingsModal.hidden = true;
}

async function loadSailings(rate) {
    const query = new URLSearchParams({ carrier: rate.carrier, originPort: rate.originPort, after: rate.rateEffectiveDate });
    try {
        const { sailings } = await request(`/api/sailings?${query}`);
        const content = document.getElementById('sailingsContent');
        const summary = document.getElementById('sailingsSummary');
        const body = document.getElementById('sailingsTableBody');
        document.getElementById('sailingsLoading').hidden = true;
        content.hidden = false;
        summary.replaceChildren();
        const firstLine = document.createElement('p');
        firstLine.textContent = sailings.length
            ? `${sailings.length} available sailings found for ${rate.carrier} from ${rate.originPort} to ${rate.destinationPort}.`
            : `No sailings found for ${rate.carrier} from ${rate.originPort} departing after ${formatDate(rate.rateEffectiveDate)}.`;
        summary.append(firstLine);
        body.replaceChildren(...sailings.map(createSailingRow));
    } catch (error) {
        document.getElementById('sailingsLoading').hidden = true;
        const errorElement = document.getElementById('sailingsError');
        document.getElementById('sailingsErrorMessage').textContent = `Failed to load sailings: ${error.message}`;
        errorElement.hidden = false;
    }
}

function ensureArrivalPortColumn() {
    const row = document.querySelector('#sailingsTable thead tr');
    if (!row || row.querySelector('[data-column="arrivalPort"]')) return;
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.column = 'arrivalPort';
    th.textContent = 'Arrival port';
    const arrival = row.querySelector('[data-column="arrival"]');
    if (arrival) arrival.after(th);
    else row.append(th);
}

function createSailingRow(sailing) {
    const row = document.createElement('tr');
    row.append(
        textCell(formatDate(sailing.departure)),
        textCell(formatDate(sailing.arrival)),
        textCell(sailing.arrivalPort || '—'),
        textCell(sailing.transitTime === 'N/A' ? 'N/A' : `${sailing.transitTime} days`),
        textCell(sailing.vessel),
        textCell(sailing.voyage),
        textCell(sailing.service)
    );
    return row;
}

function openContractModal(rate) {
    elements.contractModal.hidden = false;
    const reference = `${String(rate.contractOwner).slice(0, 3)}${String(rate.carrier).slice(0, 2)}${String(rate.id).slice(-4)}`.toUpperCase();
    document.getElementById('contractTitle').textContent = `${rate.carrier} Annual Contract with ${rate.contractOwner} for Spot Rates`;
    document.getElementById('contractId').textContent = `Contract ID: ${reference}`;
    document.getElementById('contract20D').textContent = priceText(rate.rate20D);
    document.getElementById('contract40D').textContent = priceText(rate.rate40D);
    document.getElementById('contract40HC').textContent = priceText(rate.rate40HC);
    document.getElementById('contractValidity').textContent = `${formatDate(rate.rateEffectiveDate)} to ${formatDate(rate.rateExpirationDate)}`;
    document.getElementById('contractRoute').textContent = `${rate.originPort} → ${rate.destinationPort}`;
}

function closeContractModal() {
    elements.contractModal.hidden = true;
}
