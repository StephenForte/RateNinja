import { request } from '../api.js';
import { errorBox, heading, paragraph, textCell } from '../dom.js';
import { renderRunDetail, renderRunTable } from '../swarm/run-view.js';

const API = '/api/admin/swarm-runs';
const POLL_MS = 2000;
let stop;

function button(label, action) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'agent-button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
}

function renderCompanies(host, companies, onOpen) {
    if (!companies.length) {
        host.replaceChildren(paragraph('agent-empty', 'No customer has run a swarm yet.'));
        return;
    }
    const table = document.createElement('table');
    table.className = 'admin-table';
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of ['Customer', 'Runs', 'Last started', 'Status']) {
        const cell = textCell(label, 'th');
        cell.scope = 'col';
        header.append(cell);
    }
    head.append(header);
    const body = document.createElement('tbody');
    for (const company of companies) {
        const row = document.createElement('tr');
        const name = document.createElement('td');
        name.append(button(company.name, () => onOpen(company)));
        row.append(name, textCell(String(company.runCount)), textCell(company.lastStartedAt),
            textCell(company.running ? 'Running' : ''));
        body.append(row);
    }
    table.append(head, body);
    host.replaceChildren(table);
}

export function mount(container) {
    unmount();
    const controller = new AbortController();
    const sectionView = document.getElementById?.('sectionView');
    let shown = !sectionView?.hidden;
    let timer;
    let busy = false;
    let view;

    const title = heading('Swarm runs');
    const toolbar = document.createElement('div');
    toolbar.className = 'agent-bar';
    const errors = errorBox();
    errors.box.setAttribute('role', 'alert');
    const body = document.createElement('div');
    body.className = 'admin-table-wrap';
    container.className = 'managed-agents';
    container.replaceChildren(title, toolbar, errors.box, body);

    const observer = sectionView && new MutationObserver(() => {
        const visible = !sectionView.hidden;
        if (visible === shown) return;
        shown = visible;
        if (shown) refresh();
        else clearTimeout(timer);
    });
    observer?.observe(sectionView, { attributes: true, attributeFilter: ['hidden'] });
    stop = () => {
        clearTimeout(timer);
        observer?.disconnect();
        controller.abort();
    };

    function show(next, { titleText, backLabel, back } = {}) {
        if (controller.signal.aborted) return;
        view = next;
        title.textContent = titleText || 'Swarm runs';
        toolbar.replaceChildren(...(back ? [button(backLabel, back)] : []));
        errors.hide();
        body.replaceChildren(paragraph('agent-hint', 'Loading…'));
        return refresh();
    }

    async function refresh() {
        clearTimeout(timer);
        if (busy || !shown || controller.signal.aborted) return;
        const current = view;
        busy = true;
        try {
            const result = await request(current.path, { signal: controller.signal });
            if (current !== view || controller.signal.aborted) return;
            errors.hide();
            current.running = current.render(result);
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error.status === 401 || error.status === 403) {
                unmount();
                title.textContent = 'Swarm runs';
                toolbar.replaceChildren();
                body.replaceChildren();
            } else if (current !== view) {
                return;
            } else if (error.status === 404 || !current.running) {
                current.running = false;
                body.replaceChildren();
            }
            errors.show(error.message || 'Could not load swarm runs.');
        } finally {
            busy = false;
            if (shown && !controller.signal.aborted) {
                if (current !== view) refresh();
                else if (current.running) timer = setTimeout(refresh, POLL_MS);
            }
        }
    }

    function showCompanies() {
        return show({
            path: `${API}/companies`,
            render({ companies }) {
                renderCompanies(body, companies, showRuns);
                return companies.some(company => company.running);
            }
        });
    }

    function showRuns(company) {
        return show({
            path: `${API}?${new URLSearchParams({ companyId: company.companyId })}`,
            render({ runs }) {
                renderRunTable(body, runs, { onOpen: run => showRun(company, run) });
                return runs.some(run => run.status === 'running');
            }
        }, { titleText: company.name, backLabel: 'Back to customers', back: showCompanies });
    }

    function showRun(company, selected) {
        return show({
            path: `${API}/${encodeURIComponent(selected.id)}`,
            render({ run }) {
                renderRunDetail(body, run, { showTokens: true });
                return run.status === 'running';
            }
        }, { titleText: selected.swarmName, backLabel: 'Back to runs', back: () => showRuns(company) });
    }

    return showCompanies();
}

export function unmount() {
    stop?.();
    stop = null;
}
