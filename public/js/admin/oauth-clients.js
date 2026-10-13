import { request } from '../api.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';

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
    const scopes = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Scopes';
    scopes.append(legend);
    for (const scope of ['profile:read', 'rates:read', 'sailings:read']) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'oauthScope';
        input.value = scope;
        input.checked = true;
        const label = document.createElement('label');
        label.append(input, document.createTextNode(` ${scope}`));
        scopes.append(label);
    }
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

    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Name', 'Client id', 'Redirect URIs', 'Type', 'Status', '']) {
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
            const redirectInput = document.createElement('textarea');
            redirectInput.rows = 2;
            redirectInput.value = (client.redirectUris || []).join('\n');
            const redirectCell = document.createElement('td');
            redirectCell.append(redirectInput);
            const actions = document.createElement('td');
            const saveRedirects = document.createElement('button');
            saveRedirects.type = 'button';
            saveRedirects.className = 'save-btn';
            saveRedirects.textContent = 'Save redirects';
            saveRedirects.addEventListener('click', () => updateClient(client, {
                redirectUris: redirectInput.value.split(/\n+/).map(value => value.trim()).filter(Boolean)
            }));
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'back-btn';
            toggle.textContent = client.status === 'active' ? 'Disable' : 'Enable';
            toggle.addEventListener('click', () => updateClient(client, {
                status: client.status === 'active' ? 'disabled' : 'active'
            }));
            actions.append(saveRedirects, toggle);
            if (client.clientType === 'confidential') {
                const rotate = document.createElement('button');
                rotate.type = 'button';
                rotate.className = 'save-btn';
                rotate.textContent = client.hasSecret ? 'Rotate secret' : 'Set secret';
                rotate.addEventListener('click', () => rotateSecret(client.id));
                actions.append(rotate);
            }
            row.append(
                textCell(client.displayName),
                textCell(client.id),
                redirectCell,
                textCell(client.clientType),
                textCell(client.status),
                actions
            );
            body.append(row);
        });
    }

    async function reload() {
        const { clients } = await request('/api/admin/oauth-clients');
        render(clients);
    }

    async function updateClient(client, patch) {
        try {
            await request(`/api/admin/oauth-clients/${client.id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch)
            });
            await reload();
        } catch (error) {
            errors.show(error.message);
        }
    }

    async function rotateSecret(clientId) {
        try {
            const result = await request(`/api/admin/oauth-clients/${clientId}/rotate-secret`, {
                method: 'POST',
                body: JSON.stringify({})
            });
            showSecret(result.clientSecret);
            await reload();
        } catch (error) {
            errors.show(error.message);
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        const allowedScopes = [...form.querySelectorAll('input[name="oauthScope"]:checked')].map(input => input.value);
        try {
            const result = await request('/api/admin/oauth-clients', {
                method: 'POST',
                body: JSON.stringify({
                    displayName: displayName.value,
                    clientType: clientType.value,
                    redirectUris: redirects.value.split(/\n+/).map(value => value.trim()).filter(Boolean),
                    allowedScopes
                })
            });
            showSecret(result.clientSecret);
            form.reset();
            for (const input of form.querySelectorAll('input[name="oauthScope"]')) input.checked = true;
            await reload();
        } catch (error) {
            errors.show(error.message);
        }
    });

    try {
        await reload();
    } catch (error) {
        errors.show(`Failed to load administration data: ${error.message}`);
    }
}

function labeled(text, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(text), control);
    return label;
}

export function unmount() {}
