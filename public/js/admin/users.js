import { clearCsrf, request, showLoginPage } from '../api.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';

export async function mount(container, ctx) {
    container.replaceChildren();
    const errors = errorBox();
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['User', 'Company', 'Email', 'Password', '']) headRow.append(textCell(label, 'th'));
    head.append(headRow);
    const body = document.createElement('tbody');
    table.append(head, body);
    wrap.append(table);
    container.append(
        heading('User passwords'),
        paragraph('pull-forward-subtitle', 'Set a password of at least 12 characters, or save the email address used for password reset. Clearing two-factor signs that user out. Enrollment stays optional.'),
        errors.box,
        wrap
    );

    function showActionError(error) {
        errors.show(error.message);
    }

    async function reload() {
        errors.hide();
        const { users } = await request('/api/admin/users');
        render(users);
    }

    function signedOut() {
        clearCsrf();
        ctx.onSignedOut();
        showLoginPage();
    }

    async function setUserEmail(user, email) {
        try {
            await request(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ email })
            });
            await reload();
        } catch (error) {
            showActionError(error);
        }
    }

    async function clearUserMfa(user) {
        try {
            const result = await request(`/api/admin/users/${user.id}/two-factor`, { method: 'DELETE' });
            if (result.signedOut) {
                signedOut();
                return;
            }
            await reload();
        } catch (error) {
            showActionError(error);
        }
    }

    async function setUserPassword(user, password, button) {
        button.disabled = true;
        try {
            const result = await request(`/api/admin/users/${user.id}/password`, {
                method: 'POST',
                body: JSON.stringify({ password })
            });
            if (result.signedOut) {
                signedOut();
                return;
            }
            await reload();
        } catch (error) {
            showActionError(error);
        } finally {
            button.disabled = false;
        }
    }

    async function setUserDisabled(user, disabled) {
        try {
            await request(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ disabled })
            });
            await reload();
        } catch (error) {
            showActionError(error);
        }
    }

    function render(users) {
        body.replaceChildren();
        users.forEach(user => {
            const row = document.createElement('tr');
            const email = document.createElement('input');
            email.type = 'email';
            email.value = user.email || '';
            email.autocomplete = 'off';
            const emailCell = document.createElement('td');
            emailCell.append(email);
            const password = document.createElement('input');
            password.type = 'password';
            password.autocomplete = 'new-password';
            password.minLength = 12;
            const passwordCell = document.createElement('td');
            passwordCell.append(password);
            const actions = document.createElement('td');
            const saveEmail = document.createElement('button');
            saveEmail.type = 'button';
            saveEmail.className = 'back-btn';
            saveEmail.textContent = 'Save email';
            saveEmail.addEventListener('click', () => setUserEmail(user, email.value));
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'save-btn';
            save.textContent = 'Set password';
            save.addEventListener('click', () => setUserPassword(user, password.value, save));
            actions.append(saveEmail, save);
            if (user.totpEnabled) {
                const clearMfa = document.createElement('button');
                clearMfa.type = 'button';
                clearMfa.className = 'back-btn';
                clearMfa.textContent = 'Clear 2FA';
                clearMfa.addEventListener('click', () => clearUserMfa(user));
                actions.append(clearMfa);
            }
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'back-btn';
            toggle.textContent = user.disabled ? 'Enable' : 'Disable';
            toggle.addEventListener('click', () => setUserDisabled(user, !user.disabled));
            actions.append(toggle);
            const label = `${user.displayName || user.username}${user.hasPassword ? '' : ' (no password)'}${user.totpEnabled ? ' · 2FA' : ''}`;
            row.append(
                textCell(label),
                textCell(`${user.companyName || '—'} · ${user.companyType || '—'}`),
                emailCell,
                passwordCell,
                actions
            );
            body.append(row);
        });
    }

    try {
        await reload();
    } catch (error) {
        errors.show(`Failed to load administration data: ${error.message}`);
    }
}

export function unmount() {}
