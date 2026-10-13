import { request } from '../api.js';
import { errorBox, heading, paragraph } from '../dom.js';

let alive = true;

function button(text) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'rates-preference-btn';
    node.textContent = text;
    return node;
}

function section(title, hint) {
    const block = document.createElement('section');
    block.className = 'preference-section';
    const list = document.createElement('div');
    list.className = 'preference-list';
    block.append(heading(title), paragraph('pull-forward-subtitle', hint), list);
    return { block, list };
}

function rowShell(name) {
    const row = document.createElement('div');
    row.className = 'preference-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.maxLength = 80;
    input.setAttribute('aria-label', `Name for ${name}`);
    const note = document.createElement('span');
    note.className = 'preference-note';
    row.append(input, note);
    return { row, input, note };
}

async function rename(path, input, note) {
    note.textContent = '';
    try {
        await request(path, { method: 'PATCH', body: JSON.stringify({ name: input.value.trim() }) });
        note.textContent = 'Renamed.';
        return true;
    } catch (error) {
        note.textContent = error.message;
        return false;
    }
}

export async function mount(container) {
    alive = true;
    container.replaceChildren();
    const errors = errorBox();
    const queries = section('Saved queries', 'Queries are yours alone. Rename or delete them here.');
    const views = section('Saved views', 'One default view loads the next time you open Rates.');
    container.append(heading('Preferences'), queries.block, views.block, errors.box);

    async function reload() {
        const [queryPayload, viewPayload] = await Promise.all([
            request('/api/preferences/queries'),
            request('/api/preferences/views')
        ]);
        if (!alive) return;
        queries.list.replaceChildren();
        views.list.replaceChildren();
        if (!queryPayload.queries.length) queries.list.append(paragraph('pull-forward-subtitle', 'No saved queries yet.'));
        queryPayload.queries.forEach(query => {
            const { row, input, note } = rowShell(query.name);
            const renameButton = button('Rename');
            const remove = button('Delete');
            renameButton.addEventListener('click', () => rename(`/api/preferences/queries/${encodeURIComponent(query.id)}`, input, note));
            remove.addEventListener('click', async () => {
                try {
                    await request(`/api/preferences/queries/${encodeURIComponent(query.id)}`, { method: 'DELETE' });
                    await reload();
                } catch (error) {
                    note.textContent = error.message;
                }
            });
            row.append(renameButton, remove);
            queries.list.append(row);
        });
        if (!viewPayload.views.length) views.list.append(paragraph('pull-forward-subtitle', 'No saved views yet.'));
        viewPayload.views.forEach(view => {
            const { row, input, note } = rowShell(view.name);
            if (view.isDefault) note.textContent = 'Default';
            if (view.needsAttention) note.textContent = view.isDefault ? 'Default · needs attention' : 'Needs attention';
            const renameButton = button('Rename');
            const remove = button('Delete');
            const makeDefault = button(view.isDefault ? 'Clear default' : 'Set default');
            renameButton.addEventListener('click', async () => {
                const ok = await rename(`/api/preferences/views/${encodeURIComponent(view.id)}`, input, note);
                if (ok) await reload();
            });
            remove.addEventListener('click', async () => {
                try {
                    await request(`/api/preferences/views/${encodeURIComponent(view.id)}`, { method: 'DELETE' });
                    await reload();
                } catch (error) {
                    note.textContent = error.message;
                }
            });
            makeDefault.addEventListener('click', async () => {
                try {
                    await request('/api/preferences/default-view', {
                        method: 'PUT',
                        body: JSON.stringify({ id: view.isDefault ? null : view.id })
                    });
                    await reload();
                } catch (error) {
                    note.textContent = error.message;
                }
            });
            row.append(renameButton, remove, makeDefault);
            views.list.append(row);
        });
    }

    try {
        await reload();
    } catch (error) {
        errors.show(error.message);
    }
}

export function unmount() {
    alive = false;
}
