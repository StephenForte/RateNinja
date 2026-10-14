import { companyOperationGate } from '../confirm.js';
import { parseIsoDate } from '../dates.js';
import { request } from '../api.js';
import { adminFailureMessage } from '../permissions.js';
import { errorBox, heading, paragraph } from '../dom.js';

const STEPS = ['Dataset', 'Source', 'Target start', 'Conflict', 'Preview', 'Confirm'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addUtcDays(value, days) {
    const parsed = parseIsoDate(value);
    if (!parsed || !Number.isInteger(days)) return '';
    return new Date(parsed.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function daySpan(start, end) {
    const from = parseIsoDate(start);
    const to = parseIsoDate(end);
    if (!from || !to) return null;
    return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function dateInput(id, label) {
    const input = document.createElement('input');
    input.type = 'date';
    input.id = id;
    const wrap = document.createElement('div');
    wrap.className = 'pf-field';
    const field = document.createElement('label');
    field.htmlFor = id;
    field.textContent = label;
    wrap.append(field, input);
    return { wrap, input };
}

function textInput(id, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    const wrap = document.createElement('div');
    wrap.className = 'pf-field';
    const field = document.createElement('label');
    field.htmlFor = id;
    field.textContent = label;
    wrap.append(field, input);
    return { wrap, input };
}

export function mount(container, ctx) {
    container.replaceChildren();
    const errors = errorBox('error-message');
    const success = document.createElement('div');
    success.className = 'pull-forward-success';
    success.hidden = true;
    const successText = document.createElement('span');
    success.append(successText);

    const type = document.createElement('select');
    type.id = 'pullForwardType';
    for (const [value, label] of [['rates', 'Rates'], ['sailings', 'Sailings']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        type.append(option);
    }

    const price = document.createElement('input');
    price.type = 'number';
    price.id = 'pfPriceIncrease';
    price.min = '0';
    price.max = '100';
    price.step = '0.01';
    price.value = '0';

    const sourceStart = dateInput('pfSourceStart', 'Source start');
    const sourceEnd = dateInput('pfSourceEnd', 'Source end');
    const targetStart = dateInput('pfTargetStart', 'Target start');
    const carrier = textInput('pfCarrier', 'Carrier (optional)');
    const origin = textInput('pfOrigin', 'Origin port (optional)');
    const destination = textInput('pfDestination', 'Destination port (optional)');
    const departurePort = textInput('pfDeparturePort', 'Departure port (optional)');

    const targetEnd = document.createElement('p');
    targetEnd.id = 'pfTargetEnd';
    targetEnd.className = 'pf-target-end';
    targetEnd.textContent = 'Target end: —';

    const keep = document.createElement('input');
    keep.type = 'radio';
    keep.name = 'pfConflict';
    keep.id = 'pfConflictKeep';
    keep.value = 'keep';
    keep.checked = true;
    const replace = document.createElement('input');
    replace.type = 'radio';
    replace.name = 'pfConflict';
    replace.id = 'pfConflictReplace';
    replace.value = 'replace';

    const previewSummary = document.createElement('div');
    previewSummary.id = 'pfPreviewSummary';
    previewSummary.className = 'pf-preview';
    const replacedList = document.createElement('ul');
    replacedList.id = 'pfReplacedList';
    const confirmText = document.createElement('p');
    confirmText.id = 'pfConfirmText';
    confirmText.className = 'pf-confirm-text';

    let step = 0;
    let preview = null;
    const panels = [];

    function resetMessages() {
        errors.hide();
        success.hidden = true;
    }

    function conflictChoice() {
        return replace.checked ? 'replace' : 'keep';
    }

    function derivedEnd() {
        const span = daySpan(sourceStart.input.value, targetStart.input.value);
        if (span === null || !parseIsoDate(sourceEnd.input.value)) return '';
        return addUtcDays(sourceEnd.input.value, span);
    }

    function refreshTargetEnd() {
        const end = derivedEnd();
        targetEnd.textContent = end ? `Target end: ${end}` : 'Target end: enter a source range and a target start.';
    }

    function syncType() {
        const rates = type.value === 'rates';
        price.disabled = !rates;
        if (!rates) price.value = '0';
        origin.wrap.hidden = !rates;
        destination.wrap.hidden = !rates;
        departurePort.wrap.hidden = rates;
        preview = null;
        resetMessages();
    }

    function filterBody() {
        const filter = {};
        if (carrier.input.value.trim()) filter.carrier = carrier.input.value.trim();
        if (type.value === 'rates') {
            if (origin.input.value.trim()) filter.origin = origin.input.value.trim();
            if (destination.input.value.trim()) filter.destination = destination.input.value.trim();
        } else if (departurePort.input.value.trim()) {
            filter.departurePort = departurePort.input.value.trim();
        }
        return filter;
    }

    function validateStep() {
        if (step === 0 && type.value === 'rates') {
            const percent = Number(price.value);
            if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                return 'Price increase percent must be a number between 0 and 100.';
            }
        }
        if (step === 1) {
            if (!parseIsoDate(sourceStart.input.value) || !parseIsoDate(sourceEnd.input.value)) {
                return 'Source start and source end must be valid dates.';
            }
            if (sourceStart.input.value > sourceEnd.input.value) {
                return 'Source start date must not be after source end date.';
            }
        }
        if (step === 2) {
            const end = derivedEnd();
            if (!parseIsoDate(targetStart.input.value) || !end) return 'Target start must be a valid date.';
            if (targetStart.input.value <= sourceEnd.input.value) {
                return 'Target range must start after the source range ends.';
            }
        }
        return '';
    }

    function showStep(next) {
        step = next;
        panels.forEach((panel, index) => {
            panel.hidden = index !== step;
        });
        stepButtons.forEach((button, index) => {
            if (index === step) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
        });
        back.hidden = step === 0;
        nextButton.hidden = step === STEPS.length - 1;
        nextButton.textContent = step === 4 ? 'Preview' : 'Next';
        refreshTargetEnd();
    }

    async function runPreview() {
        const gate = companyOperationGate(ctx.permissions, 'Preview this pull-forward.');
        if (!gate.allowed) {
            errors.show(gate.message);
            return false;
        }
        const body = {
            dataset: type.value,
            companyId: ctx.permissions.companyContext?.id,
            sourceStart: sourceStart.input.value,
            sourceEnd: sourceEnd.input.value,
            targetStart: targetStart.input.value,
            conflict: conflictChoice(),
            filter: filterBody()
        };
        if (type.value === 'rates') body.priceIncreasePercent = Number(price.value);
        preview = await request('/api/admin/data/pull-forward/preview', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        previewSummary.replaceChildren();
        const lines = [
            `Dataset: ${preview.dataset}`,
            `Source: ${preview.sourceStart} to ${preview.sourceEnd}`,
            `Target: ${preview.targetStart} to ${preview.targetEnd}`,
            `Conflict: ${preview.conflict}`,
            `Rows to copy: ${preview.copied}`,
            `Matching target rows to replace: ${preview.replaced}`
        ];
        if (type.value === 'rates') lines.push(`Price increase: ${preview.priceIncreasePercent}%`);
        for (const line of lines) previewSummary.append(paragraph('', line));
        replacedList.replaceChildren();
        for (const row of preview.replacedRecords || []) {
            const item = document.createElement('li');
            const route = preview.dataset === 'rates'
                ? `${row.origin} → ${row.destination}`
                : row.departurePort;
            item.textContent = `${row.id} ${row.carrier} ${route} ${row.date}`;
            replacedList.append(item);
        }
        if ((preview.replacedRecords || []).length) previewSummary.append(replacedList);
        return true;
    }

    function showConfirm() {
        const action = preview.conflict === 'replace'
            ? `Pull ${preview.dataset} forward and replace ${preview.replaced} matching target rows. Target ends ${preview.targetEnd}.`
            : `Pull ${preview.dataset} forward and keep existing target rows. Target ends ${preview.targetEnd}.`;
        const gate = companyOperationGate(ctx.permissions, action);
        confirmText.textContent = gate.message;
        return gate;
    }

    const stepButtons = STEPS.map((label, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pf-step';
        button.textContent = `${index + 1}. ${label}`;
        button.addEventListener('click', () => {
            if (index < step) {
                preview = null;
                showStep(index);
            }
        });
        return button;
    });
    const steps = document.createElement('div');
    steps.className = 'pf-steps';
    steps.append(...stepButtons);

    function panel(title, ...nodes) {
        const section = document.createElement('section');
        section.className = 'pf-panel';
        const headingNode = document.createElement('h3');
        headingNode.textContent = title;
        section.append(headingNode, ...nodes);
        panels.push(section);
        return section;
    }

    const typeWrap = document.createElement('div');
    typeWrap.className = 'pf-field';
    const typeLabel = document.createElement('label');
    typeLabel.htmlFor = type.id;
    typeLabel.textContent = 'Dataset';
    typeWrap.append(typeLabel, type);
    const priceWrap = document.createElement('div');
    priceWrap.className = 'pf-field';
    const priceLabel = document.createElement('label');
    priceLabel.htmlFor = price.id;
    priceLabel.textContent = 'Price increase (%)';
    priceWrap.append(priceLabel, price);

    const keepBox = document.createElement('label');
    keepBox.className = 'pf-conflict-keep';
    keepBox.append(keep, document.createTextNode(' Keep existing target rows'));
    const replaceBox = document.createElement('label');
    replaceBox.className = 'pf-conflict-replace';
    const replaceCopy = document.createElement('span');
    replaceCopy.append(
        document.createTextNode(' Replace matching target rows. '),
        document.createElement('br'),
        document.createTextNode('This soft-deletes only rows for this company that match the same carrier and route filters inside the target window. It is not automatic deduplication.')
    );
    replaceBox.append(replace, replaceCopy);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.textContent = 'Back';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'save-btn';
    nextButton.textContent = 'Next';
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.id = 'pfConfirmBtn';
    confirmButton.className = 'save-btn';
    confirmButton.textContent = 'Confirm pull-forward';

    back.addEventListener('click', () => {
        resetMessages();
        preview = null;
        showStep(Math.max(0, step - 1));
    });
    nextButton.addEventListener('click', async () => {
        resetMessages();
        const message = validateStep();
        if (message) {
            errors.show(message);
            return;
        }
        if (step < 4) {
            preview = null;
            showStep(step + 1);
            return;
        }
        if (!preview) {
            nextButton.disabled = true;
            try {
                const ok = await runPreview();
                if (ok) nextButton.textContent = 'Next';
            } catch (error) {
                errors.show(adminFailureMessage(error, error.message));
            } finally {
                nextButton.disabled = false;
            }
            return;
        }
        showConfirm();
        showStep(5);
    });
    confirmButton.addEventListener('click', async () => {
        resetMessages();
        if (!preview) {
            errors.show('Preview this pull-forward before confirming.');
            return;
        }
        const gate = showConfirm();
        if (!gate.allowed) {
            errors.show(gate.message);
            return;
        }
        if (!window.confirm(gate.message)) return;
        confirmButton.disabled = true;
        try {
            const result = await request('/api/admin/data/pull-forward', {
                method: 'POST',
                body: JSON.stringify({
                    previewId: preview.previewId,
                    submissionId: crypto.randomUUID(),
                    companyId: ctx.permissions.companyContext?.id
                })
            });
            successText.textContent = `Copied ${result.copied} ${result.dataset}, replaced ${result.deleted}, at ${result.company.name}.`;
            success.hidden = false;
            preview = null;
        } catch (error) {
            errors.show(adminFailureMessage(error, error.message));
        } finally {
            confirmButton.disabled = false;
        }
    });

    for (const input of [type, price, sourceStart.input, sourceEnd.input, targetStart.input, carrier.input, origin.input, destination.input, departurePort.input, keep, replace]) {
        input.addEventListener('change', () => {
            preview = null;
            if (step === 4) nextButton.textContent = 'Preview';
            refreshTargetEnd();
            resetMessages();
        });
    }
    type.addEventListener('change', syncType);
    targetStart.input.addEventListener('input', refreshTargetEnd);
    sourceStart.input.addEventListener('input', refreshTargetEnd);
    sourceEnd.input.addEventListener('input', refreshTargetEnd);

    const form = document.createElement('div');
    form.className = 'pull-forward-form';
    form.append(
        steps,
        panel('1. Dataset', typeWrap, priceWrap, paragraph('pull-forward-subtitle', 'Choose rates or sailings. A price increase applies to rates only, once.')),
        panel('2. Source', sourceStart.wrap, sourceEnd.wrap, carrier.wrap, origin.wrap, destination.wrap, departurePort.wrap),
        panel('3. Target start', targetStart.wrap, targetEnd, paragraph('pull-forward-subtitle', 'The target end is the source duration applied to this start. It must end within 90 days of today.')),
        panel('4. Conflict choice', keepBox, replaceBox),
        panel('5. Preview', paragraph('pull-forward-subtitle', 'Preview the exact rows, then continue. Replace lists only the matching target rows.'), previewSummary),
        panel('6. Confirm', confirmText, confirmButton),
        errors.box,
        success
    );
    const actions = document.createElement('div');
    actions.className = 'pull-forward-actions';
    actions.append(back, nextButton);
    form.append(actions);

    const shell = document.createElement('div');
    shell.className = 'pull-forward-panel';
    shell.append(
        heading('Pull Forward'),
        paragraph('pull-forward-subtitle', 'Copy a source date range into a future range. Keeping target rows is the default.'),
        form
    );
    container.append(shell);
    syncType();
    showStep(0);
}

export function unmount() {}
