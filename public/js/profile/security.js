import { clearCsrf, request, showLoginPage } from '../api.js';
import { errorBox, fieldLabel, heading, paragraph } from '../dom.js';

export async function mount(container, ctx) {
    container.replaceChildren();
    const status = paragraph('pull-forward-subtitle', '');
    const errors = errorBox();
    const enroll = document.createElement('div');
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'save-btn';
    start.textContent = 'Set up authenticator';
    const setup = document.createElement('div');
    setup.hidden = true;
    const secret = document.createElement('code');
    const secretLine = document.createElement('p');
    secretLine.append(secret);
    const confirmForm = document.createElement('form');
    confirmForm.className = 'admin-form';
    const code = document.createElement('input');
    code.inputMode = 'numeric';
    code.autocomplete = 'one-time-code';
    code.required = true;
    const confirmButton = document.createElement('button');
    confirmButton.className = 'save-btn';
    confirmButton.type = 'submit';
    confirmButton.textContent = 'Confirm and turn on';
    confirmForm.append(fieldLabel('Authenticator code ', code), confirmButton);
    setup.append(
        paragraph('pull-forward-subtitle', 'Add this secret to an authenticator app. Two-factor stays off until you confirm a current code.'),
        secretLine,
        confirmForm
    );
    enroll.append(start, setup);

    const recovery = document.createElement('div');
    recovery.hidden = true;
    const recoveryList = document.createElement('ul');
    recovery.append(
        paragraph('pull-forward-subtitle', 'Save these recovery codes now. Each code works once, and they will not be shown again.'),
        recoveryList
    );

    const disableForm = document.createElement('form');
    disableForm.className = 'admin-form';
    disableForm.hidden = true;
    const password = document.createElement('input');
    password.type = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    const disableCode = document.createElement('input');
    disableCode.autocomplete = 'one-time-code';
    disableCode.required = true;
    const disableButton = document.createElement('button');
    disableButton.className = 'save-btn';
    disableButton.type = 'submit';
    disableButton.textContent = 'Turn off two-factor';
    disableForm.append(
        paragraph('pull-forward-subtitle', 'Turn off two-factor with your password and a current authenticator or recovery code. This signs you out.'),
        fieldLabel('Password ', password),
        fieldLabel('Code ', disableCode),
        disableButton
    );

    container.append(heading('Security'), status, enroll, recovery, disableForm, errors.box);

    start.addEventListener('click', async () => {
        errors.hide();
        try {
            const result = await request('/api/account/2fa/start', { method: 'POST', body: JSON.stringify({}) });
            secret.textContent = result.secret;
            setup.hidden = false;
        } catch (error) {
            errors.show(error.message);
        }
    });

    confirmForm.addEventListener('submit', async event => {
        event.preventDefault();
        errors.hide();
        try {
            const result = await request('/api/account/2fa/confirm', {
                method: 'POST',
                body: JSON.stringify({ code: code.value })
            });
            enroll.hidden = true;
            setup.hidden = true;
            recovery.hidden = false;
            disableForm.hidden = false;
            status.textContent = 'Two-factor authentication is on. The next sign-in will ask for a code.';
            recoveryList.replaceChildren();
            for (const recoveryCode of result.recoveryCodes || []) {
                const item = document.createElement('li');
                item.textContent = recoveryCode;
                recoveryList.append(item);
            }
        } catch (error) {
            errors.show(error.message);
        }
    });

    disableForm.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const result = await request('/api/account/2fa/disable', {
                method: 'POST',
                body: JSON.stringify({
                    password: password.value,
                    code: disableCode.value
                })
            });
            if (result.signedOut) {
                clearCsrf();
                ctx.onSignedOut();
                showLoginPage();
            }
        } catch (error) {
            errors.show(error.message);
        }
    });

    try {
        const result = await request('/api/account/security');
        const enabled = Boolean(result.enabled);
        status.textContent = enabled
            ? 'Two-factor authentication is on. Sign-in asks for a code from your authenticator app or a recovery code.'
            : 'Two-factor authentication is off. You can keep signing in with your password until you choose to enroll.';
        enroll.hidden = enabled;
        disableForm.hidden = !enabled;
    } catch (error) {
        errors.show(error.message);
    }
}

export function unmount() {}
