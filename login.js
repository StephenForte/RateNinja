let challenge = '';

const loginForm = document.getElementById('loginForm');
const mfaForm = document.getElementById('mfaForm');
const forgotForm = document.getElementById('forgotForm');
const resetForm = document.getElementById('resetForm');
const errorBox = document.getElementById('loginError');
const errorMessage = document.getElementById('loginErrorMessage');
const noticeBox = document.getElementById('loginNotice');
const noticeMessage = document.getElementById('loginNoticeMessage');

function safeOauthNext(value) {
    if (typeof value !== 'string' || !value.startsWith('/oauth/authorize?')) return null;
    if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return null;
    try {
        const url = new URL(value, 'http://localhost');
        if (url.origin !== 'http://localhost' || url.pathname !== '/oauth/authorize') return null;
        return `${url.pathname}${url.search}`;
    } catch {
        return null;
    }
}

function nextTarget() {
    return safeOauthNext(new URLSearchParams(location.search).get('next')) || '/';
}

function showError(message) {
    noticeBox.hidden = true;
    errorMessage.textContent = message;
    errorBox.hidden = false;
}

function showNotice(message) {
    errorBox.hidden = true;
    noticeMessage.textContent = message;
    noticeBox.hidden = false;
}

function showPanel(panel) {
    errorBox.hidden = true;
    for (const form of [loginForm, mfaForm, forgotForm, resetForm]) form.hidden = form !== panel;
}

async function postJson(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(loginForm);
    try {
        const payload = await postJson('/api/auth/login', {
            username: form.get('username'),
            password: form.get('password')
        });
        if (payload.mfaRequired) {
            challenge = payload.challenge;
            showPanel(mfaForm);
            document.getElementById('mfaCode').focus();
            return;
        }
        location.replace(nextTarget());
    } catch (error) {
        showError(error.message);
    }
});

mfaForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        await postJson('/api/auth/login/mfa', {
            challenge,
            code: document.getElementById('mfaCode').value
        });
        location.replace(nextTarget());
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('mfaBack').addEventListener('click', () => {
    challenge = '';
    showPanel(loginForm);
});

document.getElementById('showForgot').addEventListener('click', () => showPanel(forgotForm));
document.getElementById('forgotBack').addEventListener('click', () => showPanel(loginForm));

forgotForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
        const payload = await postJson('/api/auth/forgot-password', {
            username: new FormData(forgotForm).get('username')
        });
        showPanel(loginForm);
        showNotice(payload.message || 'If that account can receive mail, a reset link is on its way.');
    } catch (error) {
        showError(error.message);
    }
});

resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('newPassword').value;
    if (password !== document.getElementById('confirmPassword').value) {
        showError('Passwords do not match.');
        return;
    }
    try {
        await postJson('/api/auth/reset-password', {
            token: new URLSearchParams(location.search).get('reset'),
            password
        });
        const url = new URL(location.href);
        url.searchParams.delete('reset');
        history.replaceState({}, '', `${url.pathname}${url.search}`);
        showPanel(loginForm);
        showNotice('Password updated. Sign in with the new password.');
    } catch (error) {
        showError(error.message);
    }
});

async function start() {
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) {
        showPanel(resetForm);
        return;
    }
    try {
        const response = await fetch('/api/session');
        if (response.ok) location.replace(nextTarget());
    } catch {
        // Stay on the sign-in form.
    }
}

start();
