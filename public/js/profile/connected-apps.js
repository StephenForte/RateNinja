import { request } from '../api.js';
import { errorBox, heading, textCell } from '../dom.js';

export async function mount(container) {
    container.replaceChildren();
    const errors = errorBox();
    const empty = document.createElement('div');
    empty.hidden = true;
    empty.textContent = 'No applications are connected.';
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    const table = document.createElement('table');
    table.className = 'admin-table';
    const body = document.createElement('tbody');
    table.append(body);
    wrap.append(table);
    container.append(heading('Connected apps'), paragraphSubtitle(), errors.box, empty, wrap);

    async function reload() {
        errors.hide();
        const { grants } = await request('/oauth/consents');
        empty.hidden = grants.length > 0;
        body.replaceChildren();
        grants.forEach(grant => {
            const row = document.createElement('tr');
            const actions = document.createElement('td');
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'save-btn';
            revoke.textContent = 'Revoke';
            revoke.addEventListener('click', async () => {
                await request(`/oauth/consents/${grant.clientId}`, { method: 'DELETE' });
                await reload();
            });
            actions.append(revoke);
            row.append(textCell(grant.displayName), textCell(grant.scopes.join(' ')), actions);
            body.append(row);
        });
    }

    try {
        await reload();
    } catch (error) {
        errors.show(error.message);
    }
}

function paragraphSubtitle() {
    const node = document.createElement('p');
    node.className = 'pull-forward-subtitle';
    node.textContent = 'Partner grants for this contract owner.';
    return node;
}

export function unmount() {}
