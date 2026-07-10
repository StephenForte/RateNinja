const elements = {
    baseUrl: document.getElementById('baseUrl'),
    apiKey: document.getElementById('apiKey'),
    toggleKey: document.getElementById('toggleKey'),
    endpoints: [...document.querySelectorAll('.endpoint')],
    ratesForm: document.getElementById('ratesForm'),
    sailingsForm: document.getElementById('sailingsForm'),
    endpointTitle: document.getElementById('endpointTitle'),
    requestCode: document.getElementById('requestCode'),
    copyRequest: document.getElementById('copyRequest'),
    responseStatus: document.getElementById('responseStatus'),
    responseMeta: document.getElementById('responseMeta'),
    responseBody: document.getElementById('responseBody')
};

const endpointDetails = {
    rates: { title: 'Search ocean rates', path: '/api/v1/rates', form: elements.ratesForm },
    sailings: { title: 'Find available sailings', path: '/api/v1/sailings', form: elements.sailingsForm }
};

let activeTab = 'rates';

elements.baseUrl.value = window.location.protocol.startsWith('http') ? window.location.origin : 'http://localhost:3000';

elements.endpoints.forEach(button => button.addEventListener('click', () => setActiveTab(button.dataset.tab)));
elements.ratesForm.addEventListener('submit', event => runRequest(event, 'rates'));
elements.sailingsForm.addEventListener('submit', event => runRequest(event, 'sailings'));
elements.baseUrl.addEventListener('input', updateRequestPreview);
elements.apiKey.addEventListener('input', updateRequestPreview);
[...elements.ratesForm.elements, ...elements.sailingsForm.elements].forEach(input => input.addEventListener('input', updateRequestPreview));
elements.toggleKey.addEventListener('click', toggleApiKey);
elements.copyRequest.addEventListener('click', copyRequest);

function setActiveTab(tab) {
    activeTab = tab;
    const detail = endpointDetails[tab];
    elements.endpoints.forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    Object.entries(endpointDetails).forEach(([name, item]) => { item.form.hidden = name !== tab; });
    elements.endpointTitle.textContent = detail.title;
    updateRequestPreview();
}

function buildRequest(tab) {
    const detail = endpointDetails[tab];
    const values = new FormData(detail.form);
    const params = new URLSearchParams();
    for (const [key, value] of values.entries()) {
        if (String(value).trim()) params.set(key, value);
    }
    const base = elements.baseUrl.value.trim().replace(/\/$/, '') || 'http://localhost:3000';
    const url = new URL(`${base}${detail.path}`);
    url.search = params.toString();
    return url;
}

function updateRequestPreview() {
    const url = buildRequest(activeTab);
    const hasKey = Boolean(elements.apiKey.value.trim());
    elements.requestCode.textContent = `curl "${url}" \\\n+  -H "X-API-Key: ${hasKey ? '••••••••••••••••' : 'your-demo-api-key'}"`;
}

async function runRequest(event, tab) {
    event.preventDefault();
    if (!elements.apiKey.value.trim()) {
        setResponse('error', 'API key required', { error: 'Enter your demo API key before running a request.' });
        elements.apiKey.focus();
        return;
    }
    const form = endpointDetails[tab].form;
    const button = form.querySelector('.run-button');
    const url = buildRequest(tab);
    button.disabled = true;
    setResponse('loading', 'Requesting…', { loading: true, endpoint: url.pathname });
    try {
        const response = await fetch(url, { headers: { 'X-API-Key': elements.apiKey.value.trim() } });
        const text = await response.text();
        let payload;
        try { payload = JSON.parse(text); } catch { payload = { response: text }; }
        const statusType = response.ok ? 'success' : 'error';
        const total = payload.meta?.total;
        const message = response.ok
            ? `${response.status} OK${Number.isFinite(total) ? ` · ${total} result${total === 1 ? '' : 's'}` : ''}`
            : `${response.status} ${response.statusText}`;
        setResponse(statusType, message, payload);
    } catch (error) {
        setResponse('error', 'Network error', { error: error.message, hint: 'Confirm the base URL and that the local Rate Ninja server is running.' });
    } finally {
        button.disabled = false;
    }
}

function setResponse(status, label, payload) {
    elements.responseStatus.className = `response-status ${status}`;
    elements.responseStatus.textContent = label;
    elements.responseMeta.textContent = status === 'loading' ? 'Connecting to Rate Ninja…' : new Date().toLocaleTimeString();
    elements.responseBody.textContent = JSON.stringify(payload, null, 2);
}

function toggleApiKey() {
    const hidden = elements.apiKey.type === 'password';
    elements.apiKey.type = hidden ? 'text' : 'password';
    elements.toggleKey.innerHTML = `<i class="fa-regular fa-eye${hidden ? '-slash' : ''}"></i>`;
    elements.toggleKey.setAttribute('aria-label', hidden ? 'Hide API key' : 'Show API key');
}

async function copyRequest() {
    try {
        await navigator.clipboard.writeText(elements.requestCode.textContent.replace('••••••••••••••••', elements.apiKey.value.trim() || 'your-demo-api-key'));
        elements.copyRequest.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
        setTimeout(() => { elements.copyRequest.innerHTML = '<i class="fa-regular fa-copy"></i> Copy'; }, 1600);
    } catch {
        elements.copyRequest.textContent = 'Copy unavailable';
    }
}

updateRequestPreview();
