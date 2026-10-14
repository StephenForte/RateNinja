function signedIn(permissions) {
    return permissions.signedIn === true;
}

function ownerAdmin(permissions) {
    return permissions.companyAdmin === true && permissions.contractOwner === true;
}

function ownerOrSystem(permissions) {
    return permissions.systemAdmin === true || ownerAdmin(permissions);
}

function anyAdmin(permissions) {
    return permissions.systemAdmin === true || permissions.companyAdmin === true;
}

// OAuth client registration is system-admin only once the session carries D-009
// permissions. Until then it stays on the old admin screen, which any company
// admin could open.
function allowOauthClients(permissions) {
    if (permissions.systemAdmin === true) return true;
    return permissions.legacy === true && permissions.companyAdmin === true;
}

export const sections = [
    {
        area: 'rates',
        id: 'rates',
        label: 'Rates',
        group: 'Rates',
        path: '/rates',
        allow: signedIn,
        load: () => import('./rates/browse.js')
    },
    {
        area: 'profile',
        id: 'account',
        label: 'Account',
        group: 'Profile',
        path: '/profile/account',
        allow: signedIn,
        load: () => import('./profile/account.js')
    },
    {
        area: 'profile',
        id: 'security',
        label: 'Security',
        group: 'Profile',
        path: '/profile/security',
        allow: signedIn,
        load: () => import('./profile/security.js')
    },
    {
        area: 'profile',
        id: 'preferences',
        label: 'Preferences',
        group: 'Profile',
        path: '/profile/preferences',
        allow: signedIn,
        load: () => import('./profile/preferences.js')
    },
    {
        area: 'profile',
        id: 'connected-apps',
        label: 'Connected apps',
        group: 'Profile',
        path: '/profile/connected-apps',
        allow: permissions => signedIn(permissions) && permissions.contractOwner === true,
        load: () => import('./profile/connected-apps.js')
    },
    {
        area: 'admin',
        id: 'users',
        label: 'Users',
        group: 'Admin',
        path: '/admin/users',
        allow: permissions => permissions.companyAdmin === true || permissions.systemAdmin === true,
        load: () => import('./admin/users.js')
    },
    {
        area: 'admin',
        id: 'companies',
        label: 'Companies',
        group: 'Admin',
        path: '/admin/companies',
        allow: permissions => permissions.systemAdmin === true,
        load: () => import('./admin/companies.js')
    },
    {
        area: 'admin',
        id: 'customers',
        label: 'Customers',
        group: 'Admin',
        path: '/admin/customers',
        allow: ownerOrSystem,
        load: () => import('./admin/customers.js')
    },
    {
        area: 'admin',
        id: 'data',
        label: 'Data',
        group: 'Admin',
        path: '/admin/data',
        allow: ownerOrSystem,
        load: () => import('./admin/data.js')
    },
    {
        area: 'admin',
        id: 'pull-forward',
        label: 'Pull forward',
        group: 'Admin',
        path: '/admin/pull-forward',
        allow: ownerOrSystem,
        load: () => import('./admin/pull-forward.js')
    },
    {
        area: 'admin',
        id: 'imports',
        label: 'Imports',
        group: 'Admin',
        path: '/admin/imports',
        allow: ownerOrSystem,
        load: () => import('./admin/imports.js')
    },
    {
        area: 'admin',
        id: 'integrations',
        label: 'Integrations',
        group: 'Admin',
        path: '/admin/integrations',
        allow: anyAdmin,
        load: () => import('./admin/integrations.js')
    },
    {
        area: 'admin',
        id: 'oauth-clients',
        label: 'OAuth clients',
        group: 'Admin',
        path: '/admin/oauth-clients',
        allow: allowOauthClients,
        load: () => import('./admin/oauth-clients.js')
    }
];

export function sectionById(id) {
    return sections.find(section => section.id === id) || null;
}
