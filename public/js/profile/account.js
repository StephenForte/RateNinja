import { request } from '../api.js';
import { errorBox, heading, paragraph } from '../dom.js';
import { mountPasswordForm } from '../password-required.js';

function detail(label, value) {
    const term = document.createElement('dt');
    term.textContent = label;
    const data = document.createElement('dd');
    data.textContent = value || 'Not set';
    return [term, data];
}

export async function mount(container) {
    container.replaceChildren();
    const profile = document.createElement('div');
    profile.id = 'accountProfile';
    const details = document.createElement('dl');
    details.className = 'account-details';
    const errors = errorBox();
    profile.append(
        heading('Account'),
        details,
        errors.box,
        heading('Password'),
        paragraph('pull-forward-subtitle', 'Use your current password. You will sign in again after it changes.')
    );
    container.append(profile);
    mountPasswordForm(profile);
    try {
        const account = await request('/api/account');
        const company = account.company || account.companyName || '';
        details.append(
            ...detail('Display name', account.displayName),
            ...detail('Login name', account.loginName),
            ...detail('Email', account.email),
            ...detail('Company', company),
            ...detail('Role', account.role)
        );
    } catch (error) {
        errors.show(error.message);
    }
}

export function unmount() {}
