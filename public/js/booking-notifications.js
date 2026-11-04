import { request } from './api.js';

const POLL_MS = 60_000;

let timer = null;
let stopped = true;

function bell() {
    return document.getElementById('bookingBell');
}

function paint(count) {
    const link = bell();
    const badge = document.getElementById('bookingBellCount');
    if (!link || !badge) return;
    if (count == null) {
        link.hidden = true;
        return;
    }
    const value = Number(count) || 0;
    link.hidden = false;
    badge.textContent = String(value);
    link.setAttribute('aria-label', value === 1 ? '1 unread booking request' : `${value} unread booking requests`);
}

export function stopBookingNotifications() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    paint(null);
}

export async function refreshBookingNotifications() {
    if (stopped) return;
    try {
        const payload = await request('/api/booking-requests/unread', { allowUnauthenticated: true });
        if (stopped) return;
        paint(payload.unread);
    } catch (error) {
        if (error.status === 401 || error.status === 403) stopBookingNotifications();
    }
}

export function startBookingNotifications() {
    stopBookingNotifications();
    stopped = false;
    refreshBookingNotifications();
    timer = setInterval(() => {
        refreshBookingNotifications();
    }, POLL_MS);
}
