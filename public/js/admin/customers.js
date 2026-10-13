import { companyOperationGate } from '../confirm.js';
import { request } from '../api.js';
import { adminFailureMessage } from '../permissions.js';
import { errorBox, fieldLabel, heading, paragraph, textCell } from '../dom.js';

let previewCustomerId = '';
let previewToken = 0;

function companyIdOf(permissions) {
    return permissions && permissions.companyContext && permissions.companyContext.id
        ? permissions.companyContext.id
        : '';
}

function confirmed(permissions, customerName, action) {
    const gate = companyOperationGate(permissions, `${action} ${customerName}.`);
    if (!gate.allowed) return gate;
    if (!window.confirm(gate.message)) return { allowed: false, message: '' };
    return gate;
}

function numberInput(value) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '1000000';
    input.step = '0.01';
    input.value = value;
    return input;
}

export async function mount(container, ctx) {
    previewCustomerId = '';
    container.replaceChildren();
    const errors = errorBox();
    const lookupQuery = document.createElement('input');
    lookupQuery.id = 'customerLookupQuery';
    lookupQuery.type = 'search';
    lookupQuery.placeholder = 'Customer company name';
    const lookupButton = document.createElement('button');
    lookupButton.type = 'submit';
    lookupButton.dataset.action = 'lookup';
    lookupButton.textContent = 'Look up';
    const lookupForm = document.createElement('form');
    lookupForm.className = 'customer-toolbar';
    lookupForm.append(fieldLabel('Find a customer', lookupQuery), lookupButton);
    const lookupResults = document.createElement('div');
    lookupResults.id = 'customerLookupResults';
    lookupResults.className = 'customer-lookup-results';

    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Customer', 'Status', 'Margin percent', 'Margin dollars', 'Actions']) {
        headRow.append(textCell(label, 'th'));
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    table.append(head, body);
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    wrap.append(table);

    const search = document.createElement('input');
    search.id = 'customerPreviewSearch';
    search.type = 'search';
    const carrier = document.createElement('input');
    carrier.id = 'customerPreviewCarrier';
    const origin = document.createElement('input');
    origin.id = 'customerPreviewOrigin';
    const destination = document.createElement('input');
    destination.id = 'customerPreviewDestination';
    const filters = document.createElement('div');
    filters.className = 'customer-preview-filters';
    filters.append(
        fieldLabel('Search', search),
        fieldLabel('Carrier', carrier),
        fieldLabel('Origin', origin),
        fieldLabel('Destination', destination)
    );
    const previewTitle = document.createElement('h3');
    previewTitle.textContent = 'Live preview';
    const proposed = document.createElement('span');
    proposed.id = 'customerPreviewProposed';
    proposed.className = 'customer-proposed';
    proposed.hidden = true;
    proposed.textContent = 'Proposed';
    previewTitle.append(proposed);
    const previewMeta = document.createElement('p');
    previewMeta.id = 'customerPreviewMeta';
    const previewBody = document.createElement('tbody');
    const previewTable = document.createElement('table');
    previewTable.className = 'admin-table';
    const previewHead = document.createElement('thead');
    const previewHeadRow = document.createElement('tr');
    for (const label of ['Carrier', 'Origin', 'Destination', '20\' base', '20\' margin', '20\' price', '40\' price', '40HC price']) {
        previewHeadRow.append(textCell(label, 'th'));
    }
    previewHead.append(previewHeadRow);
    previewTable.append(previewHead, previewBody);
    const previewPanel = document.createElement('section');
    previewPanel.id = 'customerPreview';
    previewPanel.hidden = true;
    previewPanel.append(previewTitle, filters, previewMeta, previewTable);

    container.append(
        heading('Customers'),
        paragraph('pull-forward-subtitle', 'Authorize customers for this company\'s rates, then set the percentage and fixed-dollar margin. Percent is a whole number: 10 is 10%.'),
        lookupForm,
        lookupResults,
        errors.box,
        wrap,
        previewPanel
    );

    function showError(error, fallback) {
        errors.show(adminFailureMessage(error, fallback));
    }

    function payload(extra) {
        return JSON.stringify({ companyId: companyIdOf(ctx.permissions), ...extra });
    }

    async function load() {
        errors.hide();
        const { customers } = await request('/api/admin/customers');
        render(customers);
        return customers;
    }

    function render(customers) {
        body.replaceChildren();
        if (!customers.length) {
            const row = document.createElement('tr');
            const cell = textCell('No authorized customers yet. Look one up to grant access.');
            cell.colSpan = 5;
            row.append(cell);
            body.append(row);
            return;
        }
        for (const customer of customers) {
            const row = document.createElement('tr');
            row.dataset.customerId = customer.id;
            const percent = numberInput(customer.marginPercent);
            percent.dataset.field = 'marginPercent';
            percent.setAttribute('aria-label', `Margin percent for ${customer.name}`);
            const dollars = numberInput(customer.marginNumber);
            dollars.dataset.field = 'marginNumber';
            dollars.setAttribute('aria-label', `Margin dollars for ${customer.name}`);
            const status = document.createElement('span');
            status.className = customer.status === 'revoked' ? 'customer-status customer-status-revoked' : 'customer-status';
            status.textContent = customer.status === 'revoked' ? 'Revoked' : 'Active';
            const actions = document.createElement('div');
            actions.className = 'customer-actions';
            actions.append(
                actionButton(customer.status === 'revoked' ? 'Re-authorize' : 'Save margins', customer.status === 'revoked' ? 'reactivate' : 'save', customer.id),
                actionButton('Preview', 'preview', customer.id)
            );
            if (customer.status !== 'revoked') {
                actions.append(actionButton('Revoke', 'revoke', customer.id));
            } else {
                actions.insertBefore(actionButton('Save margins', 'save', customer.id), actions.firstChild);
            }
            const percentCell = document.createElement('td');
            percentCell.append(percent);
            const dollarCell = document.createElement('td');
            dollarCell.append(dollars);
            const actionCell = document.createElement('td');
            actionCell.append(actions);
            row.append(textCell(customer.name), document.createElement('td'), percentCell, dollarCell, actionCell);
            row.children[1].append(status);
            body.append(row);
            row.addEventListener('click', event => onRowClick(event, customer, percent, dollars));
        }
    }

    function actionButton(label, action, id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.dataset.customerId = id;
        button.textContent = label;
        return button;
    }

    function draft(customer, percent, dollars) {
        const percentText = percent.value.trim();
        const dollarText = dollars.value.trim();
        const marginPercent = Number(percentText);
        const marginNumber = Number(dollarText);
        if (percentText === '' || dollarText === '' || !Number.isFinite(marginPercent) || !Number.isFinite(marginNumber)) {
            return { ok: false, error: 'Enter a margin percent and a dollar amount.' };
        }
        return {
            ok: true,
            marginPercent,
            marginNumber,
            dirty: marginPercent !== customer.marginPercent || marginNumber !== customer.marginNumber
        };
    }

    async function onRowClick(event, customer, percent, dollars) {
        const button = event.target.closest('button');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'preview') {
            await showPreview(customer, percent, dollars);
            return;
        }
        if (action === 'save') {
            const margins = draft(customer, percent, dollars);
            if (!margins.ok) {
                errors.show(margins.error);
                return;
            }
            const gate = confirmed(ctx.permissions, customer.name, 'Save margins for');
            if (!gate.allowed) {
                if (gate.message) errors.show(gate.message);
                return;
            }
            button.disabled = true;
            try {
                await request(`/api/admin/customers/${customer.id}/margins`, {
                    method: 'PATCH',
                    body: payload({ marginPercent: margins.marginPercent, marginNumber: margins.marginNumber })
                });
                const customers = await load();
                const saved = customers.find(item => item.id === customer.id) || customer;
                await showPreview(saved, null, null, { proposed: false });
            } catch (error) {
                showError(error, `Failed to save margins: ${error.message}`);
            } finally {
                button.disabled = false;
            }
            return;
        }
        if (action === 'revoke') {
            const gate = confirmed(ctx.permissions, customer.name, 'Revoke');
            if (!gate.allowed) {
                if (gate.message) errors.show(gate.message);
                return;
            }
            button.disabled = true;
            try {
                await request(`/api/admin/customers/${customer.id}/revoke`, { method: 'POST', body: payload() });
                const customers = await load();
                if (previewCustomerId === customer.id && !previewPanel.hidden) {
                    const revoked = customers.find(item => item.id === customer.id);
                    if (revoked) await showPreview(revoked, null, null, { proposed: false });
                }
            } catch (error) {
                showError(error, `Failed to revoke access: ${error.message}`);
            } finally {
                button.disabled = false;
            }
            return;
        }
        if (action === 'reactivate') {
            button.disabled = true;
            try {
                await request(`/api/admin/customers/${customer.id}/authorize`, { method: 'POST', body: payload() });
                const customers = await load();
                const saved = customers.find(item => item.id === customer.id);
                if (saved) await showPreview(saved, null, null, { proposed: false });
            } catch (error) {
                showError(error, `Failed to authorize ${customer.name}: ${error.message}`);
            } finally {
                button.disabled = false;
            }
        }
    }

    function filtersBody() {
        return {
            search: search.value.trim(),
            carrier: carrier.value.trim(),
            origin: origin.value.trim(),
            destination: destination.value.trim()
        };
    }

    async function showPreview(customer, percent, dollars, options = {}) {
        const margins = percent && dollars ? draft(customer, percent, dollars) : { ok: true, dirty: false };
        if (!margins.ok) {
            errors.show(margins.error);
            return;
        }
        const body = { ...filtersBody() };
        const sendProposed = options.proposed !== false && margins.dirty;
        if (sendProposed) {
            body.marginPercent = margins.marginPercent;
            body.marginNumber = margins.marginNumber;
        }
        const token = ++previewToken;
        previewCustomerId = customer.id;
        previewPanel.hidden = false;
        try {
            const preview = await request(`/api/admin/customers/${customer.id}/preview`, {
                method: 'POST',
                body: payload(body)
            });
            if (token !== previewToken) return;
            renderPreview(customer, preview);
        } catch (error) {
            if (token !== previewToken) return;
            showError(error, `Failed to preview prices: ${error.message}`);
        }
    }

    function renderPreview(customer, preview) {
        previewTitle.firstChild.textContent = `Live preview for ${customer.name}`;
        proposed.hidden = preview.proposed !== true;
        const when = preview.refreshedAt ? ` Refreshed ${preview.refreshedAt}.` : '';
        const margin = `${preview.marginPercent}% + $${preview.marginNumber}.`;
        previewMeta.textContent = preview.status === 'revoked'
            ? `Revoked customers do not see these rates.${when}`
            : `${margin}${when}`;
        previewBody.replaceChildren();
        if (!preview.rates.length) {
            const row = document.createElement('tr');
            const cell = textCell(preview.status === 'revoked' ? 'No rates while access is revoked.' : 'No matching rates.');
            cell.colSpan = 8;
            row.append(cell);
            previewBody.append(row);
            return;
        }
        for (const rate of preview.rates) {
            const row = document.createElement('tr');
            row.dataset.rateId = rate.id;
            row.append(
                textCell(rate.carrier),
                textCell(rate.originPort),
                textCell(rate.destinationPort),
                textCell(String(rate.base20D)),
                textCell(String(rate.appliedMargin20D)),
                textCell(String(rate.customerPrice20D)),
                textCell(String(rate.customerPrice40D)),
                textCell(String(rate.customerPrice40HC))
            );
            previewBody.append(row);
        }
    }

    lookupForm.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        lookupResults.replaceChildren();
        try {
            const query = new URLSearchParams({ q: lookupQuery.value.trim() });
            const { companies } = await request(`/api/admin/customers/lookup?${query}`);
            if (!companies.length) {
                lookupResults.append(paragraph('', 'No customer companies match that name.'));
                return;
            }
            for (const company of companies) {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.action = 'authorize';
                button.dataset.customerId = company.id;
                button.textContent = `Authorize ${company.name}`;
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        await request(`/api/admin/customers/${company.id}/authorize`, { method: 'POST', body: payload() });
                        lookupResults.replaceChildren();
                        await load();
                    } catch (error) {
                        showError(error, `Failed to authorize ${company.name}: ${error.message}`);
                        button.disabled = false;
                    }
                });
                lookupResults.append(button);
            }
        } catch (error) {
            showError(error, `Failed to look up customers: ${error.message}`);
        }
    });

    try {
        await load();
    } catch (error) {
        showError(error, `Failed to load customers: ${error.message}`);
    }
}

export function unmount() {
    previewCustomerId = '';
    previewToken += 1;
}
