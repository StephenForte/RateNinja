export function safeOauthNext(value) {
    if (typeof value !== 'string' || !value.startsWith('/oauth/authorize?')) return null;
    if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return null;
    try {
        const url = new URL(value, 'http://localhost');
        if (url.origin !== 'http://localhost' || url.pathname !== '/oauth/authorize') return null;
        return `${url.pathname}${url.search}`;
    } catch {
        return null;
    }
}

export function oauthNextFromSearch(search) {
    return safeOauthNext(new URLSearchParams(search).get('next'));
}
