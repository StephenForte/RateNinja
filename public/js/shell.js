import { clearCsrf, rememberCsrf, request, showLoginPage } from './api.js';
import { companyIndicator, contextFromPayload, permissionsFromUser } from './permissions.js';
import { oauthNextFromSearch } from './oauth-next.js';
import { isClientRoute, resolveRoute } from './router.js';
import { menuFor } from './menu.js';
import { showRates } from './rates/browse.js';

const ICONS = {
    rates: 'fa-ship',
    account: 'fa-user-circle',
    security: 'fa-shield-alt',
    preferences: 'fa-cog',
    'connected-apps': 'fa-link',
    users: 'fa-user-lock',
    companies: 'fa-building',
    customers: 'fa-percent',
    data: 'fa-database',
    'pull-forward': 'fa-forward',
    imports: 'fa-file-import',
    integrations: 'fa-book',
    'oauth-clients': 'fa-key'
};

let user = null;
let permissions = permissionsFromUser(null);
let activeSection = null;
let activeUnmount = null;
let renderGeneration = 0;

const app = () => document.getElementById('app');
const menuButton = () => document.getElementById('menuButton');
const menu = () => document.getElementById('appMenu');

export async function boot() {
    bindShell();
    try {
        const payload = await request('/api/session', { allowUnauthenticated: true });
        rememberAuth(payload);
        if (followOauthNext()) return;
        permissions = permissionsFromUser(user);
        if (permissions.systemAdmin) {
            try {
                const contextPayload = await request('/api/admin/context');
                const companyContext = contextFromPayload(contextPayload);
                if (companyContext) permissions = { ...permissions, companyContext };
            } catch (error) {
                if (error.status === 401) return;
            }
        }
        app().hidden = false;
        renderMenu();
        renderIndicator();
        await renderRoute();
    } catch {
        showLoginPage();
    }
}

function rememberAuth(payload) {
    rememberCsrf(payload?.csrfToken);
    user = payload?.user || null;
}

function followOauthNext() {
    const next = oauthNextFromSearch(location.search);
    if (!next) return false;
    location.replace(next);
    return true;
}

function bindShell() {
    const button = menuButton();
    const nav = menu();
    document.getElementById('logoutBtn').addEventListener('click', logout);
    button.addEventListener('click', event => {
        event.stopPropagation();
        setMenuOpen(nav.hidden);
    });
    button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (nav.hidden) setMenuOpen(true);
            focusItem(event.key === 'ArrowUp' ? -1 : 0);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setMenuOpen(false);
        }
    });
    nav.addEventListener('keydown', event => {
        const items = menuItems();
        const index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            setMenuOpen(false);
            button.focus();
            return;
        }
        if (!items.length) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            items[(index + 1 + items.length) % items.length].focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            items[(index - 1 + items.length) % items.length].focus();
        } else if (event.key === 'Home') {
            event.preventDefault();
            items[0].focus();
        } else if (event.key === 'End') {
            event.preventDefault();
            items[items.length - 1].focus();
        }
    });
    document.addEventListener('click', event => {
        const link = event.target.closest && event.target.closest('a[href]');
        if (link && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            const href = link.getAttribute('href');
            if (href && href.startsWith('/')) {
                const url = new URL(href, location.origin);
                if (url.origin === location.origin && isClientRoute(url.pathname)) {
                    event.preventDefault();
                    navigate(url.pathname);
                    return;
                }
            }
        }
        if (!nav.hidden && !nav.contains(event.target) && !button.contains(event.target)) {
            setMenuOpen(false);
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !nav.hidden && document.activeElement !== button && !nav.contains(document.activeElement)) {
            setMenuOpen(false);
            button.focus();
        }
    });
    window.addEventListener('popstate', () => {
        renderRoute();
    });
    document.getElementById('notFoundHome').addEventListener('click', () => navigate('/rates'));
    document.getElementById('deniedHome').addEventListener('click', () => navigate('/rates'));
}

function menuItems() {
    return [...menu().querySelectorAll('[role="menuitem"]')];
}

function focusItem(index) {
    const items = menuItems();
    if (!items.length) return;
    const next = index < 0 ? items.length - 1 : index;
    items[next].focus();
}

function setMenuOpen(open) {
    const nav = menu();
    const button = menuButton();
    nav.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}

function renderMenu() {
    const nav = menu();
    nav.replaceChildren();
    let group = '';
    for (const item of menuFor(permissions)) {
        if (item.group !== group) {
            const label = document.createElement('div');
            label.className = 'menu-group-label';
            label.setAttribute('role', 'presentation');
            label.textContent = item.group;
            nav.append(label);
            group = item.group;
        }
        const link = document.createElement('a');
        link.className = 'menu-item';
        link.href = item.path;
        link.setAttribute('role', 'menuitem');
        const icon = document.createElement('i');
        icon.className = `fas ${ICONS[item.id] || 'fa-circle'}`;
        icon.setAttribute('aria-hidden', 'true');
        link.append(icon, document.createTextNode(` ${item.label}`));
        nav.append(link);
    }
}

function renderIndicator() {
    const node = document.getElementById('companyContext');
    const indicator = companyIndicator(permissions);
    node.hidden = !indicator.visible;
    node.textContent = indicator.text;
}

function welcome() {
    document.getElementById('welcomeText').textContent = `Welcome, ${user.username}`;
}

async function logout() {
    try {
        await request('/api/auth/logout', { method: 'POST', allowUnauthenticated: true });
    } catch {
        // A failed logout should still clear the local UI state.
    }
    user = null;
    permissions = permissionsFromUser(null);
    clearCsrf();
    showLoginPage();
}

export function navigate(path) {
    if (location.pathname !== path) history.pushState({}, '', path);
    setMenuOpen(false);
    return renderRoute();
}

async function renderRoute() {
    const generation = ++renderGeneration;
    welcome();
    renderIndicator();
    const decision = resolveRoute(location.pathname, permissions);
    if (decision.kind === 'redirect') {
        history.replaceState({}, '', decision.path);
        if (generation !== renderGeneration) return;
        return renderRoute();
    }
    setMenuOpen(false);
    markCurrent(decision);
    hideViews();
    if (decision.kind === 'not-found') {
        document.title = 'Rate Ninja | Not found';
        document.getElementById('notFoundView').hidden = false;
        return;
    }
    if (decision.kind === 'access-denied') {
        document.title = 'Rate Ninja | Access denied';
        document.getElementById('deniedMessage').textContent = `You do not have access to ${decision.section.label}.`;
        document.getElementById('deniedView').hidden = false;
        return;
    }
    document.title = `Rate Ninja | ${decision.section.label}`;
    if (decision.section.id === 'rates') {
        document.getElementById('ratesView').hidden = false;
        await showRates();
        return;
    }
    document.getElementById('sectionView').hidden = false;
    if (activeSection === decision.section.id) return;
    clearSection();
    const slot = document.createElement('div');
    document.getElementById('sectionMount').append(slot);
    const module = await decision.section.load();
    if (generation !== renderGeneration) return;
    activeSection = decision.section.id;
    activeUnmount = module.unmount;
    await module.mount(slot, {
        user,
        permissions,
        onSignedOut() {
            user = null;
            permissions = permissionsFromUser(null);
        }
    });
}

function markCurrent(decision) {
    const currentPath = decision.kind === 'section' ? decision.section.path : '';
    for (const link of menu().querySelectorAll('[role="menuitem"]')) {
        if (link.getAttribute('href') === currentPath) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
}

function hideViews() {
    document.getElementById('ratesView').hidden = true;
    document.getElementById('sectionView').hidden = true;
    document.getElementById('notFoundView').hidden = true;
    document.getElementById('deniedView').hidden = true;
    document.getElementById('sailingsModal').hidden = true;
    document.getElementById('contractModal').hidden = true;
}

function clearSection() {
    if (activeUnmount) activeUnmount();
    activeUnmount = null;
    activeSection = null;
    document.getElementById('sectionMount').replaceChildren();
}
