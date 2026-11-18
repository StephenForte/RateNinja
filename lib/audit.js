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

// R1-24 reference lookup reads (additive names only).
const EVENT_PARTNER_RATE_DATE_RANGES_READ = 'partner_rate_date_ranges_read';
const EVENT_PARTNER_ORIGIN_PORTS_READ = 'partner_origin_ports_read';
const EVENT_PARTNER_DESTINATION_PORTS_READ = 'partner_destination_ports_read';
const EVENT_PARTNER_CONTRACT_OWNERS_READ = 'partner_contract_owners_read';
const EVENT_PARTNER_SAILING_DATE_RANGES_READ = 'partner_sailing_date_ranges_read';
const EVENT_PARTNER_PREDICTIVE_DATE_RANGES_READ = 'partner_predictive_date_ranges_read';

// R1-25 admin reference reads (additive names only).
const EVENT_ADMIN_REFERENCE_RATE_DATE_RANGES_READ = 'admin_reference_rate_date_ranges_read';
const EVENT_ADMIN_REFERENCE_ORIGIN_PORTS_READ = 'admin_reference_origin_ports_read';
const EVENT_ADMIN_REFERENCE_DESTINATION_PORTS_READ = 'admin_reference_destination_ports_read';
const EVENT_ADMIN_REFERENCE_CONTRACT_OWNERS_READ = 'admin_reference_contract_owners_read';
const EVENT_ADMIN_REFERENCE_SAILING_DATE_RANGES_READ = 'admin_reference_sailing_date_ranges_read';
const EVENT_ADMIN_REFERENCE_PREDICTIVE_DATE_RANGES_READ = 'admin_reference_predictive_date_ranges_read';
const EVENT_ADMIN_REFERENCE_COMPANIES_READ = 'admin_reference_companies_read';

const EVENT_BUYER_API_KEY_CREATED = 'buyer_api_key_created';
const EVENT_BUYER_API_KEY_REVOKED = 'buyer_api_key_revoked';
const EVENT_MANAGED_AGENT_CREATED = 'managed_agent_created';
const EVENT_MANAGED_AGENT_UPDATED = 'managed_agent_updated';
const EVENT_MANAGED_AGENT_DELETED = 'managed_agent_deleted';
const EVENT_MANAGED_AGENT_STARTED = 'managed_agent_started';
const EVENT_MANAGED_AGENT_FINISHED = 'managed_agent_finished';

const EVENT_ADMIN_MANAGED_AGENTS_READ = 'admin_managed_agents_read';

module.exports = {
    EVENT_ADMIN_MANAGED_AGENTS_READ,
    EVENT_BUYER_API_KEY_CREATED,
    EVENT_BUYER_API_KEY_REVOKED,
    EVENT_MANAGED_AGENT_CREATED,
    EVENT_MANAGED_AGENT_UPDATED,
    EVENT_MANAGED_AGENT_DELETED,
    EVENT_MANAGED_AGENT_STARTED,
    EVENT_MANAGED_AGENT_FINISHED,
    recordAudit,
    sanitizeDetail,
    EVENT_PORT_CREATED,
    EVENT_PORT_UPDATED,
    EVENT_PORT_DELETED,
    EVENT_PARTNER_RATE_DATE_RANGES_READ,
    EVENT_PARTNER_ORIGIN_PORTS_READ,
    EVENT_PARTNER_DESTINATION_PORTS_READ,
    EVENT_PARTNER_CONTRACT_OWNERS_READ,
    EVENT_PARTNER_SAILING_DATE_RANGES_READ,
    EVENT_PARTNER_PREDICTIVE_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_RATE_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_ORIGIN_PORTS_READ,
    EVENT_ADMIN_REFERENCE_DESTINATION_PORTS_READ,
    EVENT_ADMIN_REFERENCE_CONTRACT_OWNERS_READ,
    EVENT_ADMIN_REFERENCE_SAILING_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_PREDICTIVE_DATE_RANGES_READ,
    EVENT_ADMIN_REFERENCE_COMPANIES_READ
};
