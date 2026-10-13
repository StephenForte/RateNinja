import { fullDaysUntil, parseIsoDate } from '../dates.js';
import { request } from '../api.js';

const state = {
    rates: [],
    filteredRates: [],
    currentPage: 1,
    perPage: 20,
    sortColumn: 'rateEffectiveDate',
    sortDirection: 'desc',
    predictive: false,
    predictiveAfter: '',
    loaded: false
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
    bindEvents();
}

export async function showRates() {
    mount();
    if (state.loaded) return;
    await loadRates();
}

export function unmount() {}

function bindEvents() {
    elements.search.addEventListener('input', debounce(resetAndApplyFilters, 250));
    filterDefinitions.forEach(([id]) => document.getElementById(id).addEventListener('change', resetAndApplyFilters));
    elements.refresh.addEventListener('click', () => loadRates());
    elements.predictiveToggle.addEventListener('change', onPredictiveToggle);
    elements.predictiveDate.addEventListener('change', () => {
        if (state.predictive) loadPredictiveRates();
    });
    elements.previous.addEventListener('click', () => changePage(-1));
    elements.next.addEventListener('click', () => changePage(1));
    document.querySelectorAll('#ratesTable .sortable').forEach(header => {
        header.addEventListener('click', () => setSort(header.dataset.column));
    });
    syncSortHeaders();
    document.getElementById('closeModal').addEventListener('click', closeSailingsModal);
    document.getElementById('closeContractModal').addEventListener('click', closeContractModal);
    window.addEventListener('click', event => {
        if (event.target === elements.sailingsModal) closeSailingsModal();
        if (event.target === elements.contractModal) closeContractModal();
    });
}

async function loadRates() {
    if (state.predictive) {
        await loadPredictiveRates();
        return;
    }
    hidePredictiveBanner();
    showLoading();
    try {
        const { rates } = await request('/api/rates');
        state.rates = rates;
        state.loaded = true;
        populateFilters();
        resetAndApplyFilters();
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

function onPredictiveToggle() {
    const on = elements.predictiveToggle.checked;
    elements.predictiveDate.disabled = !on;
    hidePredictiveDateError();
    if (on) {
        state.predictive = true;
        if (!elements.predictiveDate.value) elements.predictiveDate.value = predictiveMinDate();
        loadPredictiveRates();
    } else {
        state.predictive = false;
        state.predictiveAfter = '';
        hidePredictiveBanner();
        loadRates();
    }
}

async function loadPredictiveRates() {
    const after = elements.predictiveDate.value;
    const validationError = validatePredictiveDate(after);
    if (validationError) {
        showPredictiveDateError(validationError);
        hidePredictiveBanner();
        elements.tableBody.replaceChildren();
        return;
    }
    hidePredictiveDateError();
    showLoading();
    try {
        const { rates } = await request(`/api/rates/predictive?after=${encodeURIComponent(after)}`);
        state.rates = rates;
        state.predictiveAfter = after;
        populateFilters();
        resetAndApplyFilters();
        showPredictiveBanner(after);
    } catch (error) {
        hidePredictiveBanner();
        showError(`Failed to load predictive rates: ${error.message}`);
        elements.tableBody.replaceChildren();
    } finally {
        hideLoading();
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

function populateFilters() {
    filterDefinitions.forEach(([id, field, label]) => {
        const select = document.getElementById(id);
        const currentValue = select.value;
        const values = [...new Set(state.rates.map(rate => String(rate[field] || '')).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right));
        select.replaceChildren(new Option(label, ''));
        values.forEach(value => select.add(new Option(value, value)));
        if (values.includes(currentValue)) select.value = currentValue;
    });
}

function resetAndApplyFilters() {
    state.currentPage = 1;
    applyFilters();
}

function rateMatchesSearch(rate, searchTerm) {
    if (!searchTerm) return true;
    if (searchFields.some(field => String(rate[field] ?? '').toLowerCase().includes(searchTerm))) {
        return true;
    }
    const displayValues = [
        `$${formatNumber(rate.rate20D)}`,
        `$${formatNumber(rate.rate40D)}`,
        `$${formatNumber(rate.rate40HC)}`,
        formatNumber(rate.rate20D),
        formatNumber(rate.rate40D),
        formatNumber(rate.rate40HC),
        formatDate(rate.rateEffectiveDate),
        formatDate(rate.rateExpirationDate)
    ];
    return displayValues.some(value => String(value).toLowerCase().includes(searchTerm));
}

function applyFilters() {
    const searchTerm = elements.search.value.trim().toLowerCase();
    const selected = Object.fromEntries(filterDefinitions.map(([id, field]) => [field, document.getElementById(id).value]));
    state.filteredRates = state.rates.filter(rate => {
        const matchesSearch = rateMatchesSearch(rate, searchTerm);
        const matchesFilters = Object.entries(selected).every(([field, value]) => !value || rate[field] === value);
        return matchesSearch && matchesFilters;
    });
    sortRates();
    renderTable();
}

function syncSortHeaders() {
    document.querySelectorAll('#ratesTable .sortable').forEach(header => {
        const active = header.dataset.column === state.sortColumn;
        header.classList.toggle('active', active);
        header.classList.toggle('asc', active && state.sortDirection === 'asc');
        header.classList.toggle('desc', active && state.sortDirection === 'desc');
    });
}

function setSort(column) {
    if (state.sortColumn === column) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.sortColumn = column;
        state.sortDirection = 'asc';
    }
    syncSortHeaders();
    resetAndApplyFilters();
}

function sortRates() {
    if (!state.sortColumn) return;
    const numericColumns = new Set(['rate20D', 'rate40D', 'rate40HC']);
    const dateColumns = new Set(['rateEffectiveDate', 'rateExpirationDate']);
    state.filteredRates.sort((left, right) => {
        let leftValue = left[state.sortColumn];
        let rightValue = right[state.sortColumn];
        if (numericColumns.has(state.sortColumn)) {
            leftValue = Number(leftValue) || 0;
            rightValue = Number(rightValue) || 0;
        } else if (dateColumns.has(state.sortColumn)) {
            leftValue = Date.parse(leftValue) || 0;
            rightValue = Date.parse(rightValue) || 0;
        } else {
            leftValue = String(leftValue).toLowerCase();
            rightValue = String(rightValue).toLowerCase();
        }
        const result = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
        return state.sortDirection === 'asc' ? result : -result;
    });
}

function renderTable() {
    const start = (state.currentPage - 1) * state.perPage;
    const pageRates = state.filteredRates.slice(start, start + state.perPage);
    elements.tableBody.replaceChildren();
    if (!pageRates.length) {
        const row = document.createElement('tr');
        const cell = textCell('No shipping rates found matching your criteria', 'td');
        cell.colSpan = 13;
        cell.className = 'empty-table-message';
        row.append(cell);
        elements.tableBody.append(row);
    } else {
        pageRates.forEach(rate => elements.tableBody.append(createRateRow(rate)));
    }
    updatePagination();
}

function createRateRow(rate) {
    const row = document.createElement('tr');
    row.append(
        textCell(rate.rateType),
        textCell(rate.originPort),
        textCell(rate.destinationPort),
        textCell(rate.inlandDeliveryLocation),
        textCell(rate.commodityType),
        rateLink(rate.carrier, 'carrier-link', event => { event.preventDefault(); openSailingsModal(rate); }),
        rateLink(rate.ownerCompanyName && rate.ownerCompanyName !== rate.contractOwner
            ? `${rate.contractOwner} · ${rate.ownerCompanyName}`
            : rate.contractOwner, 'contract-link', event => { event.preventDefault(); openContractModal(rate); }),
        rateCell(rate.rate20D),
        rateCell(rate.rate40D),
        rateCell(rate.rate40HC),
        textCell(formatDate(rate.rateEffectiveDate), 'td', 'validity-date'),
        textCell(formatDate(rate.rateExpirationDate), 'td', 'validity-date'),
        textCell(rate.notes1, 'td', 'notes')
    );
    return row;
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
    span.textContent = `$${formatNumber(value)}`;
    cell.append(span);
    return cell;
}

function rateLink(value, className, listener) {
    const cell = document.createElement('td');
    const link = document.createElement('a');
    link.href = '#';
    link.className = className;
    link.textContent = value;
    link.addEventListener('click', listener);
    cell.append(link);
    return cell;
}

function updatePagination() {
    const totalPages = Math.max(1, Math.ceil(state.filteredRates.length / state.perPage));
    elements.previous.disabled = state.currentPage === 1;
    elements.next.disabled = state.currentPage === totalPages;
    elements.pageInfo.textContent = `Page ${state.currentPage} of ${totalPages}`;
}

function changePage(direction) {
    const totalPages = Math.max(1, Math.ceil(state.filteredRates.length / state.perPage));
    const page = state.currentPage + direction;
    if (page >= 1 && page <= totalPages) {
        state.currentPage = page;
        renderTable();
    }
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value) || 0);
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

function createSailingRow(sailing) {
    const row = document.createElement('tr');
    row.append(
        textCell(formatDate(sailing.departure)),
        textCell(formatDate(sailing.arrival)),
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
    document.getElementById('contract20D').textContent = `$${formatNumber(rate.rate20D)}`;
    document.getElementById('contract40D').textContent = `$${formatNumber(rate.rate40D)}`;
    document.getElementById('contract40HC').textContent = `$${formatNumber(rate.rate40HC)}`;
    document.getElementById('contractValidity').textContent = `${formatDate(rate.rateEffectiveDate)} to ${formatDate(rate.rateExpirationDate)}`;
    document.getElementById('contractRoute').textContent = `${rate.originPort} → ${rate.destinationPort}`;
}

function closeContractModal() {
    elements.contractModal.hidden = true;
}
