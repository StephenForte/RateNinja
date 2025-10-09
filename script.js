// Airtable Configuration
const AIRTABLE_BASE_ID = 'appBLegnJMAienppq';
const AIRTABLE_RATE_TABLE_ID = 'tbl5OpIdW2kyRRWLp';
const AIRTABLE_USER_TABLE_ID = 'tblwtjp73CaWe3GKy'; // UserInfo table ID
const AIRTABLE_COMPANY_TABLE_ID = 'CompanyReference'; // CompanyReference table ID
const AIRTABLE_SAILINGS_TABLE_ID = 'Sailings'; // Sailings table ID
const AIRTABLE_API_KEY = 'patmavgfaBmeaZt0V.31aae1face1c9ecbebb893a46eb6672104ea7aa700164c2cc7e7a952a088045f';
const AIRTABLE_RATE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_RATE_TABLE_ID}`;
const AIRTABLE_USER_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_USER_TABLE_ID}`;
const AIRTABLE_COMPANY_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_COMPANY_TABLE_ID}`;
const AIRTABLE_SAILINGS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SAILINGS_TABLE_ID}`;

// Global variables
let allRates = [];
let rateViewFilteredRates = []; // Rates filtered by user's RateView
let filteredRates = [];
let currentPage = 1;
const recordsPerPage = 20;
let sortColumn = '';
let sortDirection = 'asc';
let currentUserRateOwner = null; // Store the user's RateOwner (CompanyID) for filtering
let currentUserCompanyReference = null; // Store the user's CompanyReference for margin calculations
let currentUserCompanyID = null; // Store the user's CompanyID for margin calculations
let currentUserIsAdmin = false; // Store if user has admin access
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
    const storedRateView = localStorage.getItem('userRateView');
    const storedCompanyReference = localStorage.getItem('userCompanyReference');
    const storedCompanyID = localStorage.getItem('userCompanyID');
    const storedIsAdmin = localStorage.getItem('userIsAdmin') === 'true';
    if (loggedInUser && storedRateView && storedCompanyReference && storedCompanyID) {
        currentUserRateOwner = storedRateView;
        currentUserCompanyReference = storedCompanyReference;
        currentUserCompanyID = storedCompanyID;
        currentUserIsAdmin = storedIsAdmin;
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
                // Store login state and RateView
                localStorage.setItem('loggedInUser', username);
                localStorage.setItem('userRateView', userInfo.rateView);
                localStorage.setItem('userCompanyReference', userInfo.companyReference);
                localStorage.setItem('userCompanyID', userInfo.companyID);
                localStorage.setItem('userIsAdmin', userInfo.isAdmin);
                currentUserRateOwner = userInfo.rateView;
                currentUserCompanyReference = userInfo.companyReference;
                currentUserCompanyID = userInfo.companyID;
                currentUserIsAdmin = userInfo.isAdmin;
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
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function() {
            console.log('Logout button clicked');
            localStorage.removeItem('loggedInUser');
            localStorage.removeItem('userRateView');
            localStorage.removeItem('userCompanyReference');
            localStorage.removeItem('userCompanyID');
            currentUserRateOwner = null;
            currentUserCompanyReference = null;
            currentUserCompanyID = null;
            showLoginPage();
        });
    } else {
        console.error('Logout button not found');
    }

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
        setupAdminMenu(); // Setup admin menu if user is admin
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
            // Get AdminScreen flag
            const isAdmin = user.fields.AdminScreen === true;
            
            console.log('User CompanyID extracted:', companyID, 'Type:', typeof companyID);
            console.log('User Admin status:', isAdmin);
            
            return {
                username: username,
                rateView: rateView, // This is the integer RateView value from UserInfo
                companyReference: companyReference, // CompanyReference record ID for margin logic
                companyID: companyID, // CompanyID for margin calculations
                isAdmin: isAdmin // AdminScreen flag
            };
        }
        
        return null;
    } catch (error) {
        console.error('Authentication error:', error);
        
        // Fallback to hardcoded authentication if UserInfo table is not accessible
        console.log('Falling back to hardcoded authentication...');
        if (username === 'BobJ' && password === 'aabbccdd') {
            return {
                username: username,
                rateView: 1 // Default RateView for testing
            };
        }
        
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
    
    // Modal close button
    document.getElementById('closeModal').addEventListener('click', closeSailingsModal);
    
    // Close modal when clicking outside
    window.addEventListener('click', function(event) {
        const sailingsModal = document.getElementById('sailingsModal');
        const contractModal = document.getElementById('contractModal');
        if (event.target === sailingsModal) {
            closeSailingsModal();
        }
        if (event.target === contractModal) {
            closeContractModal();
        }
    });
    
    // Contract modal close button
    document.getElementById('closeContractModal').addEventListener('click', closeContractModal);
    
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
        
        // Load rates filtered by user's RateView
        console.log('Loading rates filtered by user RateView...');
        console.log('User RateView:', currentUserRateOwner);
        
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
            const allRateViews = new Set();
            data.records.forEach(record => {
                const rateView = record.fields['RateView'];
                if (rateView !== undefined && rateView !== null) {
                    if (Array.isArray(rateView)) {
                        rateView.forEach(rv => allRateViews.add(rv));
                    } else {
                        allRateViews.add(rateView);
                    }
                }
            });
            console.log('All RateView values in RateEntry table:', Array.from(allRateViews));
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
            inlandDeliveryLocation: record.fields['Inland Delivery Location'] || 'N/A',
            commodityType: record.fields['CommodityType'] || 'N/A',
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
        
        // Filter rates by user's RateView
        if (currentUserRateOwner !== null && currentUserRateOwner !== undefined) {
            console.log('Filtering rates by user RateView:', currentUserRateOwner);
            
            rateViewFilteredRates = allRates.filter(rate => {
                const rateViews = Array.isArray(rate.rateView) ? rate.rateView : [rate.rateView];
                const matches = rateViews.includes(currentUserRateOwner);
                if (matches) {
                    console.log('Match found for rate:', rate.id, 'RateView:', rateViews);
                }
                return matches;
            });
            
            console.log(`Filtered ${rateViewFilteredRates.length} rates out of ${allRates.length} total rates`);
        } else {
            // If no RateView set, show all rates
            rateViewFilteredRates = [...allRates];
            console.log('No RateView filter applied, showing all rates:', allRates.length);
        }
        
        // Start with RateView-filtered rates
        filteredRates = [...rateViewFilteredRates];
        
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
                        inlandDeliveryLocation: record.fields['Inland Delivery Location'] || 'N/A',
                        commodityType: record.fields['CommodityType'] || 'N/A',
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
                    if (currentUserRateOwner !== null && currentUserRateOwner !== undefined) {
                        console.log('Current user RateView (from UserInfo.RateView):', currentUserRateOwner);
                        
                        // Filter by RateView (integer) - RateEntry.RateView should contain UserInfo.RateView
                        rateViewFilteredRates = allRates.filter(rate => {
                            const rateViews = Array.isArray(rate.rateView) ? rate.rateView : [rate.rateView];
                            const matches = rateViews.includes(currentUserRateOwner);
                            if (matches) {
                                console.log('Match found for rate:', rate.id, 'RateView:', rateViews);
                            }
                            return matches;
                        });
                        
                        console.log(`Filtered ${rateViewFilteredRates.length} rates out of ${allRates.length} total rates`);
                        
                        // If no matches found, let's see what RateView values exist
                        if (rateViewFilteredRates.length === 0) {
                            console.log('No matches found. Available RateView values:');
                            const allRateViews = new Set();
                            allRates.forEach(rate => {
                                const rateViews = Array.isArray(rate.rateView) ? rate.rateView : [rate.rateView];
                                rateViews.forEach(rv => allRateViews.add(rv));
                            });
                            console.log('All RateView values in RateEntry table:', Array.from(allRateViews));
                        }
                    } else {
                        rateViewFilteredRates = [...allRates];
                        console.log('No RateView filter applied, showing all rates:', allRates.length);
                    }
                    
                    // Start with RateView-filtered rates
                    filteredRates = [...rateViewFilteredRates];
                    
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
    // Use rateViewFilteredRates so dropdowns only show options available to the user
    const carriers = [...new Set(rateViewFilteredRates.map(rate => rate.carrier))].filter(Boolean);
    const originPorts = [...new Set(rateViewFilteredRates.map(rate => rate.originPort))].filter(Boolean);
    const destinationPorts = [...new Set(rateViewFilteredRates.map(rate => rate.destinationPort))].filter(Boolean);
    const contractOwners = [...new Set(rateViewFilteredRates.map(rate => rate.contractOwner))].filter(Boolean);
    
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
    
    // Start from rateViewFilteredRates to respect RateView filter
    filteredRates = rateViewFilteredRates.filter(rate => {
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
    
    // Start from rateViewFilteredRates to respect RateView filter
    filteredRates = rateViewFilteredRates.filter(rate => {
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
                <td colspan="13" style="text-align: center; padding: 40px; color: #666;">
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
                <td>${escapeHtml(rate.inlandDeliveryLocation)}</td>
                <td>${escapeHtml(rate.commodityType)}</td>
                <td><a href="#" class="carrier-link" onclick="openSailingsModal('${escapeHtml(rate.carrier)}', '${escapeHtml(rate.originPort)}', '${escapeHtml(rate.destinationPort)}', '${escapeHtml(rate.rateEffectiveDate)}'); return false;">${escapeHtml(rate.carrier)}</a></td>
                <td><a href="#" class="contract-link" onclick="openContractModal('${escapeHtml(rate.contractOwner)}', '${escapeHtml(rate.carrier)}', '${escapeHtml(rate.originPort)}', '${escapeHtml(rate.destinationPort)}', '${escapeHtml(rate.rateEffectiveDate)}', '${escapeHtml(rate.rateExpirationDate)}', '${rate.rate20D}', '${rate.rate40D}', '${rate.rate40HC}'); return false;">${escapeHtml(rate.contractOwner)}</a></td>
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

// Sailings Modal Functions
function openSailingsModal(carrier, originPort, destinationPort, rateEffectiveDate) {
    const modal = document.getElementById('sailingsModal');
    const loading = document.getElementById('sailingsLoading');
    const content = document.getElementById('sailingsContent');
    const error = document.getElementById('sailingsError');
    
    // Show modal and loading state
    modal.style.display = 'block';
    loading.style.display = 'flex';
    content.style.display = 'none';
    error.style.display = 'none';
    
    // Update modal title
    document.getElementById('modalTitle').textContent = `Available Sailings - ${carrier}`;
    
    // Load sailings data
    loadSailingsData(carrier, originPort, destinationPort, rateEffectiveDate);
}

function closeSailingsModal() {
    document.getElementById('sailingsModal').style.display = 'none';
}

async function loadSailingsData(carrier, originPort, destinationPort, rateEffectiveDate) {
    const loading = document.getElementById('sailingsLoading');
    const content = document.getElementById('sailingsContent');
    const error = document.getElementById('sailingsError');
    const summary = document.getElementById('sailingsSummary');
    const tableBody = document.getElementById('sailingsTableBody');
    
    try {
        // Build Airtable filter formula
        // Filter by: Carrier = carrier AND DeparturePort = originPort AND Departure > rateEffectiveDate
        const filterFormula = `AND({Carrier} = "${carrier}", {DeparturePort} = "${originPort}", {Departure} > "${rateEffectiveDate}")`;
        
        console.log('Loading sailings with filter:', filterFormula);
        
        const response = await fetch(`${AIRTABLE_SAILINGS_URL}?filterByFormula=${encodeURIComponent(filterFormula)}&sort[0][field]=Departure&sort[0][direction]=asc`, {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Hide loading, show content
        loading.style.display = 'none';
        content.style.display = 'block';
        
        if (data.records.length === 0) {
            summary.innerHTML = `<p>No sailings found for ${carrier} from ${originPort} departing after ${formatDate(rateEffectiveDate)}.</p>`;
            tableBody.innerHTML = '';
            return;
        }
        
        // Update summary
        summary.innerHTML = `
            <p><strong>${data.records.length}</strong> available sailings found for ${carrier} from ${originPort} to ${destinationPort}.</p>
            <p><strong>Carrier:</strong> ${carrier} | <strong>Route:</strong> ${originPort} → ${destinationPort} | <strong>Departing after:</strong> ${formatDate(rateEffectiveDate)}</p>
        `;
        
        // Populate table
        tableBody.innerHTML = data.records.map(sailing => {
            const departure = formatDate(sailing.fields.Departure);
            const arrival = formatDate(sailing.fields.Arrival);
            const transitTime = sailing.fields.TransitTime || 'N/A';
            const vessel = sailing.fields.Vessel || 'N/A';
            const voyage = sailing.fields.Voyage || 'N/A';
            const service = sailing.fields.Service || 'N/A';
            
            return `
                <tr>
                    <td>${departure}</td>
                    <td>${arrival}</td>
                    <td>${transitTime} days</td>
                    <td>${escapeHtml(vessel)}</td>
                    <td>${escapeHtml(voyage)}</td>
                    <td>${escapeHtml(service)}</td>
                </tr>
            `;
        }).join('');
        
    } catch (err) {
        console.error('Error loading sailings:', err);
        loading.style.display = 'none';
        error.style.display = 'flex';
        document.getElementById('sailingsErrorMessage').textContent = `Failed to load sailings: ${err.message}`;
    }
}

// Contract Modal Functions
function openContractModal(contractOwner, carrier, originPort, destinationPort, rateEffectiveDate, rateExpirationDate, rate20D, rate40D, rate40HC) {
    const modal = document.getElementById('contractModal');
    modal.style.display = 'block';
    loadContractData(contractOwner, carrier, originPort, destinationPort, rateEffectiveDate, rateExpirationDate, rate20D, rate40D, rate40HC);
}

function closeContractModal() {
    document.getElementById('contractModal').style.display = 'none';
}

function loadContractData(contractOwner, carrier, originPort, destinationPort, rateEffectiveDate, rateExpirationDate, rate20D, rate40D, rate40HC) {
    // Generate dynamic contract information based on the data
    const contractId = generateContractId(contractOwner, carrier);
    const contractTitle = `${carrier} Annual Contract with ${contractOwner} for Spot Rates`;
    
    // Update contract details with dynamic information
    document.getElementById('contractTitle').textContent = contractTitle;
    document.getElementById('contractId').textContent = `Contract ID: ${contractId}`;
    document.getElementById('contractType').textContent = 'Annual Contract';
    
    // Update contract rates with the actual rates from the rate entry
    document.getElementById('contract20D').textContent = `$${formatNumber(parseFloat(rate20D))}`;
    document.getElementById('contract40D').textContent = `$${formatNumber(parseFloat(rate40D))}`;
    document.getElementById('contract40HC').textContent = `$${formatNumber(parseFloat(rate40HC))}`;
    
    // Update validity and route info
    document.getElementById('contractValidity').textContent = `${formatDate(rateEffectiveDate)} to ${formatDate(rateExpirationDate)}`;
    document.getElementById('contractRoute').textContent = `${originPort} → ${destinationPort}`;
}

function generateContractId(contractOwner, carrier) {
    // Generate a dynamic contract ID based on contract owner and carrier
    const ownerPrefix = contractOwner.substring(0, 3).toUpperCase();
    const carrierPrefix = carrier.substring(0, 2).toUpperCase();
    const randomNum = Math.floor(Math.random() * 9000) + 1000; // 4-digit random number
    return `${ownerPrefix}${carrierPrefix}${randomNum}`;
}

// Global logout function
function performLogout() {
    console.log('Performing logout');
    localStorage.removeItem('loggedInUser');
    localStorage.removeItem('userRateView');
    localStorage.removeItem('userCompanyReference');
    localStorage.removeItem('userCompanyID');
    localStorage.removeItem('userIsAdmin');
    currentUserRateOwner = null;
    currentUserCompanyReference = null;
    currentUserCompanyID = null;
    currentUserIsAdmin = false;
    
    // Show login page
    const loginPage = document.getElementById('loginPage');
    const mainPage = document.getElementById('mainPage');
    const adminScreen = document.getElementById('adminScreen');
    const loginForm = document.getElementById('loginForm');
    
    if (loginPage && mainPage && adminScreen) {
        loginPage.style.display = 'block';
        mainPage.style.display = 'none';
        adminScreen.style.display = 'none';
        if (loginForm) {
            loginForm.reset();
        }
    }
}

// ================== ADMIN SCREEN FUNCTIONS ==================

// Setup hamburger menu for admin users
function setupAdminMenu() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const hamburgerMenu = document.getElementById('hamburgerMenu');
    const rateAdjustmentLink = document.getElementById('rateAdjustmentLink');
    
    console.log('Setting up admin menu. currentUserIsAdmin:', currentUserIsAdmin);
    
    if (currentUserIsAdmin) {
        // Show hamburger button
        hamburgerBtn.style.display = 'inline-block';
        console.log('Hamburger button shown');
        
        // Remove existing click handler to avoid duplicates
        const newHamburgerBtn = hamburgerBtn.cloneNode(true);
        hamburgerBtn.parentNode.replaceChild(newHamburgerBtn, hamburgerBtn);
        
        // Toggle menu
        newHamburgerBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            console.log('Hamburger clicked');
            const isVisible = hamburgerMenu.style.display === 'block';
            hamburgerMenu.style.display = isVisible ? 'none' : 'block';
            console.log('Menu display set to:', hamburgerMenu.style.display);
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', function(e) {
            if (!newHamburgerBtn.contains(e.target) && !hamburgerMenu.contains(e.target)) {
                hamburgerMenu.style.display = 'none';
            }
        });
        
        // Handle Rate Adjustment link
        rateAdjustmentLink.addEventListener('click', function(e) {
            e.preventDefault();
            console.log('Rate Adjustment link clicked');
            showAdminScreen();
            hamburgerMenu.style.display = 'none';
        });
    } else {
        // Hide hamburger button for non-admin users
        hamburgerBtn.style.display = 'none';
        console.log('User is not admin, hamburger button hidden');
    }
}

// Show admin screen
function showAdminScreen() {
    const mainPage = document.getElementById('mainPage');
    const adminScreen = document.getElementById('adminScreen');
    
    mainPage.style.display = 'none';
    adminScreen.style.display = 'block';
    
    loadAdminCompanies();
}

// Go back to main page
function backToMain() {
    const mainPage = document.getElementById('mainPage');
    const adminScreen = document.getElementById('adminScreen');
    
    adminScreen.style.display = 'none';
    mainPage.style.display = 'block';
}

// Store for company data
let adminCompanies = [];
let adminChanges = {};

// Load companies for admin screen
async function loadAdminCompanies() {
    const adminLoading = document.getElementById('adminLoading');
    const adminError = document.getElementById('adminError');
    const adminTableContainer = document.getElementById('adminTableContainer');
    
    adminLoading.style.display = 'block';
    adminError.style.display = 'none';
    adminTableContainer.style.display = 'none';
    
    try {
        // Fetch all CompanyReference records
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
        
        // Filter for companies with CompanyType=2 and matching RateView
        adminCompanies = data.records.filter(record => {
            const companyType = record.fields.CompanyType;
            const companyTypeId = Array.isArray(companyType) ? companyType[0] : companyType;
            
            // CompanyType field is a link to another table, check if it matches the expected record ID
            // For CompanyType=2, we need to check the linked record
            // For now, we'll filter by checking if the record has the expected structure
            
            return companyTypeId && record.fields.RateView === currentUserRateOwner;
        });
        
        console.log('Filtered admin companies:', adminCompanies);
        
        // Reset changes tracking
        adminChanges = {};
        
        // Render the table
        renderAdminTable();
        
        adminLoading.style.display = 'none';
        adminTableContainer.style.display = 'block';
        
    } catch (error) {
        console.error('Error loading companies:', error);
        adminLoading.style.display = 'none';
        adminError.style.display = 'block';
        document.getElementById('adminErrorMessage').textContent = `Failed to load companies: ${error.message}`;
    }
}

// Render admin table
function renderAdminTable() {
    const tableBody = document.getElementById('adminTableBody');
    
    if (adminCompanies.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="3" style="text-align: center; padding: 40px; color: #666;">
                    <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 15px; display: block;"></i>
                    No companies found matching your criteria
                </td>
            </tr>
        `;
        return;
    }
    
    tableBody.innerHTML = adminCompanies.map(company => {
        const companyName = company.fields.CompanyName || 'N/A';
        const marginPercent = company.fields.MarginPercent || 0;
        const marginNumber = company.fields.MarginNumber || 0;
        const recordId = company.id;
        
        return `
            <tr data-record-id="${recordId}">
                <td>${escapeHtml(companyName)}</td>
                <td>
                    <input 
                        type="number" 
                        step="0.01" 
                        value="${marginPercent}" 
                        data-field="MarginPercent"
                        data-record-id="${recordId}"
                        onchange="trackChange(this)"
                    />
                </td>
                <td>
                    <input 
                        type="number" 
                        step="0.01" 
                        value="${marginNumber}" 
                        data-field="MarginNumber"
                        data-record-id="${recordId}"
                        onchange="trackChange(this)"
                    />
                </td>
            </tr>
        `;
    }).join('');
}

// Track changes
function trackChange(input) {
    const recordId = input.dataset.recordId;
    const field = input.dataset.field;
    const value = parseFloat(input.value) || 0;
    
    if (!adminChanges[recordId]) {
        adminChanges[recordId] = {};
    }
    
    adminChanges[recordId][field] = value;
    input.classList.add('changed');
    
    console.log('Changes tracked:', adminChanges);
}

// Make trackChange global
window.trackChange = trackChange;

// Save changes
async function saveAdminChanges() {
    const saveBtn = document.getElementById('saveChangesBtn');
    
    if (Object.keys(adminChanges).length === 0) {
        alert('No changes to save');
        return;
    }
    
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    
    try {
        // Update each changed record
        const updatePromises = Object.entries(adminChanges).map(async ([recordId, fields]) => {
            const response = await fetch(`${AIRTABLE_COMPANY_URL}/${recordId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fields: fields
                })
            });
            
            if (!response.ok) {
                throw new Error(`Failed to update record ${recordId}`);
            }
            
            return response.json();
        });
        
        await Promise.all(updatePromises);
        
        // Success
        alert('Changes saved successfully!');
        adminChanges = {};
        
        // Remove changed class from inputs
        document.querySelectorAll('.admin-table input.changed').forEach(input => {
            input.classList.remove('changed');
        });
        
        // Reload company reference data for margin calculations
        await fetchCompanyReferenceData();
        
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
        saveBtn.disabled = false;
        
    } catch (error) {
        console.error('Error saving changes:', error);
        alert(`Failed to save changes: ${error.message}`);
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
        saveBtn.disabled = false;
    }
}

// Setup admin screen event listeners
document.addEventListener('DOMContentLoaded', function() {
    const backToMainBtn = document.getElementById('backToMainBtn');
    const saveChangesBtn = document.getElementById('saveChangesBtn');
    
    if (backToMainBtn) {
        backToMainBtn.addEventListener('click', backToMain);
    }
    
    if (saveChangesBtn) {
        saveChangesBtn.addEventListener('click', saveAdminChanges);
    }
});

