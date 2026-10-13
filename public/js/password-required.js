import { request } from './api.js';
import { errorBox, fieldLabel, heading, paragraph } from './dom.js';

function passwordField(labelText, name, autocomplete) {
    const input = document.createElement('input');
    input.type = 'password';
    input.name = name;
    input.id = name;
    input.autocomplete = autocomplete;
    input.required = true;
    const error = document.createElement('p');
    error.className = 'field-error';
    error.hidden = true;
    error.id = `${name}Error`;
    input.setAttribute('aria-describedby', error.id);
    const label = fieldLabel(`${labelText} `, input);
    return { input, error, label };
}

function fieldName(error) {
    const message = String(error?.message || '');
    if (/current password/i.test(message)) return 'currentPassword';
    if (/confirmation/i.test(message)) return 'confirmPassword';
    if (/password must/i.test(message)) return 'newPassword';
    return '';
}

export function mountPasswordForm(container) {
    const form = document.createElement('form');
    form.className = 'admin-form';
    form.id = 'passwordChangeForm';
    const current = passwordField('Current password', 'currentPassword', 'current-password');
    const next = passwordField('New password', 'newPassword', 'new-password');
    const confirm = passwordField('Confirm new password', 'confirmPassword', 'new-password');
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'save-btn';
    submit.textContent = 'Change password';
    const errors = errorBox();
    form.append(current.label, current.error, next.label, next.error, confirm.label, confirm.error, submit, errors.box);
    const fields = {
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm
    };

    function clearFieldErrors() {
        errors.hide();
        for (const field of Object.values(fields)) {
            field.error.hidden = true;
            field.input.removeAttribute('aria-invalid');
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        clearFieldErrors();
        submit.disabled = true;
        try {
            const result = await request('/api/account/password', {
                method: 'POST',
                body: JSON.stringify({
                    currentPassword: current.input.value,
                    newPassword: next.input.value,
                    confirmPassword: confirm.input.value
                })
            });
            if (result?.signInAgain) location.assign('/login');
        } catch (error) {
            const name = fieldName(error);
            if (name && fields[name]) {
                fields[name].error.textContent = error.message;
                fields[name].error.hidden = false;
                fields[name].input.setAttribute('aria-invalid', 'true');
            } else {
                errors.show(error.message);
            }
        } finally {
            submit.disabled = false;
        }
    });
    container.append(form);
}

export function mount(container) {
    container.replaceChildren();
    container.append(
        heading('Change your password'),
        paragraph('pull-forward-subtitle', 'This password is temporary. Choose a new one of at least 12 characters before using Rate Ninja. Sign out if you want to leave.')
    );
    mountPasswordForm(container);
}

export function unmount() {}
