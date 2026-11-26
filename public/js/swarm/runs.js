import { heading, paragraph } from '../dom.js';
import { read, write } from './client.js';
import { renderRunDetail, renderRunTable } from './run-view.js';

const POLL_MS = 2000;

function button(text, action, className = '') {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    if (className) control.className = className;
    if (action) control.addEventListener('click', action);
    return control;
}

export function attachRuns(host, { isActive, onNavigate, onChange } = {}) {
    let runs = [];
    let detail = null;
    let mode = 'list';
    let visible = true;
    let polls = true;
    let stopped = false;
    let listBusy = false;
    let detailBusy = false;
    let detailTarget = null;
    let cancelling = false;
    let listTimer = null;
    let detailTimer = null;

    const alert = paragraph('swarm-run-alert', '');
    alert.hidden = true;
    alert.setAttribute('role', 'alert');
    const listHost = document.createElement('div');
    listHost.className = 'agent-grid-scroll swarm-run-list';
    const detailHost = document.createElement('div');
    detailHost.className = 'swarm-run-detail';
    detailHost.hidden = true;
    const back = button('Back to runs', () => showList(), 'agent-button');
    const detailBody = document.createElement('div');
    detailHost.append(back, detailBody);
    host.replaceChildren(heading('Runs'), alert, listHost, detailHost);

    function alive() {
        return !stopped && (typeof isActive !== 'function' || isActive());
    }

    function changed() {
        if (typeof onChange === 'function') onChange();
    }

    function showAlert(message) {
        alert.textContent = message || '';
        alert.hidden = !message;
    }

    function clearListTimer() {
        if (listTimer) globalThis.clearInterval(listTimer);
        listTimer = null;
    }

    function clearDetailTimer() {
        if (detailTimer) globalThis.clearInterval(detailTimer);
        detailTimer = null;
    }

    function haltPolls() {
        polls = false;
        clearListTimer();
        clearDetailTimer();
    }

    function remember(run) {
        if (!run || !run.id) return;
        const index = runs.findIndex(item => item.id === run.id);
        if (index >= 0) runs[index] = { ...runs[index], ...run };
        else runs.unshift({ ...run });
    }

    function hasRunning() {
        if (mode === 'detail' && detail && detail.status === 'running') return true;
        return runs.some(run => run.status === 'running');
    }

    function paintList() {
        renderRunTable(listHost, runs, { onOpen(run) { return open(run.id); } });
    }

    function paintDetail() {
        listHost.hidden = true;
        detailHost.hidden = false;
        const cancellable = detail && detail.status === 'running' && detail.cancelRequested !== true;
        renderRunDetail(detailBody, detail, cancellable ? { onCancel: cancel } : {});
    }

    function arm() {
        if (!alive() || !polls || !visible) {
            clearListTimer();
            clearDetailTimer();
            return;
        }
        if (mode === 'detail' && detail && detail.status === 'running') {
            clearListTimer();
            if (!detailTimer) detailTimer = globalThis.setInterval(() => { refreshDetail(detail.id); }, POLL_MS);
            return;
        }
        clearDetailTimer();
        if (mode === 'list' && runs.some(run => run.status === 'running')) {
            if (!listTimer) listTimer = globalThis.setInterval(() => { refreshList(); }, POLL_MS);
            return;
        }
        clearListTimer();
    }

    async function refreshList() {
        if (!alive() || listBusy) return;
        listBusy = true;
        try {
            const payload = await read('/api/swarm-runs');
            if (!alive()) return;
            runs = payload && Array.isArray(payload.runs) ? payload.runs : [];
            if (detail) {
                const fresh = runs.find(run => run.id === detail.id);
                if (fresh) detail = { ...detail, ...fresh, agents: detail.agents };
            }
            if (mode === 'list') paintList();
            showAlert('');
            arm();
            changed();
        } catch (error) {
            if (!alive()) return;
            if (error.status === 401 || error.status === 403) haltPolls();
            showAlert(error.message || 'Request failed.');
        } finally {
            listBusy = false;
        }
    }

    async function refreshDetail(id) {
        if (!alive() || !id) return false;
        detailTarget = id;
        if (detailBusy) return false;
        detailBusy = true;
        let requested = id;
        try {
            while (alive()) {
                requested = detailTarget;
                if (!requested || mode !== 'detail') return false;
                try {
                    const payload = await read(`/api/swarm-runs/${encodeURIComponent(requested)}`);
                    if (!alive()) return false;
                    if (mode !== 'detail' || detailTarget !== requested) {
                        if (mode !== 'detail') return false;
                        continue;
                    }
                    if (!payload || !payload.run) return false;
                    detail = payload.run;
                    remember(detail);
                paintDetail();
                showAlert('');
                arm();
                changed();
                return true;
                } catch (error) {
                    if (!alive()) return false;
                    if (error.status === 401 || error.status === 403) {
                        haltPolls();
                        showAlert(error.message || 'Request failed.');
                        return false;
                    }
                    if (mode === 'detail' && detailTarget && detailTarget !== requested) continue;
                    if (mode === 'detail' && detailTarget === requested) {
                        showAlert(error.message || 'Request failed.');
                    }
                    return false;
                }
            }
            return false;
        } finally {
            detailBusy = false;
        }
    }

    async function open(id) {
        if (!alive() || !id) return;
        if (typeof onNavigate === 'function' && mode !== 'detail') onNavigate();
        mode = 'detail';
        listHost.hidden = true;
        detailHost.hidden = false;
        clearListTimer();
        await refreshDetail(id);
    }

    async function openRunning() {
        await refreshList();
        const running = runs.find(run => run.status === 'running');
        if (running) await open(running.id);
    }

    function showList() {
        detailTarget = null;
        if (detail) remember(detail);
        mode = 'list';
        detailHost.hidden = true;
        listHost.hidden = false;
        clearDetailTimer();
        paintList();
        arm();
        refreshList();
    }

    async function cancel() {
        const current = detail;
        if (!alive() || cancelling || !current || current.status !== 'running' || current.cancelRequested === true) return;
        if (!window.confirm('Cancel this swarm run?')) return;
        cancelling = true;
        try {
            const payload = await write(`/api/swarm-runs/${encodeURIComponent(current.id)}/cancel`, 'POST');
            if (!alive()) return;
            detail = { ...current, ...(payload && payload.run), agents: current.agents };
            remember(detail);
            if (mode === 'detail') paintDetail();
            showAlert('');
            arm();
            changed();
        } catch (error) {
            if (!alive()) return;
            if (error.status === 409 && error.code === 'not_running') {
                showAlert('');
                await refreshDetail(current.id);
                return;
            }
            if (error.status === 401 || error.status === 403) haltPolls();
            showAlert(error.message || 'Request failed.');
        } finally {
            cancelling = false;
        }
    }

    function setShown(next) {
        visible = Boolean(next);
        host.hidden = !visible;
        arm();
    }

    function stop() {
        stopped = true;
        haltPolls();
    }

    return { load: refreshList, hasRunning, remember, open, openRunning, showList, setShown, stop };
}
