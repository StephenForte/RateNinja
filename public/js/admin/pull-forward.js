import { companyOperationGate } from '../confirm.js';
import { fullDaysUntil, parseIsoDate } from '../dates.js';
import { request } from '../api.js';
import { errorBox, fieldLabel, heading, paragraph } from '../dom.js';

function validatePullForward({ sourceStart, sourceEnd, targetStart, targetEnd, type, priceIncreasePercent }) {
    const start = parseIsoDate(sourceStart);
    const sEnd = parseIsoDate(sourceEnd);
    const tStart = parseIsoDate(targetStart);
    const tEnd = parseIsoDate(targetEnd);
    if (!start || !sEnd || !tStart || !tEnd) {
        return 'Source and target ranges must all be valid dates.';
    }
    if (start.getTime() > sEnd.getTime()) {
        return 'Source start date must not be after source end date.';
    }
    if (tStart.getTime() > tEnd.getTime()) {
        return 'Target start date must not be after target end date.';
    }
    if (tStart.getTime() <= sEnd.getTime()) {
        return 'Target range must start after the source range ends.';
    }
    if (fullDaysUntil(tEnd) > 90) {
        return 'Target range must end within 90 days of today.';
    }
    if (sEnd.getTime() - start.getTime() !== tEnd.getTime() - tStart.getTime()) {
        return 'Target range length must equal source range length.';
    }
    if (type === 'rates' && (!Number.isFinite(priceIncreasePercent) || priceIncreasePercent < 0 || priceIncreasePercent > 100)) {
        return 'Price increase percent must be a number between 0 and 100.';
    }
    return null;
}

function dateField(id, label) {
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

export function mount(container, ctx) {
    container.replaceChildren();
    const errors = errorBox('error-message');
    const success = document.createElement('div');
    success.className = 'pull-forward-success';
    success.hidden = true;
    const successIcon = document.createElement('i');
    successIcon.className = 'fas fa-check-circle';
    successIcon.setAttribute('aria-hidden', 'true');
    const successText = document.createElement('span');
    success.append(successIcon, successText);

    const type = document.createElement('select');
    type.id = 'pullForwardType';
    for (const [value, label] of [['rates', 'Rates'], ['sailings', 'Sailings']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        type.append(option);
    }
    const typeWrap = document.createElement('div');
    typeWrap.className = 'pf-field';
    const typeLabel = document.createElement('label');
    typeLabel.htmlFor = type.id;
    typeLabel.textContent = 'Data type';
    typeWrap.append(typeLabel, type);

    const sourceStart = dateField('pfSourceStart', 'Source start');
    const sourceEnd = dateField('pfSourceEnd', 'Source end');
    const targetStart = dateField('pfTargetStart', 'Target start');
    const targetEnd = dateField('pfTargetEnd', 'Target end');

    const price = document.createElement('input');
    price.type = 'number';
    price.id = 'pfPriceIncrease';
    price.min = '0';
    price.max = '100';
    price.step = '0.01';
    price.value = '0';
    const priceWrap = document.createElement('div');
    priceWrap.className = 'pf-field';
    const priceLabel = document.createElement('label');
    priceLabel.htmlFor = price.id;
    priceLabel.textContent = 'Price increase (%)';
    priceWrap.append(priceLabel, price);

    const deleteExisting = document.createElement('input');
    deleteExisting.type = 'checkbox';
    deleteExisting.id = 'pfDeleteExisting';
    const deleteWrap = document.createElement('div');
    deleteWrap.className = 'pf-field pf-checkbox';
    const deleteLabel = document.createElement('label');
    deleteLabel.htmlFor = deleteExisting.id;
    deleteLabel.append(deleteExisting, document.createTextNode(' Delete existing data in target range'));
    deleteWrap.append(deleteLabel);

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'pullForwardBtn';
    button.className = 'save-btn';
    const buttonIcon = document.createElement('i');
    buttonIcon.className = 'fas fa-forward';
    buttonIcon.setAttribute('aria-hidden', 'true');
    button.append(buttonIcon, document.createTextNode(' Pull Forward'));

    function resetMessages() {
        errors.hide();
        success.hidden = true;
    }

    function syncType() {
        const isRates = type.value === 'rates';
        price.disabled = !isRates;
        if (!isRates) price.value = '0';
        resetMessages();
    }

    type.addEventListener('change', syncType);
    syncType();

    button.addEventListener('click', async () => {
        resetMessages();
        const selectedType = type.value;
        const priceIncreasePercent = Number(price.value);
        const body = {
            sourceStart: sourceStart.input.value,
            sourceEnd: sourceEnd.input.value,
            targetStart: targetStart.input.value,
            targetEnd: targetEnd.input.value,
            deleteExisting: deleteExisting.checked
        };
        const validationError = validatePullForward({ ...body, type: selectedType, priceIncreasePercent });
        if (validationError) {
            errors.show(validationError);
            return;
        }
        const action = body.deleteExisting
            ? `This will permanently delete all existing ${selectedType} dated ${body.targetStart} to ${body.targetEnd} before copying the new data. This cannot be undone.`
            : `Pull ${selectedType} forward.`;
        const gate = companyOperationGate(ctx.permissions, action);
        if (!gate.allowed) {
            errors.show(gate.message);
            return;
        }
        if (!window.confirm(gate.message)) return;
        if (selectedType === 'rates') body.priceIncreasePercent = priceIncreasePercent;
        button.disabled = true;
        button.textContent = 'Working…';
        try {
            const result = await request(`/api/admin/pull-forward/${selectedType}`, {
                method: 'POST',
                body: JSON.stringify(body)
            });
            errors.hide();
            successText.textContent = `Copied ${result.copied} ${selectedType}, deleted ${result.deleted}.`;
            success.hidden = false;
        } catch (error) {
            errors.show(error.message);
        } finally {
            button.disabled = false;
            button.replaceChildren(buttonIcon, document.createTextNode(' Pull Forward'));
        }
    });

    const form = document.createElement('div');
    form.className = 'pull-forward-form';
    const row = (...nodes) => {
        const line = document.createElement('div');
        line.className = 'form-row';
        line.append(...nodes);
        return line;
    };
    const actions = document.createElement('div');
    actions.className = 'pull-forward-actions';
    actions.append(button);
    form.append(
        row(typeWrap),
        row(sourceStart.wrap, sourceEnd.wrap),
        row(targetStart.wrap, targetEnd.wrap),
        row(priceWrap, deleteWrap),
        actions,
        errors.box,
        success
    );

    const panel = document.createElement('div');
    panel.className = 'pull-forward-panel';
    panel.append(
        heading('Pull Forward Data'),
        paragraph('pull-forward-subtitle', 'Copy a past range of rates or sailings into a future range.'),
        form
    );
    container.append(panel);
}

export function unmount() {}
