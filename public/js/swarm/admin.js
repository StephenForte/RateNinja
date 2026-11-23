import { fieldLabel, paragraph, textCell } from '../dom.js';
import { read, write } from './client.js';

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = action ? 'button' : 'submit';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

function input(type, value) {
    const control = document.createElement('input');
    control.type = type;
    if (type === 'checkbox') control.checked = value === true;
    else control.value = value == null ? '' : String(value);
    return control;
}

function companyRow(company) {
    const row = document.createElement('form');
    row.className = 'swarm-admin-row';
    row.setAttribute('data-company-id', String(company.companyId || ''));
    const name = textCell(company.name || '', 'span', 'swarm-company-name');
    const enabled = input('checkbox', company.enabled === true);
    const project = input('text', company.bbsProject || '');
    const token = input('password', '');
    token.className = 'swarm-token';
    token.setAttribute('autocomplete', 'off');
    const tokenState = textCell(company.hasBbsToken === true ? 'Token set' : 'No token', 'span', 'swarm-token-state');
    const clearNote = paragraph('agent-hint swarm-clear-note', '');
    const updated = textCell(company.updatedAt || '—', 'time', 'swarm-updated');
    const error = paragraph('swarm-row-error', '');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    let clearArmed = false;
    let busy = false;

    const clearButton = button('Clear token', () => {
        clearArmed = true;
        token.value = '';
        clearNote.textContent = 'The token will be cleared when you save.';
    }, 'agent-button');
    const save = button('Save', null, 'agent-button agent-primary');

    row.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        save.disabled = true;
        error.hidden = true;
        error.textContent = '';
        const body = {
            enabled: enabled.checked === true,
            bbsProject: project.value.trim() ? project.value.trim() : null
        };
        if (token.value !== '') body.bbsToken = token.value;
        else if (clearArmed) body.bbsToken = null;
        try {
            const result = await write(`/api/admin/swarm/companies/${encodeURIComponent(company.companyId)}`, 'PUT', body);
            const saved = result && result.company ? result.company : {};
            token.value = '';
            clearArmed = false;
            clearNote.textContent = '';
            tokenState.textContent = saved.hasBbsToken === true ? 'Token set' : 'No token';
            enabled.checked = saved.enabled === true;
            project.value = saved.bbsProject || '';
            updated.textContent = saved.updatedAt || '—';
            if (typeof saved.name === 'string') name.textContent = saved.name;
        } catch (requestError) {
            error.textContent = requestError.message || 'Request failed.';
            error.hidden = false;
        } finally {
            busy = false;
            save.disabled = false;
        }
    });

    const fields = document.createElement('div');
    fields.className = 'agent-fields';
    fields.append(
        fieldLabel('Enabled', enabled),
        fieldLabel('CloudBBS project', project),
        fieldLabel('Token', token),
        tokenState,
        clearNote,
        clearButton
    );
    const meta = document.createElement('div');
    meta.className = 'swarm-admin-meta';
    meta.append(textCell('Updated', 'span'), updated, save);
    row.append(name, fields, error, meta);
    return row;
}

export async function renderSettings(view) {
    const payload = await read('/api/admin/swarm/companies');
    const companies = payload && Array.isArray(payload.companies) ? payload.companies : [];
    view.replaceChildren();
    if (!companies.length) {
        view.append(paragraph('agent-empty', 'No customer companies.'));
        return;
    }
    const list = document.createElement('div');
    list.className = 'swarm-admin';
    for (const company of companies) list.append(companyRow(company));
    view.append(list);
}
