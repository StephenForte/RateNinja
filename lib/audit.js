const crypto = require('node:crypto');
const { db } = require('./db');

const BLOCKED_DETAIL = /password|secret|token|code|verifier|authorization|cookie|pwd/i;

function sanitizeDetail(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const safe = {};
    for (const [key, value] of Object.entries(detail)) {
        if (BLOCKED_DETAIL.test(key)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
            safe[key] = value;
        }
    }
    return JSON.stringify(safe);
}

function recordAudit(eventType, fields = {}) {
    db.prepare(`
        INSERT INTO audit_events (id, event_type, actor_user_id, client_id, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        crypto.randomUUID(),
        eventType,
        fields.actorUserId || null,
        fields.clientId || null,
        sanitizeDetail(fields.detail),
        new Date().toISOString()
    );
}

// R1-23 port reference events (additive names only).
const EVENT_PORT_CREATED = 'port_created';
const EVENT_PORT_UPDATED = 'port_updated';
const EVENT_PORT_DELETED = 'port_deleted';

module.exports = {
    recordAudit,
    sanitizeDetail,
    EVENT_PORT_CREATED,
    EVENT_PORT_UPDATED,
    EVENT_PORT_DELETED
};
