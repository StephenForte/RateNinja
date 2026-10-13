import { oauthNextFromSearch } from './oauth-next.js';

let csrfToken = null;

export function rememberCsrf(token) {
    if (token) csrfToken = token;
}

export function clearCsrf() {
    csrfToken = null;
}

export function showLoginPage() {
    const next = oauthNextFromSearch(location.search);
    location.replace(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
}

export async function request(path, options = {}) {
    const { allowUnauthenticated = false, ...fetchOptions } = options;
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const response = await fetch(path, {
        ...fetchOptions,
        headers: {
            ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
            ...(csrfToken && method !== 'GET' && method !== 'HEAD' ? { 'X-CSRF-Token': csrfToken } : {}),
            ...fetchOptions.headers
        }
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 && !allowUnauthenticated) showLoginPage();
        const error = new Error(payload.error || 'Request failed.');
        error.status = response.status;
        error.code = typeof payload.code === 'string' ? payload.code : '';
        throw error;
    }
    return payload;
}
