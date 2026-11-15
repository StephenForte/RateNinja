import { request } from '../api.js';
import { adminFailureMessage } from '../permissions.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';

function labeled(labelText, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(labelText), control);
    return label;
}

export async function mount(container) {
    container.replaceChildren();
    const errors = errorBox();

    const codeInput = document.createElement('input');
    codeInput.required = true;
    codeInput.maxLength = 32;
    codeInput.autocomplete = 'off';
    codeInput.placeholder = 'LALB';

    const nameInput = document.createElement('input');
    nameInput.required = true;
    nameInput.maxLength = 120;
    nameInput.autocomplete = 'off';
    nameInput.placeholder = 'Los Angeles / Long Beach';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'save-btn';
    submit.textContent = 'Add port';

    const form = document.createElement('form');
    form.className = 'admin-form ports-form';
    form.append(
        labeled('Code ', codeInput),
        labeled('Name ', nameInput),
        submit
    );

    const portsWrap = document.createElement('div');
    portsWrap.className = 'admin-table-container';
    const portsTable = document.createElement('table');
    portsTable.className = 'admin-table ports-table';
    const portsHead = document.createElement('thead');
    const portsHeadRow = document.createElement('tr');
    for (const label of ['Code', 'Name', '']) {
        portsHeadRow.append(textCell(label, 'th'));
    }
    portsHead.append(portsHeadRow);
    const portsBody = document.createElement('tbody');
    portsTable.append(portsHead, portsBody);
    portsWrap.append(portsTable);

    const unmatchedHeading = heading('Unmatched stored values');
    unmatchedHeading.className = 'ports-unmatched-heading';
    const unmatchedHelp = paragraph('pull-forward-subtitle', 'Distinct origin, destination, departure, and arrival values from non-deleted rates and sailings that do not match a port code or name.');
    const unmatchedWrap = document.createElement('div');
    unmatchedWrap.className = 'admin-table-container';
    const unmatchedList = document.createElement('ul');
    unmatchedList.className = 'ports-unmatched-list';
    unmatchedWrap.append(unmatchedList);

    container.append(
        heading('Ports'),
        paragraph('pull-forward-subtitle', 'Global port codes and names used for lookups. Only system administrators can edit this list.'),
        errors.box,
        form,
        portsWrap,
        unmatchedHeading,
        unmatchedHelp,
        unmatchedWrap
    );

    function renderPorts(rows) {
        portsBody.replaceChildren();
        rows.forEach(port => {
            const row = document.createElement('tr');
            const codeField = document.createElement('input');
            codeField.value = port.code;
            codeField.maxLength = 32;
            const nameField = document.createElement('input');
            nameField.value = port.name;
            nameField.maxLength = 120;
            const codeCell = document.createElement('td');
            codeCell.append(codeField);
            const nameCell = document.createElement('td');
            nameCell.append(nameField);
            const actions = document.createElement('td');
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'save-btn';
            save.textContent = 'Save';
            save.addEventListener('click', () => updatePort(port.id, {
                code: codeField.value,
                name: nameField.value
            }));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'back-btn';
            remove.textContent = 'Delete';
            remove.addEventListener('click', () => deletePort(port.id));
            actions.append(save, remove);
            row.append(codeCell, nameCell, actions);
            portsBody.append(row);
        });
    }

    function renderUnmatched(values) {
        unmatchedList.replaceChildren();
        if (!values.length) {
            const empty = document.createElement('li');
            empty.className = 'ports-unmatched-empty';
            empty.textContent = 'Every stored port value matches a code or name.';
            unmatchedList.append(empty);
            return;
        }
        values.forEach(value => {
            const item = document.createElement('li');
            item.textContent = String(value);
            unmatchedList.append(item);
        });
    }

    async function reload() {
        const payload = await request('/api/admin/ports');
        errors.hide();
        renderPorts(payload.ports || []);
        renderUnmatched(payload.unmatched || []);
    }

    async function updatePort(id, patch) {
        errors.hide();
        try {
            await request(`/api/admin/ports/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch)
            });
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message || 'Could not update the port.'));
        }
    }

    async function deletePort(id) {
        errors.hide();
        try {
            await request(`/api/admin/ports/${id}`, {
                method: 'DELETE',
                body: JSON.stringify({})
            });
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message || 'Could not delete the port.'));
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        try {
            await request('/api/admin/ports', {
                method: 'POST',
                body: JSON.stringify({
                    code: codeInput.value,
                    name: nameInput.value
                })
            });
            codeInput.value = '';
            nameInput.value = '';
            await reload();
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message || 'Could not create the port.'));
        }
    });

    try {
        await reload();
    } catch (error) {
        errors.show(adminFailureMessage(error, error.message || 'Could not load ports.'));
    }
}

export function unmount() {}
