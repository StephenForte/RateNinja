import { sections } from './registry.js';

function stripTrailingSlash(pathname) {
    if (typeof pathname !== 'string' || pathname.length <= 1) return pathname || '/';
    return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function isClientRoute(pathname) {
    const path = stripTrailingSlash(pathname);
    if (path === '/' || path === '/index.html' || path === '/rates' || path === '/profile') return true;
    return /^\/profile\/[A-Za-z0-9-]+$/.test(path) || /^\/admin\/[A-Za-z0-9-]+$/.test(path);
}

export function resolveRoute(pathname, permissions) {
    const path = stripTrailingSlash(pathname);
    if (path === '/' || path === '/index.html') return { kind: 'redirect', path: '/rates' };
    if (path === '/profile') return { kind: 'redirect', path: '/profile/account' };
    if (path === '/rates') {
        const section = sections.find(item => item.id === 'rates');
        if (!section.allow(permissions)) return { kind: 'access-denied', section };
        return { kind: 'section', section };
    }
    const profile = path.match(/^\/profile\/([A-Za-z0-9-]+)$/);
    const admin = path.match(/^\/admin\/([A-Za-z0-9-]+)$/);
    const id = profile ? profile[1] : admin ? admin[1] : null;
    const area = profile ? 'profile' : admin ? 'admin' : null;
    if (!id) return { kind: 'not-found' };
    const section = sections.find(item => item.area === area && item.id === id);
    if (!section) return { kind: 'not-found' };
    if (!section.allow(permissions)) return { kind: 'access-denied', section };
    return { kind: 'section', section };
}
