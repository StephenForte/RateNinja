// Airtable Configuration
const AIRTABLE_BASE_ID = 'appBLegnJMAienppq';
const AIRTABLE_RATE_TABLE_ID = 'tbl5OpIdW2kyRRWLp';
const AIRTABLE_USER_TABLE_ID = 'tblwtjp73CaWe3GKy'; // UserInfo table ID
const AIRTABLE_COMPANY_TABLE_ID = 'CompanyReference'; // CompanyReference table ID
const AIRTABLE_API_KEY = 'YOUR_AIRTABLE_PAT';
const AIRTABLE_RATE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_RATE_TABLE_ID}`;
const AIRTABLE_USER_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_USER_TABLE_ID}`;
const AIRTABLE_COMPANY_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_COMPANY_TABLE_ID}`;

// Global variables
let allRates = [];
let filteredRates = [];
let currentPage = 1;
const recordsPerPage = 20;
let sortColumn = '';
let sortDirection = 'asc';
let currentUserRateOwner = null; // Store the user's RateOwner (CompanyID) for filtering
let currentUserCompanyReference = null; // Store the user's CompanyReference for margin calculations
let currentUserCompanyID = null; // Store the user's CompanyID for margin calculations
let companyReferenceData = null; // Store CompanyReference table data for margin calculations

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
    setupLogin();
    setupEventListeners();
});

// Setup login functionality
function setupLogin() {
    const loginForm = document.getElementById('loginForm');
    const loginPage = document.getElementById('loginPage');
    const mainPage = document.getElementById('mainPage');
    const loginError = document.getElementById('loginError');
    const loginErrorMessage = document.getElementById('loginErrorMessage');
    const welcomeText = document.getElementById('welcomeText');
    const logoutBtn = document.getElementById('logoutBtn');

    // Check if user is already logged in
    const loggedInUser = localStorage.getItem('loggedInUser');
    const storedRateOwner = localStorage.getItem('userRateOwner');
    const storedCompanyReference = localStorage.getItem('userCompanyReference');
    const storedCompanyID = localStorage.getItem('userCompanyID');
    if (loggedInUser && storedRateOwner && storedCompanyReference && storedCompanyID) {
        currentUserRateOwner = storedRateOwner;
        currentUserCompanyReference = storedCompanyReference;
        currentUserCompanyID = storedCompanyID;
        showMainPage(loggedInUser);
        return;
    }

    // Login form submission
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        try {
            // Authenticate user and get RateOwner from UserInfo table
            const userInfo = await authenticateUser(username, password);
            if (userInfo) {
                // Store login state and RateOwner
                localStorage.setItem('loggedInUser', username);
                localStorage.setItem('userRateOwner', userInfo.rateOwner);
                localStorage.setItem('userCompanyReference', userInfo.companyReference);
                localStorage.setItem('userCompanyID', userInfo.companyID);
                currentUserRateOwner = userInfo.rateOwner;
                currentUserCompanyReference = userInfo.companyReference;
                currentUserCompanyID = userInfo.companyID;
                showMainPage(username);
            } else {
                showLoginError('Invalid username or password');
            }
        } catch (error) {
            console.error('Authentication error:', error);
            if (error.message.includes('403')) {
                showLoginError('UserInfo table not accessible. Using fallback authentication.');
            } else {
                showLoginError('Login failed. Please try again.');
            }
        }
    });

    // Logout functionality
    logoutBtn.addEventListener('click', function() {
        localStorage.removeItem('loggedInUser');
        localStorage.removeItem('userRateOwner');
        localStorage.removeItem('userCompanyReference');
        localStorage.removeItem('userCompanyID');
        currentUserRateOwner = null;
        currentUserCompanyReference = null;
        currentUserCompanyID = null;
        showLoginPage();
    });

    function showLoginPage() {
        loginPage.style.display = 'block';
        mainPage.style.display = 'none';
        loginForm.reset();
        hideLoginError();
    }

    function showMainPage(username) {
        loginPage.style.display = 'none';
        mainPage.style.display = 'block';
        welcomeText.textContent = `Welcome, ${username}`;
        loadRates();
    }

    function showLoginError(message) {
        loginErrorMessage.textContent = message;
        loginError.style.display = 'block';
    }

    function hideLoginError() {
        loginError.style.display = 'none';
    }
}

// Authenticate user against UserInfo table
async function authenticateUser(username, password) {
    try {
        const response = await fetch(AIRTABLE_USER_URL, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Find user with matching username and password using correct field names
        const user = data.records.find(record => {
            const fields = record.fields;
            return fields.UserName === username && fields.Pwd === password;
        });
        
        if (user) {
            console.log('Authentication successful for user:', user.fields);
            // RateView is a simple integer field
            const rateView = user.fields.RateView;
            // Get CompanyReference record ID for margin calculations
            const companyReference = Array.isArray(user.fields.CompanyReference) 
                ? user.fields.CompanyReference[0] 
                : user.fields.CompanyReference;
            // Get CompanyID for margin calculations
            const companyID = Array.isArray(user.fields['CompanyID (from CompanyReference)']) 
                ? user.fields['CompanyID (from CompanyReference)'][0] 
                : user.fields['CompanyID (from CompanyReference)'];
            
            console.log('User CompanyID extracted:', companyID, 'Type:', typeof companyID);
            
            return {
                username: username,
                rateOwner: rateView, // This is the integer RateView value
                companyReference: companyReference, // CompanyReference record ID for margin logic
                companyID: companyID // CompanyID for margin calculations
            };
        }
        
        return null;
    } catch (error) {
        console.error('Authentication error:', error);
        
        throw error;
    }
}

// Fetch CompanyReference data for margin calculations
async function fetchCompanyReferenceData() {
    try {
        const response = await fetch(AIRTABLE_COMPANY_URL, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        companyReferenceData = data.records;
        console.log('CompanyReference data loaded:', companyReferenceData);
        
    } catch (error) {
        console.error('Error loading CompanyReference data:', error);
        companyReferenceData = null;
    }
}

// Get the current user's CompanyID for margin calculations
function getCurrentUserCompanyID() {
    console.log('getCurrentUserCompanyID called, returning:', currentUserCompanyID, 'Type:', typeof currentUserCompanyID);
    return currentUserCompanyID;
}

// Calculate final rate using CompanyReference margin logic
function calculateFinalRate(rate, userCompanyID) {
    if (!rate || rate === 0) return 0;
    
    // Find the company reference data for this company ID
    if (!companyReferenceData) {
        console.warn('CompanyReference data not loaded, returning original rate');
        return rate;
    }
    
    // Match UserInfo.CompanyID to CompanyReference.CompanyID
    const companyRef = companyReferenceData.find(record => 
        record.fields.CompanyID === userCompanyID
    );
    
    console.log(`Looking for CompanyID ${userCompanyID} in CompanyReference data:`, companyRef);
    
    if (!companyRef) {
        console.warn(`CompanyReference not found for CompanyID ${userCompanyID}, returning original rate`);
        return rate;
    }
    
    const isAdmin = companyRef.fields.Admin;
    console.log(`Company ${userCompanyID} - Admin: ${isAdmin}, MarginPercent: ${companyRef.fields.MarginPercent}, MarginNumber: ${companyRef.fields.MarginNumber}`);
    
    // If Admin field is true, no margin calculation - return original rate
    if (isAdmin) {
        console.log(`Admin user - returning original rate: ${rate}`);
        return rate;
    }
    
    // If Admin field is false, apply margin formula:
    // (Base rate × (1 + MarginPercent)) + MarginNumber
    const marginPercent = companyRef.fields.MarginPercent || 0;
    const marginNumber = companyRef.fields.MarginNumber || 0;
    
    // Convert MarginPercent to decimal if it's a percentage (e.g., 25 -> 0.25)
    const marginPercentDecimal = marginPercent > 1 ? marginPercent / 100 : marginPercent;
    
    const finalRate = (rate * (1 + marginPercentDecimal)) + marginNumber;
    console.log(`Margin calculation: ${rate} × (1 + ${marginPercentDecimal}) + ${marginNumber} = ${finalRate}`);
    return Math.round(finalRate);
}

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

// Load rates from Airtable filtered by user's CompanyID
async function loadRates() {
    showLoading();
    hideError();
    
    try {
        // First, fetch CompanyReference data for margin calculations
        await fetchCompanyReferenceData();
        // Build URL with filter for CompanyID
        let url = AIRTABLE_RATE_URL;
        
        // Let's load all rates first to see what's actually in the table
        console.log('Loading all rates to debug...');
        console.log('User RateView (should match RateOwner):', currentUserRateOwner);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Debug: Show what fields are available in RateEntry table
        if (data.records.length > 0) {
            console.log('RateEntry table - Available fields:', Object.keys(data.records[0].fields));
            console.log('Sample RateEntry record:', data.records[0].fields);
            
            // Show all RateOwner values in the table
            const allRateOwners = new Set();
            data.records.forEach(record => {
                const rateOwner = record.fields['RateOwner'];
                if (rateOwner !== undefined && rateOwner !== null) {
                    allRateOwners.add(rateOwner);
                }
            });
            console.log('All RateOwner values in RateEntry table:', Array.from(allRateOwners));
            console.log('Total records with RateOwner field:', data.records.filter(r => r.fields['RateOwner'] !== undefined).length);
        }
        
        // Map the records to our rate format
        allRates = data.records.map(record => ({
            id: record.id,
            rateType: record.fields['Rate Type'] || 'N/A',
            originPort: record.fields['Origin Port'] || 'N/A',
            destinationPort: Array.isArray(record.fields['Destination Port/Via Port']) 
                ? record.fields['Destination Port/Via Port'].join(', ') 
                : (record.fields['Destination Port/Via Port'] || 'N/A'),
            carrier: record.fields.Carrier || 'N/A',
            contractOwner: record.fields['Contract Owner'] || 'N/A',
            // Calculate final rates (original rate + margin) based on logged-in user's CompanyID
            rate20D: calculateFinalRate(record.fields['20D Rate'], getCurrentUserCompanyID()),
            rate40D: calculateFinalRate(record.fields['40D rate'], getCurrentUserCompanyID()),
            rate40HC: calculateFinalRate(record.fields['40HC Rate'], getCurrentUserCompanyID()),
            // Store original rates for reference
            originalRate20D: record.fields['20D Rate'] || 0,
            originalRate40D: record.fields['40D rate'] || 0,
            originalRate40HC: record.fields['40HC Rate'] || 0,
            rateEffectiveDate: record.fields['Rate Effective Date'] || 'N/A',
            rateExpirationDate: record.fields['Rate Expiration Date'] || 'N/A',
            notes1: record.fields['Notes 1'] || '',
            companyID: record.fields['CompanyID'] || 'N/A',
            rateView: record.fields['RateView'] || [], // RateEntry.RateView field
            createdTime: record.createdTime
        }));
        
        // For now, show all rates since RateView fields are empty
        filteredRates = [...allRates];
        console.log('Total rates loaded (showing all since RateView fields are empty):', allRates.length);
        
        // If user has RateView, show what we're looking for
        if (currentUserRateOwner) {
            console.log('User RateView:', currentUserRateOwner);
            console.log('Looking for RateView =', currentUserRateOwner);
            console.log('NOTE: All RateView fields in RateEntry are empty arrays. Please populate them in Airtable.');
        }
        
        populateFilters();
        renderTable();
        hideLoading();
        
    } catch (error) {
        console.error('Error loading rates:', error);
        
        // If filtering failed, try loading all rates without filter
        if (currentUserRateOwner && error.message.includes('422')) {
            console.log('Filter failed, trying to load all rates and filter client-side...');
            try {
                const fallbackResponse = await fetch(AIRTABLE_RATE_URL, {
                    headers: {
                        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (fallbackResponse.ok) {
                    const fallbackData = await fallbackResponse.json();
                    
                    // Map the records to our rate format
                    allRates = fallbackData.records.map(record => ({
                        id: record.id,
                        rateType: record.fields['Rate Type'] || 'N/A',
                        originPort: record.fields['Origin Port'] || 'N/A',
                        destinationPort: Array.isArray(record.fields['Destination Port/Via Port']) 
                            ? record.fields['Destination Port/Via Port'].join(', ') 
                            : (record.fields['Destination Port/Via Port'] || 'N/A'),
                        carrier: record.fields.Carrier || 'N/A',
                        contractOwner: record.fields['Contract Owner'] || 'N/A',
            // Calculate final rates (original rate + margin) based on logged-in user's CompanyID
            rate20D: calculateFinalRate(record.fields['20D Rate'], getCurrentUserCompanyID()),
            rate40D: calculateFinalRate(record.fields['40D rate'], getCurrentUserCompanyID()),
            rate40HC: calculateFinalRate(record.fields['40HC Rate'], getCurrentUserCompanyID()),
                        // Store original rates for reference
                        originalRate20D: record.fields['20D Rate'] || 0,
                        originalRate40D: record.fields['40D rate'] || 0,
                        originalRate40HC: record.fields['40HC Rate'] || 0,
                        rateEffectiveDate: record.fields['Rate Effective Date'] || 'N/A',
                        rateExpirationDate: record.fields['Rate Expiration Date'] || 'N/A',
                        notes1: record.fields['Notes 1'] || '',
                        companyID: record.fields['CompanyID'] || 'N/A',
                        rateView: record.fields['RateView'] || [],
                        createdTime: record.createdTime
                    }));
                    
                    // Debug: Show what's in the RateEntry table
                    console.log('Total rates loaded:', allRates.length);
                    if (allRates.length > 0) {
                        console.log('Sample rate structure:', allRates[0]);
                        console.log('RateOwner field in first record:', allRates[0].rateOwner);
                    }
                    
                    // Filter client-side by RateView
                    if (currentUserRateOwner) {
                        console.log('Current user RateView (from UserInfo.RateView):', currentUserRateOwner);
                        
                        // Filter by RateView (integer) - RateEntry.RateView should contain UserInfo.RateView
                        filteredRates = allRates.filter(rate => {
                            const rateViews = Array.isArray(rate.rateView) ? rate.rateView : [rate.rateView];
                            console.log('Checking rate:', rate.id, 'RateView array:', rateViews);
                            return rateViews.includes(currentUserRateOwner);
                        });
                        
                        console.log('Filtered rates count:', filteredRates.length);
                        
                        // If no matches found, let's see what RateView values exist
                        if (filteredRates.length === 0) {
                            console.log('No matches found. Available RateView values:');
                            const allRateViews = new Set();
                            allRates.forEach(rate => {
                                const rateViews = Array.isArray(rate.rateView) ? rate.rateView : [rate.rateView];
                                rateViews.forEach(rv => allRateViews.add(rv));
                            });
                            console.log('All RateView values in RateEntry table:', Array.from(allRateViews));
                        }
                    } else {
                        filteredRates = [...allRates];
                    }
                    
                    populateFilters();
                    renderTable();
                    hideLoading();
                    return;
                }
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
            }
        }
        
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
        const companyRef = companyReferenceData?.find(record => record.fields.CompanyID === getCurrentUserCompanyID());
        const isAdmin = companyRef?.fields.Admin;
        const marginPercent = companyRef?.fields.MarginPercent || 0;
        const marginNumber = companyRef?.fields.MarginNumber || 0;
        
        alert(`Rate Details:\n\nRate Type: ${rate.rateType}\nOrigin Port: ${rate.originPort}\nDestination Port: ${rate.destinationPort}\nCarrier: ${rate.carrier}\nContract Owner: ${rate.contractOwner}\n\nFINAL RATES (with margin applied):\n20D Rate: $${formatNumber(rate.rate20D)}\n40D Rate: $${formatNumber(rate.rate40D)}\n40HC Rate: $${formatNumber(rate.rate40HC)}\n\nORIGINAL BASE RATES:\n20D Base: $${formatNumber(rate.originalRate20D)}\n40D Base: $${formatNumber(rate.originalRate40D)}\n40HC Base: $${formatNumber(rate.originalRate40HC)}\n\nMARGIN SETTINGS:\nAdmin: ${isAdmin ? 'Yes (no margin applied)' : 'No'}\nMargin Percent: ${marginPercent}%\nMargin Number: $${marginNumber}\n\nRate Effective Date: ${formatDate(rate.rateEffectiveDate)}\nRate Expiration Date: ${formatDate(rate.rateExpirationDate)}\n\nNotes: ${rate.notes1 || 'No additional notes'}`);
    }
}
