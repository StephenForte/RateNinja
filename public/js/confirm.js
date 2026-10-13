export function companyOperationGate(permissions, action) {
    const selected = permissions && permissions.companyContext && permissions.companyContext.name
        ? permissions.companyContext.name
        : '';
    if (permissions && permissions.systemAdmin === true) {
        if (!selected) {
            return {
                allowed: false,
                companyName: '',
                message: 'Select a company before this operation.'
            };
        }
        return {
            allowed: true,
            companyName: selected,
            message: `${action} This applies to ${selected}.`
        };
    }
    const companyName = selected || (permissions && permissions.companyName) || 'your company';
    return {
        allowed: true,
        companyName,
        message: `${action} This applies to ${companyName}.`
    };
}
