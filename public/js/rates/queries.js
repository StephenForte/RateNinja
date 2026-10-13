import { request } from '../api.js';

let host = null;
let queries = [];
let select;
let nameInput;
let status;
let syncing = false;

function button(id, text) {
    const node = document.createElement('button');
    node.type = 'button';
    node.id = id;
    node.className = 'rates-preference-btn';
    node.textContent = text;
    return node;
}

function selected() {
    return queries.find(query => query.id === select.value) || null;
}

function setStatus(message, isError) {
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('rates-preference-error', Boolean(isError));
}

function fillSelect(selectedId) {
    syncing = true;
    const current = selectedId === undefined ? select.value : selectedId;
    select.replaceChildren(new Option('Choose a query', ''));
    queries.forEach(query => select.add(new Option(query.name, query.id)));
    if (queries.some(query => query.id === current)) select.value = current;
    syncing = false;
}

async function reload(selectedId) {
    const payload = await request('/api/preferences/queries');
    queries = payload.queries || [];
    fillSelect(selectedId);
}

export function mountQueries(container, nextHost) {
    host = nextHost;
    container.className = 'rates-preference-row';
    const label = document.createElement('label');
    label.textContent = 'Query ';
    select = document.createElement('select');
    select.id = 'savedQuerySelect';
    select.setAttribute('aria-label', 'Saved queries');
    label.append(select);
    nameInput = document.createElement('input');
    nameInput.id = 'savedQueryName';
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.placeholder = 'Query name';
    nameInput.setAttribute('aria-label', 'Query name');
    const save = button('saveQueryBtn', 'Save');
    const update = button('updateQueryBtn', 'Update');
    const rename = button('renameQueryBtn', 'Rename');
    const remove = button('deleteQueryBtn', 'Delete');
    status = document.createElement('p');
    status.id = 'queryStatus';
    status.className = 'rates-preference-status';
    status.hidden = true;
    container.append(label, nameInput, save, update, rename, remove, status);

    select.addEventListener('change', () => {
        if (syncing) return;
        const query = selected();
        if (!query) return;
        nameInput.value = query.name;
        host.applySaved(query.criteria);
        setStatus('', false);
    });
    save.addEventListener('click', () => storeQuery(false));
    update.addEventListener('click', () => storeQuery(true));
    rename.addEventListener('click', () => renameQuery());
    remove.addEventListener('click', () => deleteQuery());
}

async function storeQuery(overwrite) {
    const query = selected();
    const name = nameInput.value.trim();
    const criteria = host.criteria();
    try {
        if (overwrite) {
            if (!query) {
                setStatus('Choose a query to update.', true);
                return;
            }
            const payload = await request(`/api/preferences/queries/${encodeURIComponent(query.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ criteria })
            });
            await reload(payload.query.id);
            setStatus('Query updated.', false);
            return;
        }
        if (!name) {
            setStatus('Enter a name, then save.', true);
            return;
        }
        const payload = await request('/api/preferences/queries', {
            method: 'POST',
            body: JSON.stringify({ name, criteria })
        });
        await reload(payload.query.id);
        nameInput.value = payload.query.name;
        setStatus('Query saved.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function renameQuery() {
    const query = selected();
    const name = nameInput.value.trim();
    if (!query) {
        setStatus('Choose a query to rename.', true);
        return;
    }
    if (!name) {
        setStatus('Enter the new name.', true);
        return;
    }
    try {
        const payload = await request(`/api/preferences/queries/${encodeURIComponent(query.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        });
        await reload(payload.query.id);
        setStatus('Query renamed.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function deleteQuery() {
    const query = selected();
    if (!query) {
        setStatus('Choose a query to delete.', true);
        return;
    }
    try {
        await request(`/api/preferences/queries/${encodeURIComponent(query.id)}`, { method: 'DELETE' });
        nameInput.value = '';
        await reload('');
        setStatus('Query deleted.', false);
    } catch (error) {
        setStatus(error.message, true);
    }
}

export async function loadQueries() {
    try {
        await reload(select.value);
    } catch (error) {
        setStatus(error.message, true);
    }
}
