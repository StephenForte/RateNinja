'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');
const { recordAudit } = require('./audit');
const { MAX_BOOKING_SLOTS } = require('./limits');
const permissions = require('./permissions');
const { customerPricedRate } = require('./visibility');

const NOT_FOUND = 'Not found.';
const OWNER_STATUSES = new Set(['pending', 'approved', 'declined']);
const SIZES = Object.freeze({
    '20D': 'rate20D',
    '40D': 'rate40D',
    '40HC': 'rate40HC'
});

class BookingError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function fail(status, message) {
    throw new BookingError(status, message);
}

function textOrNull(value) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text || text === 'N/A') return null;
    return text;
}

function expirationAllows(value) {
    const text = textOrNull(value);
    if (!text) return true;
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return false;
    }
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return date.getTime() >= todayUtc;
}

function rowById(id) {
    if (typeof id !== 'string' || !id) return null;
    return db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id) || null;
}

function sideOf(actor, row) {
    return permissions.bookingSide(actor, row);
}

function unreadFor(row, side) {
    if (side === 'owner' || side === 'both') return row.owner_read_at == null;
    return row.status !== 'pending' && row.customer_read_at == null;
}

function present(row, side) {
    const viewSide = side === 'both' ? 'owner' : side;
    const body = {
        id: row.id,
        rateId: row.rate_id,
        status: row.status,
        containerSize: row.container_size,
        slots: row.slots,
        customerPrice: row.customer_price,
        carrier: row.carrier,
        originPort: row.origin_port,
        destinationPort: row.destination_port,
        inlandDeliveryLocation: row.inland_delivery_location,
        commodityType: row.commodity_type,
        contractOwner: row.contract_owner,
        contractNumber: row.contract_number,
        ownerCompanyName: row.owner_company_name,
        rateEffectiveDate: row.rate_effective_date,
        rateExpirationDate: row.rate_expiration_date,
        notes: row.notes,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        side: viewSide,
        unread: unreadFor(row, side)
    };
    if (viewSide === 'owner') {
        body.requestedBy = {
            id: row.requesting_user_id,
            name: row.requesting_user_name || ''
        };
        if (row.decided_by_user_id) {
            body.decidedBy = {
                id: row.decided_by_user_id,
                name: row.decided_by_user_name || ''
            };
        }
    }
    return body;
}

function requireActor(actor) {
    if (!actor || actor.disabled) fail(401, 'Please sign in to continue.');
    return actor;
}

function visibleRow(actor, requestId) {
    const row = rowById(requestId);
    if (!row) fail(404, NOT_FOUND);
    const side = sideOf(actor, row);
    if (side === 'none') fail(404, NOT_FOUND);
    return { row, side };
}

function parseSlots(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BOOKING_SLOTS) {
        fail(400, `Slots must be a whole number from 1 to ${MAX_BOOKING_SLOTS}.`);
    }
    return value;
}

function parseSize(value) {
    if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SIZES, value)) {
        fail(400, 'Container size must be 20D, 40D, or 40HC.');
    }
    return value;
}

function createRequest(actor, body, context) {
    requireActor(actor);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Request body must be an object.');
    const slots = parseSlots(body.slots);
    const containerSize = parseSize(body.containerSize);
    if (!permissions.canRequestBooking(actor)) fail(403, 'You cannot request a booking.');
    const rateId = typeof body.rateId === 'string' ? body.rateId.trim() : '';
    if (!rateId) fail(400, 'A rate is required.');
    const priced = customerPricedRate(actor.company.id, rateId);
    if (!priced) fail(404, NOT_FOUND);
    if (!expirationAllows(priced.rateExpirationDate)) fail(400, 'This rate has expired.');
    const customerPrice = priced[SIZES[containerSize]];
    if (customerPrice == null) fail(400, 'That container size has no price.');
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const ownerCompanyId = priced.ownerCompanyId;
    if (!ownerCompanyId) fail(404, NOT_FOUND);
    db.prepare(`
        INSERT INTO booking_requests (
            id, rate_id, status, container_size, slots, customer_price,
            carrier, origin_port, destination_port, inland_delivery_location, commodity_type,
            contract_owner, contract_number, owner_company_name,
            rate_effective_date, rate_expiration_date, notes,
            requesting_user_id, requesting_user_name, requesting_company_id, owner_company_id,
            created_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        rateId,
        containerSize,
        slots,
        customerPrice,
        textOrNull(priced.carrier),
        textOrNull(priced.originPort),
        textOrNull(priced.destinationPort),
        textOrNull(priced.inlandDeliveryLocation),
        textOrNull(priced.commodityType),
        textOrNull(priced.contractOwner),
        textOrNull(priced.contractNumber),
        textOrNull(priced.ownerCompanyName),
        textOrNull(priced.rateEffectiveDate),
        textOrNull(priced.rateExpirationDate),
        textOrNull(priced.notes1),
        actor.id,
        actor.displayName || actor.username || '',
        actor.company.id,
        ownerCompanyId,
        createdAt
    );
    const audit = {
        actorUserId: actor.id,
        detail: {
            requestId: id,
            rateId,
            containerSize,
            slots,
            customerPrice,
            requestingCompanyId: actor.company.id,
            ownerCompanyId
        }
    };
    if (context && typeof context === 'object' && !Array.isArray(context)) {
        if (typeof context.clientId === 'string' && context.clientId) audit.clientId = context.clientId;
        if (context.channel === 'api' || context.channel === 'mcp') audit.detail.channel = context.channel;
    }
    recordAudit('booking_request_created', audit);
    return present(rowById(id), 'customer');
}

function listRequests(actor) {
    requireActor(actor);
    const companyId = actor.company?.id || '';
    if (!companyId) return [];
    const rows = db.prepare(`
        SELECT * FROM booking_requests
        WHERE owner_company_id = ? OR requesting_company_id = ?
        ORDER BY created_at DESC, id DESC
    `).all(companyId, companyId);
    return rows.map(row => present(row, sideOf(actor, row)));
}

function getRequest(actor, requestId) {
    requireActor(actor);
    const { row, side } = visibleRow(actor, requestId);
    return present(row, side);
}

function unreadCount(actor) {
    requireActor(actor);
    const companyId = actor.company?.id || '';
    if (!companyId) return 0;
    const owner = db.prepare(`
        SELECT COUNT(*) AS count FROM booking_requests
        WHERE owner_company_id = ? AND owner_read_at IS NULL
    `).get(companyId).count;
    const customer = db.prepare(`
        SELECT COUNT(*) AS count FROM booking_requests
        WHERE requesting_company_id = ?
          AND owner_company_id != requesting_company_id
          AND status != 'pending'
          AND customer_read_at IS NULL
    `).get(companyId).count;
    return Number(owner) + Number(customer);
}

function markRead(actor, requestId) {
    requireActor(actor);
    const { side } = visibleRow(actor, requestId);
    const now = new Date().toISOString();
    const companyId = actor.company.id;
    if (side === 'owner' || side === 'both') {
        db.prepare(`
            UPDATE booking_requests
            SET owner_read_at = ?
            WHERE id = ? AND owner_company_id = ?
        `).run(now, requestId, companyId);
    }
    if (side === 'customer' || side === 'both') {
        db.prepare(`
            UPDATE booking_requests
            SET customer_read_at = ?
            WHERE id = ? AND requesting_company_id = ?
        `).run(now, requestId, companyId);
    }
    return present(rowById(requestId), side);
}

function markSideRead(actor) {
    requireActor(actor);
    const companyId = actor.company?.id || '';
    if (!companyId) return { ok: true };
    const now = new Date().toISOString();
    db.prepare(`
        UPDATE booking_requests
        SET owner_read_at = ?
        WHERE owner_company_id = ? AND owner_read_at IS NULL
    `).run(now, companyId);
    db.prepare(`
        UPDATE booking_requests
        SET customer_read_at = ?
        WHERE requesting_company_id = ? AND customer_read_at IS NULL
    `).run(now, companyId);
    return { ok: true };
}

function listOwnerRequests(actor, query = {}) {
    requireActor(actor);
    const status = query.status;
    if (status !== undefined && !OWNER_STATUSES.has(status)) {
        fail(400, 'status must be pending, approved, or declined.');
    }
    const companyId = actor.company?.id || '';
    const page = query.page;
    const pageSize = query.pageSize;
    if (!companyId) return { requests: [], total: 0 };
    const filters = ['owner_company_id = ?'];
    const params = [companyId];
    if (status !== undefined) {
        filters.push('status = ?');
        params.push(status);
    }
    const where = filters.join(' AND ');
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM booking_requests WHERE ${where}`).get(...params).count);
    const rows = db.prepare(`
        SELECT * FROM booking_requests
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);
    return {
        requests: rows.map(row => present(row, 'owner')),
        total
    };
}

function listCustomerRequests(actor, query = {}) {
    requireActor(actor);
    const status = query.status;
    if (status !== undefined && !OWNER_STATUSES.has(status)) {
        fail(400, 'status must be pending, approved, or declined.');
    }
    const companyId = actor.company?.id || '';
    const page = query.page;
    const pageSize = query.pageSize;
    if (!companyId) return { requests: [], total: 0 };
    const filters = ['requesting_company_id = ?'];
    const params = [companyId];
    if (status !== undefined) {
        filters.push('status = ?');
        params.push(status);
    }
    const where = filters.join(' AND ');
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM booking_requests WHERE ${where}`).get(...params).count);
    const rows = db.prepare(`
        SELECT * FROM booking_requests
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);
    return {
        requests: rows.map(row => present(row, 'customer')),
        total
    };
}

function getCustomerRequest(actor, requestId) {
    requireActor(actor);
    const row = rowById(requestId);
    if (!row || row.requesting_company_id !== actor.company?.id) fail(404, NOT_FOUND);
    return present(row, 'customer');
}

function getOwnerRequest(actor, requestId) {
    requireActor(actor);
    const companyId = actor.company?.id || '';
    const row = rowById(requestId);
    if (!row || row.owner_company_id !== companyId) fail(404, NOT_FOUND);
    return present(row, 'owner');
}

// One map for the partner API and MCP. A customer-side 403 uses the same
// not_found body as a missing id so the caller cannot tell those rows apart.
function partnerBookingFailure(error) {
    if (!(error instanceof BookingError)) return null;
    const mapped = {
        400: { status: 400, error: 'invalid_request' },
        401: { status: 401, error: 'invalid_token', description: 'Access token is missing or invalid.' },
        403: { status: 404, error: 'not_found', description: NOT_FOUND },
        404: { status: 404, error: 'not_found', description: NOT_FOUND },
        409: { status: 409, error: 'already_decided' }
    }[error.status] || { status: 400, error: 'invalid_request' };
    return {
        status: mapped.status,
        body: {
            error: mapped.error,
            error_description: mapped.description || error.message
        }
    };
}

function decideRequest(actor, requestId, decision, context) {
    requireActor(actor);
    if (decision !== 'approved' && decision !== 'declined') {
        fail(400, 'Decision must be approved or declined.');
    }
    const row = rowById(requestId);
    if (!row) fail(404, NOT_FOUND);
    const side = sideOf(actor, row);
    if (side !== 'owner' && side !== 'both') {
        if (side === 'customer') fail(403, 'You cannot decide this booking request.');
        fail(404, NOT_FOUND);
    }
    if (!permissions.canDecideBooking(actor, row.owner_company_id)) {
        fail(403, 'You cannot decide this booking request.');
    }
    const now = new Date().toISOString();
    const name = actor.displayName || actor.username || '';
    // One conditional write. A second decision updates zero rows and becomes 409.
    const result = db.prepare(`
        UPDATE booking_requests
        SET status = ?, decided_at = ?, decided_by_user_id = ?, decided_by_user_name = ?, customer_read_at = NULL
        WHERE id = ? AND owner_company_id = ? AND status = 'pending'
    `).run(decision, now, actor.id, name, requestId, actor.company.id);
    if (Number(result.changes) !== 1) {
        const current = db.prepare(`
            SELECT status FROM booking_requests WHERE id = ? AND owner_company_id = ?
        `).get(requestId, actor.company.id);
        if (current && current.status !== 'pending') {
            fail(409, 'This booking request has already been decided.');
        }
        fail(404, NOT_FOUND);
    }
    const detail = {
        requestId,
        status: decision,
        ownerCompanyId: actor.company.id
    };
    const audit = { actorUserId: actor.id, detail };
    if (context && typeof context === 'object' && !Array.isArray(context)) {
        if (typeof context.clientId === 'string' && context.clientId) audit.clientId = context.clientId;
        if (context.channel === 'api' || context.channel === 'mcp') detail.channel = context.channel;
    }
    recordAudit('booking_request_decided', audit);
    return present(rowById(requestId), 'owner');
}

module.exports = {
    NOT_FOUND,
    expirationAllows,
    listCustomerRequests,
    getCustomerRequest,
    BookingError,
    createRequest,
    listRequests,
    getRequest,
    unreadCount,
    markRead,
    markSideRead,
    listOwnerRequests,
    getOwnerRequest,
    partnerBookingFailure,
    decideRequest
};
