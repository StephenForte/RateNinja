import { clearCsrf, request, showLoginPage } from '../api.js';
import { companyOperationGate } from '../confirm.js';
import { errorBox, fieldLabel, heading, paragraph, textCell } from '../dom.js';
import { adminFailureMessage } from '../permissions.js';

function textInput(id, type = 'text') {
    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.autocomplete = type === 'password' ? 'new-password' : 'off';
    return input;
}

function roleLabel(role) {
    return role === 'company_admin' ? 'Company administrator' : 'Member';
}

export async function mount(container, ctx) {
    container.replaceChildren();
    const errors = errorBox();
    const notice = document.createElement('p');
    notice.className = 'onboarding-summary';
    notice.hidden = true;

    const displayName = textInput('newUserDisplayName');
    const email = textInput('newUserEmail', 'email');
    const loginName = textInput('newUserLogin');
    loginName.placeholder = 'Defaults to the email address';
    const temporaryPassword = textInput('newUserPassword', 'password');
    temporaryPassword.minLength = 12;
    const role = document.createElement('select');
    role.id = 'newUserRole';
    for (const [value, label] of [['member', 'Member'], ['company_admin', 'Company administrator']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        role.append(option);
    }
    email.addEventListener('change', () => {
        if (!loginName.value.trim()) loginName.value = email.value.trim();
    });

    const details = document.createElement('div');
    details.className = 'onboarding-fields';
    details.append(
        fieldLabel('Display name', displayName),
        fieldLabel('Email', email),
        fieldLabel('Login name', loginName)
    );
    const access = document.createElement('div');
    access.className = 'onboarding-fields';
    access.append(
        fieldLabel('Role', role),
        fieldLabel('Temporary password', temporaryPassword)
    );
    const review = document.createElement('div');
    review.id = 'userWizardReview';
    const panels = [details, access, review];
    const stepNames = ['User details', 'Role and temporary password', 'Review'];
    let step = 0;

    const stepLabel = document.createElement('p');
    stepLabel.className = 'onboarding-step';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.textContent = 'Back';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'save-btn';
    next.textContent = 'Next';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'save-btn';
    create.textContent = 'Create user';
    const wizardActions = document.createElement('div');
    wizardActions.className = 'onboarding-actions';
    wizardActions.append(back, next, create);
    const wizard = document.createElement('form');
    wizard.id = 'userWizard';
    wizard.className = 'onboarding-wizard';
    wizard.append(stepLabel, ...panels, wizardActions);
    wizard.addEventListener('submit', event => event.preventDefault());

    const editor = document.createElement('form');
    editor.id = 'userEditor';
    editor.className = 'onboarding-wizard';
    editor.hidden = true;
    const editorTitle = document.createElement('h3');
    const editorName = textInput('editUserDisplayName');
    const editorEmail = textInput('editUserEmail', 'email');
    const editorRole = document.createElement('select');
    editorRole.id = 'editUserRole';
    for (const [value, label] of [['member', 'Member'], ['company_admin', 'Company administrator']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        roleOption(editorRole, option);
    }
    const editorPassword = textInput('editUserPassword', 'password');
    editorPassword.minLength = 12;
    const saveProfile = document.createElement('button');
    saveProfile.type = 'button';
    saveProfile.className = 'save-btn';
    saveProfile.textContent = 'Save name and email';
    const saveRole = document.createElement('button');
    saveRole.type = 'button';
    saveRole.className = 'save-btn';
    saveRole.textContent = 'Change role';
    const savePassword = document.createElement('button');
    savePassword.type = 'button';
    savePassword.className = 'save-btn';
    savePassword.textContent = 'Set temporary password';
    editor.append(
        editorTitle,
        fieldLabel('Display name', editorName),
        fieldLabel('Email', editorEmail),
        saveProfile,
        fieldLabel('Role', editorRole),
        saveRole,
        fieldLabel('Temporary password', editorPassword),
        savePassword
    );
    editor.addEventListener('submit', event => event.preventDefault());

    const body = document.createElement('tbody');
    body.id = 'userList';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Display name', 'Login name', 'Email', 'Role', 'Active', '2FA', '']) {
        headRow.append(textCell(label, 'th'));
    }
    head.append(headRow);
    table.append(head, body);
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    wrap.append(table);

    const company = companyLabel(ctx.permissions);
    container.append(
        heading('Users'),
        paragraph('pull-forward-subtitle', `People at ${company}. A temporary password is handed over in person. Rate Ninja does not email it.`),
        errors.box,
        notice,
        wizard,
        editor,
        wrap
    );

    let selected = null;

    function showError(error) {
        errors.show(adminFailureMessage(error, error && error.message ? error.message : 'Request failed.'));
    }

    function showNotice(text) {
        notice.textContent = text;
        notice.hidden = !text;
    }

    function signedOut() {
        clearCsrf();
        ctx.onSignedOut();
        showLoginPage();
    }

    function confirmed(action) {
        const gate = companyOperationGate(ctx.permissions, action);
        if (!gate.allowed) return gate;
        if (!window.confirm(gate.message)) return { allowed: false, message: '' };
        return gate;
    }

    function showStep() {
        panels.forEach((panel, index) => {
            panel.hidden = index !== step;
        });
        stepLabel.textContent = `Step ${step + 1} of ${panels.length}: ${stepNames[step]}`;
        back.hidden = step === 0;
        next.hidden = step === panels.length - 1;
        create.hidden = step !== panels.length - 1;
    }

    function renderReview() {
        review.replaceChildren();
        const lines = [
            ['Display name', displayName.value.trim()],
            ['Email', email.value.trim()],
            ['Login', loginName.value.trim() || email.value.trim()],
            ['Role', roleLabel(role.value)],
            ['Temporary password', 'Entered. It stays in this form if creation is rejected, and it is not emailed.']
        ];
        const list = document.createElement('dl');
        list.className = 'account-details';
        for (const [label, value] of lines) {
            const term = document.createElement('dt');
            term.textContent = label;
            const definition = document.createElement('dd');
            definition.textContent = value;
            list.append(term, definition);
        }
        review.append(list);
    }

    function validateStep() {
        errors.hide();
        if (step === 0) {
            if (!displayName.value.trim()) {
                errors.show('Enter a display name.');
                return false;
            }
            if (!email.value.trim()) {
                errors.show('Enter a valid email address.');
                return false;
            }
            if (!loginName.value.trim()) loginName.value = email.value.trim();
        }
        if (step === 1 && temporaryPassword.value.length < 12) {
            errors.show('Password must be 12 to 200 characters.');
            return false;
        }
        return true;
    }

    back.addEventListener('click', () => {
        errors.hide();
        if (step > 0) step -= 1;
        showStep();
    });
    next.addEventListener('click', () => {
        if (!validateStep()) return;
        step += 1;
        if (step === panels.length - 1) renderReview();
        showStep();
    });
    create.addEventListener('click', async () => {
        errors.hide();
        showNotice('');
        if (!loginName.value.trim()) loginName.value = email.value.trim();
        renderReview();
        const gate = confirmed(`Create ${displayName.value.trim() || loginName.value.trim()}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        create.disabled = true;
        try {
            await request('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                    displayName: displayName.value.trim(),
                    email: email.value.trim(),
                    loginName: loginName.value.trim(),
                    role: role.value,
                    temporaryPassword: temporaryPassword.value,
                    companyId: contextCompanyId(ctx.permissions)
                })
            });
            displayName.value = '';
            email.value = '';
            loginName.value = '';
            temporaryPassword.value = '';
            step = 0;
            showStep();
            showNotice('User created. Give them the temporary password yourself. They must change it before they can use the account.');
            await reload();
        } catch (error) {
            showError(error);
            showStep();
        } finally {
            create.disabled = false;
        }
    });

    function openEditor(user) {
        selected = user;
        editor.hidden = false;
        editorTitle.textContent = user.displayName || user.loginName;
        editorName.value = user.displayName || '';
        editorEmail.value = user.email || '';
        editorRole.value = user.role === 'company_admin' ? 'company_admin' : 'member';
        editorPassword.value = '';
    }

    async function reload() {
        const { users } = await request('/api/admin/users');
        render(users);
        if (selected) {
            const fresh = users.find(user => user.id === selected.id);
            if (fresh) openEditor(fresh);
        }
    }

    function render(users) {
        body.replaceChildren();
        if (!users.length) {
            const row = document.createElement('tr');
            const cell = textCell('No users yet.');
            cell.colSpan = 7;
            row.append(cell);
            body.append(row);
            return;
        }
        for (const user of users) {
            const row = document.createElement('tr');
            const actions = document.createElement('td');
            actions.className = 'user-actions';
            actions.append(
                actionButton('Edit', () => openEditor(user)),
                actionButton(user.active === false || user.disabled ? 'Reactivate' : 'Deactivate', () => setDisabled(user, !(user.active === false || user.disabled))),
                actionButton('Clear 2FA', () => clearTwoFactor(user), user.twoFactorEnrolled || user.totpEnabled)
            );
            row.append(
                textCell(user.displayName || ''),
                textCell(user.loginName || user.username || ''),
                textCell(user.email || ''),
                textCell(roleLabel(user.role)),
                textCell(user.active === false || user.disabled ? 'Inactive' : 'Active'),
                textCell(user.twoFactorEnrolled || user.totpEnabled ? 'Enrolled' : 'Not enrolled'),
                actions
            );
            body.append(row);
        }
    }

    function actionButton(label, onClick, show = true) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'back-btn';
        button.textContent = label;
        button.hidden = !show;
        button.addEventListener('click', onClick);
        return button;
    }

    async function setDisabled(user, disabled) {
        const verb = disabled ? 'Deactivate' : 'Reactivate';
        const gate = confirmed(`${verb} ${user.displayName || user.loginName}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        try {
            await request(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ disabled, companyId: contextCompanyId(ctx.permissions) })
            });
            showNotice(disabled
                ? `${user.displayName || user.loginName} is inactive. Partner access stays revoked if you reactivate them.`
                : `${user.displayName || user.loginName} can sign in again. Previous partner access was not restored.`);
            await reload();
        } catch (error) {
            showError(error);
        }
    }

    async function clearTwoFactor(user) {
        const gate = confirmed(`Clear two-factor authentication for ${user.displayName || user.loginName}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        try {
            const result = await request(`/api/admin/users/${user.id}/two-factor`, {
                method: 'DELETE',
                body: JSON.stringify({ companyId: contextCompanyId(ctx.permissions) })
            });
            if (result.signedOut) {
                signedOut();
                return;
            }
            await reload();
        } catch (error) {
            showError(error);
        }
    }

    saveProfile.addEventListener('click', async () => {
        if (!selected) return;
        const gate = confirmed(`Save name and email for ${selected.displayName || selected.loginName}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        saveProfile.disabled = true;
        try {
            await request(`/api/admin/users/${selected.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    displayName: editorName.value,
                    email: editorEmail.value,
                    companyId: contextCompanyId(ctx.permissions)
                })
            });
            await reload();
        } catch (error) {
            showError(error);
        } finally {
            saveProfile.disabled = false;
        }
    });

    saveRole.addEventListener('click', async () => {
        if (!selected) return;
        const gate = confirmed(`Change the role for ${selected.displayName || selected.loginName}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        saveRole.disabled = true;
        try {
            const result = await request(`/api/admin/users/${selected.id}/role`, {
                method: 'POST',
                body: JSON.stringify({ role: editorRole.value, companyId: contextCompanyId(ctx.permissions) })
            });
            if (result.signedOut) {
                signedOut();
                return;
            }
            await reload();
        } catch (error) {
            showError(error);
        } finally {
            saveRole.disabled = false;
        }
    });

    savePassword.addEventListener('click', async () => {
        if (!selected) return;
        const gate = confirmed(`Set a temporary password for ${selected.displayName || selected.loginName}.`);
        if (!gate.allowed) {
            if (gate.message) errors.show(gate.message);
            return;
        }
        savePassword.disabled = true;
        try {
            const result = await request(`/api/admin/users/${selected.id}/password`, {
                method: 'POST',
                body: JSON.stringify({
                    password: editorPassword.value,
                    companyId: contextCompanyId(ctx.permissions)
                })
            });
            editorPassword.value = '';
            if (result.signedOut) {
                signedOut();
                return;
            }
            showNotice('Temporary password set. Give it to the user yourself. They must change it at the next sign-in.');
            await reload();
        } catch (error) {
            showError(error);
        } finally {
            savePassword.disabled = false;
        }
    });

    showStep();
    try {
        await reload();
    } catch (error) {
        errors.show(adminFailureMessage(error, `Failed to load administration data: ${error.message}`));
    }
}

function roleOption(select, option) {
    select.append(option);
}

function contextCompanyId(permissions) {
    return permissions && permissions.companyContext && permissions.companyContext.id
        ? permissions.companyContext.id
        : '';
}

function companyLabel(permissions) {
    const gate = companyOperationGate(permissions, 'Manage users.');
    return gate.companyName || 'this company';
}

export function unmount() {}
