// Airtable Configuration
const AIRTABLE_BASE_ID = 'appBLegnJMAienppq';
const AIRTABLE_TABLE_ID = 'tbl5OpIdW2kyRRWLp';
const AIRTABLE_API_KEY = 'patmavgfaBmeaZt0V.31aae1face1c9ecbebb893a46eb6672104ea7aa700164c2cc7e7a952a088045f';
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

// Global variables
let allRates = [];
let filteredRates = [];
let currentPage = 1;
const recordsPerPage = 20;
let sortColumn = '';
let sortDirection = 'asc';

// DOM elements
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorMessageEl = document.getElementById('errorMessage');
const ratesTableBody = document.getElementById('ratesTableBody');
const searchInput = document.getElementById('searchInput');
const carrierFilter = document.getElementById('carrierFilter');
const originPortFilter = document.getElementById('originPortFilter');
const destinationPortFilter = document.getElementById('destinationPortFilter');
const contractOwnerFilter = document.getElementById('contractOwnerFilter');
const refreshBtn = document.getElementById('refreshBtn');

const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pageInfoEl = document.getElementById('pageInfo');

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    loadRates();
    setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
    // Search functionality
    searchInput.addEventListener('input', debounce(handleSearch, 300));
    
    // Filter functionality
    carrierFilter.addEventListener('change', handleFilter);
    originPortFilter.addEventListener('change', handleFilter);
    destinationPortFilter.addEventListener('change', handleFilter);
    contractOwnerFilter.addEventListener('change', handleFilter);
    
    // Refresh button
    refreshBtn.addEventListener('click', loadRates);
    
    // Pagination
    prevBtn.addEventListener('click', () => changePage(-1));
    nextBtn.addEventListener('click', () => changePage(1));
    
    // Sorting
    document.querySelectorAll('.sortable').forEach(header => {
        header.addEventListener('click', () => handleSort(header.dataset.column));
    });
}

// Load rates from Airtable
async function loadRates() {
    showLoading();
    hideError();
    
    try {
        const response = await fetch(AIRTABLE_URL, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        allRates = data.records.map(record => ({
            id: record.id,
            rateType: record.fields['Rate Type'] || 'N/A',
            originPort: record.fields['Origin Port'] || 'N/A',
            destinationPort: Array.isArray(record.fields['Destination Port/Via Port']) 
                ? record.fields['Destination Port/Via Port'].join(', ') 
                : (record.fields['Destination Port/Via Port'] || 'N/A'),
            carrier: record.fields.Carrier || 'N/A',
            contractOwner: record.fields['Contract Owner'] || 'N/A',
            rate20D: record.fields['20D Rate'] || 0,
            rate40D: record.fields['40D rate'] || 0,
            rate40HC: record.fields['40HC Rate'] || 0,
            rateEffectiveDate: record.fields['Rate Effective Date'] || 'N/A',
            rateExpirationDate: record.fields['Rate Expiration Date'] || 'N/A',
            notes1: record.fields['Notes 1'] || '',
            createdTime: record.createdTime
        }));
        
        filteredRates = [...allRates];
        populateFilters();
        renderTable();
        hideLoading();
        
    } catch (error) {
        console.error('Error loading rates:', error);
        showError(`Failed to load shipping rates: ${error.message}`);
        hideLoading();
    }
}

// Show loading state
function showLoading() {
    loadingEl.style.display = 'block';
    ratesTableBody.innerHTML = '';
}

// Hide loading state
function hideLoading() {
    loadingEl.style.display = 'none';
}

// Show error state
function showError(message) {
    errorMessageEl.textContent = message;
    errorEl.style.display = 'block';
}

// Hide error state
function hideError() {
    errorEl.style.display = 'none';
}

// Populate filter dropdowns
function populateFilters() {
    const carriers = [...new Set(allRates.map(rate => rate.carrier))].filter(Boolean);
    const originPorts = [...new Set(allRates.map(rate => rate.originPort))].filter(Boolean);
    const destinationPorts = [...new Set(allRates.map(rate => rate.destinationPort))].filter(Boolean);
    const contractOwners = [...new Set(allRates.map(rate => rate.contractOwner))].filter(Boolean);
    
    // Populate carrier filter
    carrierFilter.innerHTML = '<option value="">All Carriers</option>';
    carriers.sort().forEach(carrier => {
        const option = document.createElement('option');
        option.value = carrier;
        option.textContent = carrier;
        carrierFilter.appendChild(option);
    });
    
    // Populate origin port filter
    originPortFilter.innerHTML = '<option value="">All Origin Ports</option>';
    originPorts.sort().forEach(port => {
        const option = document.createElement('option');
        option.value = port;
        option.textContent = port;
        originPortFilter.appendChild(option);
    });
    
    // Populate destination port filter
    destinationPortFilter.innerHTML = '<option value="">All Destination Ports</option>';
    destinationPorts.sort().forEach(port => {
        const option = document.createElement('option');
        option.value = port;
        option.textContent = port;
        destinationPortFilter.appendChild(option);
    });
    
    // Populate contract owner filter
    contractOwnerFilter.innerHTML = '<option value="">All Contract Owners</option>';
    contractOwners.sort().forEach(owner => {
        const option = document.createElement('option');
        option.value = owner;
        option.textContent = owner;
        contractOwnerFilter.appendChild(option);
    });
}



// Handle search
function handleSearch() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    filteredRates = allRates.filter(rate => {
        return rate.carrier.toLowerCase().includes(searchTerm) ||
               rate.originPort.toLowerCase().includes(searchTerm) ||
               rate.destinationPort.toLowerCase().includes(searchTerm) ||
               rate.contractOwner.toLowerCase().includes(searchTerm) ||
               rate.rateType.toLowerCase().includes(searchTerm) ||
               rate.notes1.toLowerCase().includes(searchTerm);
    });
    
    currentPage = 1;
    renderTable();
}

// Handle filtering
function handleFilter() {
    const carrierValue = carrierFilter.value;
    const originPortValue = originPortFilter.value;
    const destinationPortValue = destinationPortFilter.value;
    const contractOwnerValue = contractOwnerFilter.value;
    
    filteredRates = allRates.filter(rate => {
        const carrierMatch = !carrierValue || rate.carrier === carrierValue;
        const originPortMatch = !originPortValue || rate.originPort === originPortValue;
        const destinationPortMatch = !destinationPortValue || rate.destinationPort === destinationPortValue;
        const contractOwnerMatch = !contractOwnerValue || rate.contractOwner === contractOwnerValue;
        
        return carrierMatch && originPortMatch && destinationPortMatch && contractOwnerMatch;
    });
    
    currentPage = 1;
    renderTable();
}

// Handle sorting
function handleSort(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortDirection = 'asc';
    }
    
    // Update sort indicators
    document.querySelectorAll('.sortable').forEach(header => {
        header.classList.remove('active', 'asc', 'desc');
        if (header.dataset.column === column) {
            header.classList.add('active', sortDirection);
        }
    });
    
    // Sort the data
    filteredRates.sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];
        
        // Handle different data types
        if (column === 'rate20D' || column === 'rate40D' || column === 'rate40HC') {
            aVal = parseFloat(aVal) || 0;
            bVal = parseFloat(bVal) || 0;
        } else if (column === 'rateEffectiveDate' || column === 'rateExpirationDate') {
            aVal = new Date(aVal);
            bVal = new Date(bVal);
        } else {
            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();
        }
        
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
    
    currentPage = 1;
    renderTable();
}

// Render the table
function renderTable() {
    const startIndex = (currentPage - 1) * recordsPerPage;
    const endIndex = startIndex + recordsPerPage;
    const pageRates = filteredRates.slice(startIndex, endIndex);
    
    ratesTableBody.innerHTML = '';
    
    if (pageRates.length === 0) {
        ratesTableBody.innerHTML = `
            <tr>
                <td colspan="12" style="text-align: center; padding: 40px; color: #666;">
                    <i class="fas fa-search" style="font-size: 2rem; margin-bottom: 15px; display: block;"></i>
                    No shipping rates found matching your criteria
                </td>
            </tr>
        `;
    } else {
        pageRates.forEach(rate => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${escapeHtml(rate.rateType)}</td>
                <td>${escapeHtml(rate.originPort)}</td>
                <td>${escapeHtml(rate.destinationPort)}</td>
                <td>${escapeHtml(rate.carrier)}</td>
                <td>${escapeHtml(rate.contractOwner)}</td>
                <td>
                    <span class="rate-value">$${formatNumber(rate.rate20D)}</span>
                </td>
                <td>
                    <span class="rate-value">$${formatNumber(rate.rate40D)}</span>
                </td>
                <td>
                    <span class="rate-value">$${formatNumber(rate.rate40HC)}</span>
                </td>
                <td>
                    <span class="validity-date">${formatDate(rate.rateEffectiveDate)}</span>
                </td>
                <td>
                    <span class="validity-date">${formatDate(rate.rateExpirationDate)}</span>
                </td>
                <td>
                    <span class="notes">${escapeHtml(rate.notes1)}</span>
                </td>
                <td>
                    <button class="action-btn" onclick="viewDetails('${rate.id}')">
                        <i class="fas fa-eye"></i> View
                    </button>
                </td>
            `;
            ratesTableBody.appendChild(row);
        });
    }
    
    updatePagination();
}

// Update pagination
function updatePagination() {
    const totalPages = Math.ceil(filteredRates.length / recordsPerPage);
    
    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages || totalPages === 0;
    
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages || 1}`;
}

// Change page
function changePage(direction) {
    const totalPages = Math.ceil(filteredRates.length / recordsPerPage);
    const newPage = currentPage + direction;
    
    if (newPage >= 1 && newPage <= totalPages) {
        currentPage = newPage;
        renderTable();
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatNumber(num) {
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(num);
}

function formatDate(dateString) {
    if (!dateString || dateString === 'N/A') return 'N/A';
    
    try {
        const date = new Date(dateString);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        return `${month}/${day}/${year}`;
    } catch (error) {
        return dateString;
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// View details function
function viewDetails(rateId) {
    const rate = allRates.find(r => r.id === rateId);
    if (rate) {
        alert(`Rate Details:\n\nRate Type: ${rate.rateType}\nOrigin Port: ${rate.originPort}\nDestination Port: ${rate.destinationPort}\nCarrier: ${rate.carrier}\nContract Owner: ${rate.contractOwner}\n\n20D Rate: $${formatNumber(rate.rate20D)}\n40D Rate: $${formatNumber(rate.rate40D)}\n40HC Rate: $${formatNumber(rate.rate40HC)}\n\nRate Effective Date: ${formatDate(rate.rateEffectiveDate)}\nRate Expiration Date: ${formatDate(rate.rateExpirationDate)}\n\nNotes: ${rate.notes1 || 'No additional notes'}`);
    }
}
