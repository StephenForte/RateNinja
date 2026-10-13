export const ANONYMOUS = Object.freeze({
    signedIn: false,
    systemAdmin: false,
    companyAdmin: false,
    contractOwner: false,
    legacy: false,
    companyContext: null,
    companyName: ''
});

export function normalizeCompanyContext(value) {
    if (!value || typeof value !== 'object') return null;
    const id = typeof value.id === 'string' ? value.id : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!id && !name) return null;
    return { id, name };
}

// R1-02 may return the context on the session or from GET /api/admin/context.
export function contextFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    return normalizeCompanyContext(payload.companyContext)
        || normalizeCompanyContext(payload.company)
        || normalizeCompanyContext(payload);
}

export function permissionsFromUser(user) {
    if (!user || typeof user !== 'object') return { ...ANONYMOUS };
    const companyName = typeof user.companyName === 'string' ? user.companyName : '';
    const companyContext = normalizeCompanyContext(user.companyContext);
    if (user.permissions && typeof user.permissions === 'object') {
        return {
            signedIn: true,
            systemAdmin: user.permissions.systemAdmin === true,
            companyAdmin: user.permissions.companyAdmin === true,
            contractOwner: user.permissions.contractOwner === true,
            legacy: false,
            companyContext,
            companyName
        };
    }
    return {
        signedIn: true,
        systemAdmin: false,
        companyAdmin: user.isAdmin === true,
        contractOwner: user.isContractOwner === true,
        legacy: true,
        companyContext,
        companyName
    };
}

export function companyIndicator(permissions) {
    if (!permissions || permissions.systemAdmin !== true) return { visible: false, text: '' };
    const name = permissions.companyContext && permissions.companyContext.name;
    if (!name) return { visible: true, text: 'No company selected' };
    return { visible: true, text: `Selected company: ${name}` };
}
