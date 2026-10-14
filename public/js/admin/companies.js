import { request } from '../api.js';
import { errorBox, fieldLabel, heading, paragraph } from '../dom.js';

const TYPES = ['Contract Owner', 'Freight Forwarder/Customer'];

function textInput(id, type = 'text') {
    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.autocomplete = type === 'password' ? 'new-password' : 'off';
    return input;
}

export async function mount(container) {
    container.replaceChildren();
    const errors = errorBox();
    const warning = document.createElement('p');
    warning.id = 'onboardingNameWarning';
    warning.className = 'onboarding-warning';
    warning.hidden = true;

    const companyName = textInput('onboardingCompanyName');
    const displayName = textInput('onboardingAdminName');
    const email = textInput('onboardingAdminEmail', 'email');
    const loginName = textInput('onboardingAdminLogin');
    loginName.placeholder = 'Defaults to the email address';
    const temporaryPassword = textInput('onboardingAdminPassword', 'password');
    temporaryPassword.minLength = 12;

    email.addEventListener('change', () => {
        if (!loginName.value.trim()) loginName.value = email.value.trim();
    });

    const typeInputs = TYPES.map(type => {
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'onboardingCompanyType';
        input.value = type;
        input.id = `onboardingType-${type === TYPES[0] ? 'owner' : 'customer'}`;
        return input;
    });

    const details = document.createElement('div');
    details.append(fieldLabel('Company name', companyName));
    const typeStep = document.createElement('fieldset');
    typeStep.className = 'onboarding-types';
    const legend = document.createElement('legend');
    legend.textContent = 'Company type';
    typeStep.append(legend);
    typeInputs.forEach((input, index) => {
        typeStep.append(fieldLabel(TYPES[index], input));
    });
    const admin = document.createElement('div');
    admin.className = 'onboarding-fields';
    admin.append(
        fieldLabel('Display name', displayName),
        fieldLabel('Email', email),
        fieldLabel('Login name', loginName),
        fieldLabel('Temporary password', temporaryPassword)
    );
    const review = document.createElement('div');
    review.id = 'onboardingReview';
    const success = document.createElement('div');
    success.id = 'onboardingSuccess';
    success.className = 'onboarding-summary';
    success.hidden = true;

    const panels = [details, typeStep, admin, review];
    const stepNames = ['Company details', 'Company type', 'Initial administrator', 'Review'];
    let step = 0;
    let submissionId = '';

    const stepLabel = document.createElement('p');
    stepLabel.className = 'onboarding-step';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.textContent = 'Back';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'save-btn';
    next.textContent = 'Next';
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'save-btn';
    create.textContent = 'Create company';
    const actions = document.createElement('div');
    actions.className = 'onboarding-actions';
    actions.append(back, next, create);

    const wizard = document.createElement('form');
    wizard.id = 'companyWizard';
    wizard.className = 'onboarding-wizard';
    wizard.append(stepLabel, ...panels, warning, errors.box, actions);
    wizard.addEventListener('submit', event => event.preventDefault());

    container.append(
        heading('Companies'),
        paragraph('pull-forward-subtitle', 'Create a company and its first administrator. The temporary password is not emailed. Give it to them yourself. This does not change the company you currently have selected.'),
        wizard,
        success
    );

    function showError(error) {
        errors.show(error && error.message ? error.message : 'Could not create the company.');
    }

    function selectedType() {
        const chosen = typeInputs.find(input => input.checked);
        return chosen ? chosen.value : '';
    }

    function renderReview() {
        review.replaceChildren();
        const lines = [
            ['Company', companyName.value.trim()],
            ['Type', selectedType()],
            ['Administrator', displayName.value.trim()],
            ['Email', email.value.trim()],
            ['Login', loginName.value.trim() || email.value.trim()],
            ['Role', 'Company administrator'],
            ['Temporary password', 'Set. It will not be shown again after creation and will not be emailed.']
        ];
        const list = document.createElement('dl');
        list.className = 'account-details';
        for (const [label, value] of lines) {
            const term = document.createElement('dt');
            term.textContent = label;
            const definition = document.createElement('dd');
            definition.textContent = value;
            list.append(term, definition);
        }
        review.append(list);
    }

    function showStep() {
        panels.forEach((panel, index) => {
            panel.hidden = index !== step;
        });
        stepLabel.textContent = `Step ${step + 1} of ${panels.length}: ${stepNames[step]}`;
        back.hidden = step === 0;
        next.hidden = step === panels.length - 1;
        create.hidden = step !== panels.length - 1;
        success.hidden = true;
        wizard.hidden = false;
    }

    async function refreshNameWarning() {
        const q = companyName.value.trim();
        warning.hidden = true;
        warning.textContent = '';
        if (!q) return;
        const result = await request(`/api/admin/onboarding/name-check?q=${encodeURIComponent(q)}`);
        if (result.match && result.warning) {
            warning.textContent = result.warning;
            warning.hidden = false;
        }
    }

    companyName.addEventListener('change', () => {
        refreshNameWarning().catch(error => showError(error));
    });

    function validateStep() {
        errors.hide();
        if (step === 0 && !companyName.value.trim()) {
            errors.show('Enter a company name.');
            return false;
        }
        if (step === 1 && !selectedType()) {
            errors.show('Choose a company type.');
            return false;
        }
        if (step === 2) {
            if (!displayName.value.trim()) {
                errors.show('Enter a display name.');
                return false;
            }
            if (!email.value.trim()) {
                errors.show('Enter a valid email address.');
                return false;
            }
            if (!loginName.value.trim()) loginName.value = email.value.trim();
            if (temporaryPassword.value.length < 12) {
                errors.show('Password must be 12 to 200 characters.');
                return false;
            }
        }
        return true;
    }

    back.addEventListener('click', () => {
        errors.hide();
        if (step > 0) step -= 1;
        showStep();
    });

    next.addEventListener('click', async () => {
        if (!validateStep()) return;
        if (step === 0) {
            try {
                await refreshNameWarning();
            } catch (error) {
                showError(error);
                return;
            }
        }
        step += 1;
        if (step === panels.length - 1) renderReview();
        showStep();
    });

    create.addEventListener('click', async () => {
        errors.hide();
        renderReview();
        if (!submissionId) submissionId = crypto.randomUUID();
        const password = temporaryPassword.value;
        create.disabled = true;
        try {
            const result = await request('/api/admin/onboarding', {
                method: 'POST',
                body: JSON.stringify({
                    companyName: companyName.value.trim(),
                    companyType: selectedType(),
                    admin: {
                        displayName: displayName.value.trim(),
                        email: email.value.trim(),
                        loginName: loginName.value.trim(),
                        temporaryPassword: password
                    },
                    submissionId
                })
            });
            temporaryPassword.value = '';
            submissionId = '';
            wizard.hidden = true;
            success.hidden = false;
            success.replaceChildren();
            const title = document.createElement('h3');
            title.textContent = 'Company created';
            const summary = document.createElement('p');
            summary.textContent = result.summary || '';
            const handoff = document.createElement('p');
            handoff.textContent = result.handoff || '';
            const again = document.createElement('button');
            again.type = 'button';
            again.className = 'back-btn';
            again.textContent = 'Onboard another company';
            again.addEventListener('click', () => {
                companyName.value = '';
                displayName.value = '';
                email.value = '';
                loginName.value = '';
                temporaryPassword.value = '';
                typeInputs.forEach(input => {
                    input.checked = false;
                });
                warning.hidden = true;
                step = 0;
                showStep();
            });
            success.append(title, summary, handoff, again);
            if (success.textContent.includes(password)) {
                success.textContent = 'Company created. The temporary password was hidden.';
            }
        } catch (error) {
            showError(error);
            showStep();
        } finally {
            create.disabled = false;
        }
    });

    showStep();
}

export function unmount() {}
