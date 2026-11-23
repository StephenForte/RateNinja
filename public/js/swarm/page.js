import { errorBox, heading, paragraph, textCell } from '../dom.js';
import { renderSettings } from './admin.js';
import { read, write } from './client.js';
import { attachRuns } from './runs.js';
import { openWizard } from './wizard.js';

const PREMIUM = 'Premium feature. Contact Kings to enable Managed Agent Swarm.';
let stop;

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

function money(value) {
    return value == null ? 'None' : String(value);
}

export async function mount(container, context = {}) {
    stop?.();
    let active = true;
    const stops = [];
    stop = () => {
        active = false;
        while (stops.length) stops.pop()();
    };
    container.className = 'managed-agents swarm-page';
    const status = paragraph('agent-hint', 'Loading…');
    status.setAttribute('role', 'status');
    const pageError = errorBox();
    pageError.box.setAttribute('role', 'alert');
    const view = document.createElement('div');
    view.className = 'swarm-view';
    container.append(heading('Managed Agent Swarm (Premium)'), status, pageError.box, view);

    const permissions = context.permissions || {};
    try {
        if (permissions.systemAdmin === true) {
            if (!active) return;
            status.textContent = '';
            await renderSettings(view);
            return;
        }
        const access = await read('/api/swarm/access');
        if (!active) return;
        status.textContent = '';
        if (access && access.enabled === true) await renderCustomer(view, pageError, status, () => active, stops);
        else view.append(paragraph('swarm-premium', PREMIUM));
    } catch (error) {
        if (!active) return;
        status.textContent = '';
        pageError.show(error.message || 'Could not load Managed Agent Swarm.');
    }
}

async function renderCustomer(view, pageError, status, isActive, stops) {
    const [list, options] = await Promise.all([
        read('/api/swarms'),
        read('/api/managed-agents/options')
    ]);
    if (!isActive()) return;
    let swarms = list && Array.isArray(list.swarms) ? list.swarms.slice() : [];
    let starting = false;
    let runButtons = [];
    const bar = document.createElement('div');
    bar.className = 'agent-bar';
    const listHost = document.createElement('div');
    listHost.className = 'agent-list';
    const refusal = document.createElement('div');
    refusal.className = 'swarm-refusal';
    refusal.hidden = true;
    refusal.setAttribute('role', 'alert');
    const runsHost = document.createElement('div');
    runsHost.className = 'swarm-runs';
    const wizardHost = document.createElement('div');
    wizardHost.className = 'swarm-wizard-host';
    wizardHost.hidden = true;
    const newButton = button('New swarm', () => showWizard(null), 'agent-button agent-primary');
    bar.append(newButton);
    view.append(bar, listHost, refusal, runsHost, wizardHost);
    const monitor = attachRuns(runsHost, {
        isActive,
        onNavigate: clearRefusal,
        onChange() { syncRunButtons(); }
    });
    stops.push(() => monitor.stop());

    function clearRefusal() {
        refusal.replaceChildren();
        refusal.hidden = true;
    }

    function showRefusal(error) {
        clearRefusal();
        refusal.hidden = false;
        refusal.append(paragraph('swarm-refusal-message', error.message || 'Request failed.'));
        if (error.code === 'run_active') {
            refusal.append(button('Open running run', () => monitor.openRunning(), 'agent-button'));
        }
        if (error.code === 'swarm_not_ready') {
            for (const reason of Array.isArray(error.reasons) ? error.reasons : []) {
                if (typeof reason === 'string') refusal.append(paragraph('swarm-reason', reason));
            }
        }
    }

    function syncRunButtons() {
        const disabled = starting || monitor.hasRunning();
        for (const control of runButtons) control.disabled = disabled;
    }

    function showList() {
        wizardHost.hidden = true;
        wizardHost.replaceChildren();
        bar.hidden = false;
        listHost.hidden = false;
        monitor.setShown(true);
        monitor.showList();
        renderList();
    }

    function showWizard(swarm) {
        pageError.hide();
        clearRefusal();
        bar.hidden = true;
        listHost.hidden = true;
        monitor.setShown(false);
        wizardHost.hidden = false;
        openWizard(wizardHost, {
            options,
            swarm,
            onCancel: showList,
            async onDone(saved, outcome) {
                if (!isActive()) return;
                const index = swarms.findIndex(item => item.id === saved.id);
                if (index >= 0) swarms[index] = saved;
                else swarms.unshift(saved);
                status.textContent = 'Swarm saved.';
                showList();
                if (outcome && outcome.run) await startRun(saved, { skipConfirm: true });
            }
        });
    }

    function renderList() {
        listHost.replaceChildren();
        runButtons = [];
        if (!swarms.length) {
            listHost.append(paragraph('agent-empty', 'No swarms yet.'));
            return;
        }
        const table = document.createElement('table');
        table.className = 'agent-grid swarm-grid';
        const head = document.createElement('tr');
        for (const label of ['Name', 'Instructions', 'Lanes', 'Spend cap', 'Slots cap', 'Updated']) {
            head.append(textCell(label, 'th'));
        }
        head.append(textCell('', 'th'));
        const body = document.createElement('tbody');
        for (const swarm of swarms) {
            const row = document.createElement('tr');
            row.append(
                textCell(swarm.name || '', 'td', 'swarm-name'),
                textCell(swarm.instructions || '', 'td', 'swarm-instructions'),
                textCell(String(Array.isArray(swarm.lanes) ? swarm.lanes.length : 0), 'td'),
                textCell(money(swarm.totalSpendCap), 'td'),
                textCell(money(swarm.totalSlotsCap), 'td'),
                textCell(swarm.updatedAt || '—', 'td')
            );
            const actions = document.createElement('td');
            const runButton = button('Run', () => startRun(swarm), 'agent-button');
            runButtons.push(runButton);
            actions.append(runButton);
            if (swarm.canEdit === true) {
                actions.append(
                    button('Edit', () => showWizard(swarm), 'agent-button'),
                    button('Delete', () => remove(swarm), 'agent-button agent-delete')
                );
            }
            row.append(actions);
            body.append(row);
        }
        table.append(head, body);
        listHost.append(table);
        syncRunButtons();
    }

    async function startRun(swarm, { skipConfirm = false } = {}) {
        if (!isActive() || starting) return;
        const name = typeof swarm.name === 'string' ? swarm.name : '';
        if (!skipConfirm) {
            if (monitor.hasRunning()) return;
            if (!window.confirm(`Run ${name}? The run may request bookings inside its caps.`)) return;
        }
        starting = true;
        syncRunButtons();
        clearRefusal();
        try {
            const payload = await write(`/api/swarms/${encodeURIComponent(swarm.id)}/runs`, 'POST');
            if (!isActive()) return;
            const run = payload && payload.run;
            if (!run || !run.id) {
                showRefusal({ message: 'Could not start the swarm run.', code: '', reasons: [] });
                return;
            }
            monitor.remember(run);
            await monitor.open(run.id);
        } catch (error) {
            if (isActive()) showRefusal(error);
        } finally {
            starting = false;
            if (isActive()) syncRunButtons();
        }
    }

    async function remove(swarm) {
        const name = typeof swarm.name === 'string' ? swarm.name : '';
        if (!window.confirm(`Delete the swarm ${name}?`)) return;
        pageError.hide();
        try {
            await write(`/api/swarms/${encodeURIComponent(swarm.id)}`, 'DELETE');
            if (!isActive()) return;
            swarms = swarms.filter(item => item.id !== swarm.id);
            status.textContent = 'Swarm deleted.';
            renderList();
        } catch (error) {
            if (isActive()) pageError.show(error.message || 'Could not delete the swarm.');
        }
    }

    await monitor.load();
    if (!isActive()) return;
    renderList();
}

export function unmount() {
    stop?.();
    stop = null;
}
