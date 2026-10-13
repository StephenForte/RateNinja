import { companyOperationGate } from '../confirm.js';
import { request } from '../api.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';

const SAVE_CONCURRENCY = 3;
let changes = new Map();

async function mapPool(items, concurrency, worker) {
    const results = [];
    let index = 0;
    async function run() {
        while (index < items.length) {
            const current = index;
            index += 1;
            results[current] = await worker(items[current], current);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
    return results;
}

export async function mount(container, ctx) {
    changes = new Map();
    container.replaceChildren();
    const errors = errorBox();
    const loading = document.createElement('div');
    loading.className = 'loading';
    const spinner = document.createElement('i');
    spinner.className = 'fas fa-spinner fa-spin';
    spinner.setAttribute('aria-hidden', 'true');
    loading.append(spinner, document.createTextNode(' Loading companies...'));
    const wrap = document.createElement('div');
    wrap.className = 'admin-table-container';
    wrap.hidden = true;
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Customer company', 'Margin Percent (%)', 'Margin Number ($)', 'Linked']) {
        headRow.append(textCell(label, 'th'));
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    table.append(head, body);
    wrap.append(table);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'save-btn';
    save.textContent = 'Save Changes';
    container.append(
        heading('Customers'),
        paragraph('pull-forward-subtitle', 'Margins for customer companies.'),
        loading,
        errors.box,
        wrap,
        save
    );

    function render(companies) {
        body.replaceChildren();
        if (!companies.length) {
            const row = document.createElement('tr');
            const cell = textCell('No customer companies found');
            cell.colSpan = 4;
            cell.className = 'empty-table-message';
            row.append(cell);
            body.append(row);
            return;
        }
        companies.forEach(company => {
            const row = document.createElement('tr');
            row.append(textCell(company.name));
            row.append(marginInput(company, 'marginPercent', company.marginPercent));
            row.append(marginInput(company, 'marginNumber', company.marginNumber));
            row.append(textCell(company.linked ? 'Yes' : 'No'));
            body.append(row);
        });
    }

    function marginInput(company, field, value) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '1000000';
        input.step = '0.01';
        input.value = value;
        input.addEventListener('input', () => {
            const next = changes.get(company.id) || {
                marginPercent: company.marginPercent,
                marginNumber: company.marginNumber
            };
            next[field] = Number(input.value);
            changes.set(company.id, next);
            input.classList.add('changed');
        });
        cell.append(input);
        return cell;
    }

    save.addEventListener('click', async () => {
        if (!changes.size) return;
        const gate = companyOperationGate(ctx.permissions, 'Save customer margins.');
        if (!gate.allowed) {
            errors.show(gate.message);
            return;
        }
        if (!window.confirm(gate.message)) return;
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            await mapPool([...changes], SAVE_CONCURRENCY, ([id, patch]) => request(`/api/admin/companies/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch)
            }));
            changes.clear();
            await load();
        } catch (error) {
            errors.show(`Failed to save changes: ${error.message}`);
        } finally {
            save.disabled = false;
            save.textContent = 'Save Changes';
        }
    });

    async function load() {
        loading.hidden = false;
        errors.hide();
        wrap.hidden = true;
        changes.clear();
        try {
            const { companies } = await request('/api/admin/companies');
            render(companies);
            wrap.hidden = false;
        } catch (error) {
            errors.show(`Failed to load administration data: ${error.message}`);
        } finally {
            loading.hidden = true;
        }
    }

    await load();
}

export function unmount() {
    changes = new Map();
}
