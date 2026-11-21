import { request } from '../api.js';
import { adminFailureMessage } from '../permissions.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';

const scopeDefaults = [
    ['profile:read', true],
    ['rates:read', true],
    ['sailings:read', true],
    ['bookings:read', true],
    ['bookings:write', false]
];

export async function mount(container) {
    container.replaceChildren();
    const errors = errorBox();
    const notice = document.createElement('div');
    notice.className = 'secret-notice';
    notice.hidden = true;

    const form = document.createElement('form');
    form.className = 'admin-form';
    const displayName = document.createElement('input');
    displayName.required = true;
    displayName.maxLength = 80;
    const clientType = document.createElement('select');
    for (const [value, label] of [
        ['confidential', 'Confidential (partner backend)'],
        ['public', 'Public (Cursor or Claude PKCE)']
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        clientType.append(option);
    }
    const redirects = document.createElement('textarea');
    redirects.rows = 3;
    redirects.placeholder = 'https://partner.example/callback';
    const scopes = scopeFields();
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'save-btn';
    submit.textContent = 'Register client';
    form.append(
        labeled('Display name ', displayName),
        labeled('Type ', clientType),
        labeled('Redirect URIs, one per line ', redirects),
        scopes,
        submit
    );

    const editor = document.createElement('div');
    editor.hidden = true;

    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Name', 'Client id', 'Redirect URIs', 'Type', 'Status', 'Active connections', '']) {
        headRow.append(textCell(label, 'th'));
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    table.append(head, body);
    wrap.append(table);
    container.append(
        heading('OAuth clients'),
        paragraph('pull-forward-subtitle', 'Register partner and desktop clients. The first client is Capacity Exchange. A new secret is shown once.'),
        notice,
        errors.box,
        form,
        editor,
        wrap
    );

    function showSecret(secret) {
        if (!secret) return;
        notice.hidden = false;
        notice.textContent = `Copy this client secret now. It will not be shown again: ${secret}`;
    }

    function render(clients) {
        body.replaceChildren();
        clients.forEach(client => {
            const row = document.createElement('tr');
            const actions = document.createElement('td');
            const edit = actionButton('Edit', () => openEditor(client));
            actions.append(edit);
            if (client.clientType === 'confidential') {
                const rotate = document.createElement('button');
                rotate.type = 'button';
                rotate.className = 'save-btn';
                rotate.textContent = client.hasSecret ? 'Rotate secret' : 'Set secret';
                rotate.addEventListener('click', () => rotateSecret(client.id));
                actions.append(rotate);
            }
            if (client.canDelete) {
                actions.append(actionButton('Delete', event => deleteClient(client, event.currentTarget)));
            }
            row.append(
                textCell(client.displayName),
                textCell(client.id),
                textCell(client.redirectUris.join(', ')),
                textCell(client.clientType),
                textCell(client.status),
                textCell(String(client.activeGrantCount)),
                actions
            );
            body.append(row);
        });
    }

    async function reload() {
        const { clients } = await request('/api/admin/oauth-clients');
        errors.hide();
        render(clients);
    }

    function closeEditor() {
        editor.hidden = true;
        editor.replaceChildren();
    }

    function openEditor(client) {
        const editForm = document.createElement('form');
        editForm.className = 'admin-form';
        const name = document.createElement('input');
        name.required = true;
        name.maxLength = 80;
        name.value = client.displayName;
        const uris = document.createElement('textarea');
        uris.rows = 3;
        uris.value = client.redirectUris.join('\n');
        const allowed = scopeFields(client.allowedScopes);
        const status = document.createElement('select');
        status.add(new Option('Active', 'active'));
        status.add(new Option('Disabled', 'disabled'));
        status.value = client.status;
        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'save-btn';
        save.textContent = 'Save changes';
        editForm.append(
            labeled('Display name ', name),
            labeled('Redirect URIs, one per line ', uris),
            allowed,
            labeled('Status ', status),
            save,
            actionButton('Cancel', closeEditor)
        );
        editForm.addEventListener('submit', async event => {
            event.preventDefault();
            save.disabled = true;
            errors.hide();
            try {
                await request(`/api/admin/oauth-clients/${client.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        displayName: name.value,
                        redirectUris: redirectValues(uris),
                        allowedScopes: selectedScopes(allowed),
                        status: status.value
                    })
                });
                if (editor.contains(editForm)) closeEditor();
                await reload();
            } catch (error) {
                errors.show(adminFailureMessage(error, error.message));
            } finally {
                save.disabled = false;
            }
        });
        const title = document.createElement('h3');
        title.textContent = `Edit ${client.displayName}`;
        editor.replaceChildren(title, editForm);
        editor.hidden = false;
        editor.dataset.clientId = client.id;
        name.focus();
    }

    async function deleteClient(client, button) {
        const count = client.activeGrantCount;
        const connections = count === 1 ? 'connection' : 'connections';
        if (!window.confirm(`Permanently delete "${client.displayName}"? This will cut ${count} active ${connections}.`)) return;
        button.disabled = true;
        errors.hide();
        try {
            await request(`/api/admin/oauth-clients/${client.id}`, { method: 'DELETE' });
            if (editor.dataset.clientId === client.id) closeEditor();
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message));
        } finally {
            button.disabled = false;
        }
    }

    async function rotateSecret(clientId) {
        errors.hide();
        try {
            const result = await request(`/api/admin/oauth-clients/${clientId}/rotate-secret`, {
                method: 'POST',
                body: JSON.stringify({})
            });
            showSecret(result.clientSecret);
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message));
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        const allowedScopes = selectedScopes(scopes);
        try {
            const result = await request('/api/admin/oauth-clients', {
                method: 'POST',
                body: JSON.stringify({
                    displayName: displayName.value,
                    clientType: clientType.value,
                    redirectUris: redirectValues(redirects),
                    allowedScopes
                })
            });
            showSecret(result.clientSecret);
            form.reset();
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message));
        }
    });

    try {
        await reload();
    } catch (error) {
        errors.show(adminFailureMessage(error, `Failed to load administration data: ${error.message}`));
    }
}

function actionButton(text, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'back-btn';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
}

function scopeFields(selected) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'oauth-scope-fields';
    const legend = document.createElement('legend');
    legend.textContent = 'Scopes';
    fieldset.append(legend);
    for (const [scope, checked] of scopeDefaults) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = scope;
        input.defaultChecked = selected ? selected.includes(scope) : checked;
        const label = document.createElement('label');
        label.append(input, document.createTextNode(` ${scope}`));
        fieldset.append(label);
    }
    return fieldset;
}

function selectedScopes(fieldset) {
    return [...fieldset.querySelectorAll('input:checked')].map(input => input.value);
}

function redirectValues(control) {
    return control.value.split(/\n+/).map(value => value.trim()).filter(Boolean);
}

function labeled(text, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(text), control);
    return label;
}

export function unmount() {}
