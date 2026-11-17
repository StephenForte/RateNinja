import { request } from '../api.js';
import { errorBox, heading, textCell } from '../dom.js';

let generation = 0;
let clearSecret = () => {};

export async function mount(container) {
    const current = ++generation;
    container.replaceChildren();
    const errors = errorBox();
    const intro = document.createElement('p');
    intro.textContent = 'Create up to five active keys for unattended access to your profile, rates and sailings.';
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Key label ';
    const input = document.createElement('input');
    input.required = true;
    input.maxLength = 80;
    label.append(input);
    const create = document.createElement('button');
    create.type = 'submit';
    create.className = 'save-btn';
    create.textContent = 'Create key';
    form.append(label, create);
    const secret = document.createElement('div');
    secret.hidden = true;
    secret.setAttribute('role', 'status');
    clearSecret = () => { secret.replaceChildren(); secret.hidden = true; };
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const titles = document.createElement('tr');
    for (const title of ['Label', 'Prefix', 'Created', 'Last used', 'Revoked', 'Action']) {
        const th = document.createElement('th');
        th.textContent = title;
        titles.append(th);
    }
    head.append(titles);
    const body = document.createElement('tbody');
    table.append(head, body);
    wrap.append(table);
    container.append(heading('API keys'), intro, errors.box, form, secret, wrap);

    async function reload() {
        const { keys } = await request('/api/account/api-keys');
        if (current !== generation) return;
        body.replaceChildren();
        create.disabled = keys.filter(key => !key.revoked_at).length >= 5;
        for (const key of keys) {
            const row = document.createElement('tr');
            const actions = document.createElement('td');
            if (!key.revoked_at) {
                const revoke = document.createElement('button');
                revoke.type = 'button';
                revoke.className = 'save-btn';
                revoke.textContent = 'Revoke';
                revoke.addEventListener('click', async () => {
                    errors.hide();
                    revoke.disabled = true;
                    try {
                        await request(`/api/account/api-keys/${key.id}`, { method: 'DELETE' });
                        clearSecret();
                        await reload();
                    } catch (error) { errors.show(error.message); revoke.disabled = false; }
                });
                actions.append(revoke);
            }
            row.append(textCell(key.label), textCell('rnb_' + key.key_prefix + '…'),
                textCell(key.created_at), textCell(key.last_used_at || 'Never'), textCell(key.revoked_at || 'Active'), actions);
            body.append(row);
        }
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        clearSecret();
        create.disabled = true;
        try {
            const created = await request('/api/account/api-keys', { method: 'POST', body: JSON.stringify({ label: input.value }) });
            if (current !== generation) return;
            const message = document.createElement('p');
            message.textContent = 'Copy this key now. It will not be shown again.';
            const value = document.createElement('code');
            value.textContent = created.key;
            const dismiss = document.createElement('button');
            dismiss.type = 'button';
            dismiss.textContent = 'Dismiss key';
            dismiss.addEventListener('click', clearSecret);
            secret.append(message, value, dismiss);
            secret.hidden = false;
            input.value = '';
            await reload();
        } catch (error) { errors.show(error.message); create.disabled = false; }
    });
    try { await reload(); } catch (error) { errors.show(error.message); }
}

export function unmount() { generation++; clearSecret(); }
