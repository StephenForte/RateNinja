const RESEND_URL = 'https://api.resend.com/emails';

function resendSettings() {
    const apiKey = process.env.RESEND_API_KEY || '';
    const from = process.env.RESEND_FROM || '';
    return {
        apiKey,
        from,
        configured: Boolean(apiKey && from)
    };
}

async function deliverWithResend({ to, subject, text }) {
    const { apiKey, from, configured } = resendSettings();
    if (!configured) return { sent: false };
    try {
        const response = await fetch(RESEND_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from,
                to: [to],
                subject,
                text
            })
        });
        if (!response.ok) return { sent: false };
        return { sent: true };
    } catch {
        return { sent: false };
    }
}

let delivery = deliverWithResend;

function setMailDelivery(next) {
    delivery = next || deliverWithResend;
}

async function sendEmail(message) {
    return delivery(message);
}

module.exports = {
    resendSettings,
    sendEmail,
    setMailDelivery
};
