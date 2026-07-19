const state = {
    user: null,
    rates: [],
    filteredRates: [],
    currentPage: 1,
    perPage: 20,
    sortColumn: '',
    sortDirection: 'asc',
    adminChanges: new Map()
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

const ADMIN_SAVE_CONCURRENCY = 3;

let elements;

document.addEventListener('DOMContentLoaded', () => {
    elements = {
        loginPage: document.getElementById('loginPage'),
        mainPage: document.getElementById('mainPage'),
        adminScreen: document.getElementById('adminScreen'),
        loginForm: document.getElementById('loginForm'),
        loginError: document.getElementById('loginError'),
        loginErrorMessage: document.getElementById('loginErrorMessage'),
        welcomeText: document.getElementById('welcomeText'),
        logoutBtn: document.getElementById('logoutBtn'),
        loading: document.getElementById('loading'),
        error: document.getElementById('error'),
        errorMessage: document.getElementById('errorMessage'),
        tableBody: document.getElementById('ratesTableBody'),
        search: document.getElementById('searchInput'),
        refresh: document.getElementById('refreshBtn'),
        previous: document.getElementById('prevBtn'),
        next: document.getElementById('nextBtn'),
        pageInfo: document.getElementById('pageInfo'),
        hamburger: document.getElementById('hamburgerBtn'),
        hamburgerMenu: document.getElementById('hamburgerMenu'),
        rateAdjustmentLink: document.getElementById('rateAdjustmentLink'),
        backToMain: document.getElementById('backToMainBtn'),
        saveChanges: document.getElementById('saveChangesBtn'),
        adminLoading: document.getElementById('adminLoading'),
        adminError: document.getElementById('adminError'),
        adminErrorMessage: document.getElementById('adminErrorMessage'),
        adminTableContainer: document.getElementById('adminTableContainer'),
        adminTableBody: document.getElementById('adminTableBody'),
        sailingsModal: document.getElementById('sailingsModal'),
        contractModal: document.getElementById('contractModal')
    };
    bindEvents();
    restoreSession();
});

async function request(path, options = {}) {
    const { allowUnauthenticated = false, ...fetchOptions } = options;
    const response = await fetch(path, {
        ...fetchOptions,
        headers: {
            ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
            ...fetchOptions.headers
        }
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 && !allowUnauthenticated) showLoginPage();
        throw new Error(payload.error || 'Request failed.');
    }
    return payload;
}

function bindEvents() {
    elements.loginForm.addEventListener('submit', handleLogin);
    elements.logoutBtn.addEventListener('click', logout);
    elements.search.addEventListener('input', debounce(resetAndApplyFilters, 250));
    filterDefinitions.forEach(([id]) => document.getElementById(id).addEventListener('change', resetAndApplyFilters));
    elements.refresh.addEventListener('click', () => loadRates({ refresh: true }));
    elements.previous.addEventListener('click', () => changePage(-1));
    elements.next.addEventListener('click', () => changePage(1));
    document.querySelectorAll('#ratesTable .sortable').forEach(header => {
        header.addEventListener('click', () => setSort(header.dataset.column));
    });
    elements.hamburger.addEventListener('click', event => {
        event.stopPropagation();
        elements.hamburgerMenu.hidden = !elements.hamburgerMenu.hidden;
    });
    elements.rateAdjustmentLink.addEventListener('click', event => {
        event.preventDefault();
        showAdminScreen();
    });
    elements.backToMain.addEventListener('click', showMainPage);
    elements.saveChanges.addEventListener('click', saveAdminChanges);
    document.getElementById('closeModal').addEventListener('click', closeSailingsModal);
    document.getElementById('closeContractModal').addEventListener('click', closeContractModal);
    window.addEventListener('click', event => {
        if (event.target === elements.sailingsModal) closeSailingsModal();
        if (event.target === elements.contractModal) closeContractModal();
        if (!elements.hamburger.contains(event.target) && !elements.hamburgerMenu.contains(event.target)) {
            elements.hamburgerMenu.hidden = true;
        }
    });
}

async function restoreSession() {
    try {
        const { user } = await request('/api/session', { allowUnauthenticated: true });
        state.user = user;
        showMainPage();
        await loadRates();
    } catch {
        showLoginPage();
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const form = new FormData(elements.loginForm);
    hideLoginError();
    try {
        const { user } = await request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
            allowUnauthenticated: true
        });
        state.user = user;
        showMainPage();
        await loadRates();
    } catch (error) {
        showLoginError(error.message);
    }
}

async function logout() {
    try {
        await request('/api/auth/logout', { method: 'POST', allowUnauthenticated: true });
    } catch {
        // A failed logout should still clear the local UI state.
    }
    state.user = null;
    state.rates = [];
    state.filteredRates = [];
    showLoginPage();
}

function showLoginPage() {
    elements.loginPage.hidden = false;
    elements.mainPage.hidden = true;
    elements.adminScreen.hidden = true;
    elements.loginForm.reset();
    hideLoginError();
}

function showMainPage() {
    if (!state.user) return;
    elements.loginPage.hidden = true;
    elements.mainPage.hidden = false;
    elements.adminScreen.hidden = true;
    elements.welcomeText.textContent = `Welcome, ${state.user.username}`;
    elements.hamburger.hidden = !state.user.isAdmin;
    elements.hamburgerMenu.hidden = true;
}

function showLoginError(message) {
    elements.loginErrorMessage.textContent = message;
    elements.loginError.hidden = false;
}

function hideLoginError() {
    elements.loginError.hidden = true;
}

async function loadRates({ refresh = false } = {}) {
    showLoading();
    try {
        const path = refresh ? '/api/rates?refresh=1' : '/api/rates';
        const { rates } = await request(path);
        state.rates = rates;
        populateFilters();
        resetAndApplyFilters();
    } catch (error) {
        showError(`Failed to load shipping rates: ${error.message}`);
        elements.tableBody.replaceChildren();
    } finally {
        hideLoading();
    }
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
    // Also match values as shown in the table (formatted money / dates).
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

function setSort(column) {
    if (state.sortColumn === column) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.sortColumn = column;
        state.sortDirection = 'asc';
    }
    document.querySelectorAll('#ratesTable .sortable').forEach(header => {
        header.classList.toggle('active', header.dataset.column === column);
        header.classList.toggle('asc', header.dataset.column === column && state.sortDirection === 'asc');
        header.classList.toggle('desc', header.dataset.column === column && state.sortDirection === 'desc');
    });
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
        rateLink(rate.contractOwner, 'contract-link', event => { event.preventDefault(); openContractModal(rate); }),
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

async function showAdminScreen() {
    if (!state.user?.isAdmin) return;
    elements.mainPage.hidden = true;
    elements.adminScreen.hidden = false;
    elements.hamburgerMenu.hidden = true;
    elements.adminLoading.hidden = false;
    elements.adminError.hidden = true;
    elements.adminTableContainer.hidden = true;
    state.adminChanges.clear();
    try {
        const { companies } = await request('/api/admin/companies');
        renderAdminTable(companies);
        elements.adminTableContainer.hidden = false;
    } catch (error) {
        elements.adminErrorMessage.textContent = `Failed to load companies: ${error.message}`;
        elements.adminError.hidden = false;
    } finally {
        elements.adminLoading.hidden = true;
    }
}

function renderAdminTable(companies) {
    elements.adminTableBody.replaceChildren();
    if (!companies.length) {
        const row = document.createElement('tr');
        const cell = textCell('No companies found matching your criteria');
        cell.colSpan = 3;
        cell.className = 'empty-table-message';
        row.append(cell);
        elements.adminTableBody.append(row);
        return;
    }
    companies.forEach(company => {
        const row = document.createElement('tr');
        row.append(textCell(company.name));
        row.append(createMarginInput(company, 'marginPercent', company.marginPercent));
        row.append(createMarginInput(company, 'marginNumber', company.marginNumber));
        elements.adminTableBody.append(row);
    });
}

function createMarginInput(company, field, value) {
    const cell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '1000000';
    input.step = '0.01';
    input.value = value;
    input.addEventListener('input', () => {
        const changes = state.adminChanges.get(company.id) || {
            marginPercent: company.marginPercent,
            marginNumber: company.marginNumber
        };
        changes[field] = Number(input.value);
        state.adminChanges.set(company.id, changes);
        input.classList.add('changed');
    });
    cell.append(input);
    return cell;
}

async function mapPool(items, concurrency, worker) {
    const results = [];
    let index = 0;
    async function run() {
        while (index < items.length) {
            const current = index;
            index += 1;
            results[current] = await worker(items[current], current);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
    return results;
}

async function saveAdminChanges() {
    if (!state.adminChanges.size) return;
    elements.saveChanges.disabled = true;
    elements.saveChanges.textContent = 'Saving…';
    try {
        await mapPool([...state.adminChanges], ADMIN_SAVE_CONCURRENCY, ([id, changes]) => request(`/api/admin/companies/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(changes)
        }));
        state.adminChanges.clear();
        await showAdminScreen();
    } catch (error) {
        elements.adminErrorMessage.textContent = `Failed to save changes: ${error.message}`;
        elements.adminError.hidden = false;
    } finally {
        elements.saveChanges.disabled = false;
        elements.saveChanges.textContent = 'Save Changes';
    }
}
