'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction } = require('./db');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { isCompanyAdmin } = require('./permissions');
const {
    recordAudit, EVENT_SWARM_CREATED, EVENT_SWARM_UPDATED, EVENT_SWARM_DELETED
} = require('./audit');
const { ManagedAgentError, searchOptions, validate } = require('./managed-agents');

const MAX_LANES = 25;
const MAX_NAME = 100;
const MAX_INSTRUCTIONS = 20000;
const MAX_TOTAL_SLOTS = 10000;
const PRIORITIES = ['high', 'normal', 'low'];

function companyTypeOf(company) {
    return company?.fields?.CompanyType || '';
}

class SwarmError extends Error {
    constructor(status, message, code, position) {
        super(message);
        this.status = status;
        this.code = code;
        this.position = position;
    }
}

function isCustomer(actor) {
    return Boolean(actor?.company?.id) && companyTypeOf(actor.company) === COMPANY_TYPE_CUSTOMER;
}

function requireEnabled(actor) {
    if (!isCustomer(actor)) {
        throw new SwarmError(403, 'Managed Agent Swarm is not enabled for your company.', 'swarm_not_enabled');
    }
    const row = db.prepare('SELECT enabled FROM company_swarm_settings WHERE company_id = ?').get(actor.company.id);
    if (!row || row.enabled !== 1) {
        throw new SwarmError(403, 'Managed Agent Swarm is not enabled for your company.', 'swarm_not_enabled');
    }
}

function access(actor) {
    if (!isCustomer(actor)) return { enabled: false };
    const row = db.prepare('SELECT enabled FROM company_swarm_settings WHERE company_id = ?').get(actor.company.id);
    return { enabled: row?.enabled === 1 };
}

function laneError(position, message) {
    throw new SwarmError(400, `Row ${position}: ${message}`, null, position);
}

function parseLane(input, options, position) {
    if (input && typeof input === 'object' && !Array.isArray(input)
        && Object.prototype.hasOwnProperty.call(input, 'savedQueryId') && input.savedQueryId != null) {
        laneError(position, 'A swarm lane does not take a saved query.');
    }
    let lane;
    try {
        lane = validate(input, options, position);
    } catch (error) {
        if (error instanceof ManagedAgentError) {
            throw new SwarmError(error.status, error.message, null, position);
        }
        throw error;
    }
    const priority = input.priority === undefined ? 'normal' : input.priority;
    if (!PRIORITIES.includes(priority)) laneError(position, 'Select a priority of high, normal or low.');
    const dateFlexDays = input.dateFlexDays === undefined ? 0 : input.dateFlexDays;
    if (!Number.isInteger(dateFlexDays) || dateFlexDays < 0 || dateFlexDays > 14) {
        laneError(position, 'Enter a whole number of flex days from 0 to 14.');
    }
    return { ...lane, priority, dateFlexDays };
}

function optional(body, key) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return null;
    return body[key];
}

function parseSpend(value, booking) {
    if (value === null) {
        if (booking) throw new SwarmError(400, 'Enter a total spend cap greater than 0 when a lane allows booking.');
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new SwarmError(400, 'Enter a total spend cap greater than 0, or null when no lane allows booking.');
    }
    return value;
}

function parseSlots(value, booking) {
    if (value === null) {
        if (booking) throw new SwarmError(400, 'Enter a total slots cap from 1 to 10000 when a lane allows booking.');
        return null;
    }
    if (!Number.isInteger(value) || value < 1 || value > MAX_TOTAL_SLOTS) {
        throw new SwarmError(400, 'Enter a total slots cap from 1 to 10000, or null when no lane allows booking.');
    }
    return value;
}

function parseBody(actor, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new SwarmError(400, 'Send a swarm as a JSON object.');
    }
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > MAX_NAME) {
        throw new SwarmError(400, 'Enter a swarm name from 1 to 100 characters.');
    }
    if (typeof body.instructions !== 'string' || body.instructions.length > MAX_INSTRUCTIONS) {
        throw new SwarmError(400, 'Enter instructions as text of at most 20000 characters.');
    }
    if (!Array.isArray(body.lanes) || body.lanes.length < 1 || body.lanes.length > MAX_LANES) {
        throw new SwarmError(400, 'Submit 1 to 25 lanes.');
    }
    const options = searchOptions(actor);
    const lanes = body.lanes.map((lane, index) => parseLane(lane, options, index + 1));
    const booking = lanes.some(lane => lane.allowBookingRequest);
    return {
        name: body.name.trim(),
        instructions: body.instructions,
        totalSpendCap: parseSpend(optional(body, 'totalSpendCap'), booking),
        totalSlotsCap: parseSlots(optional(body, 'totalSlotsCap'), booking),
        lanes
    };
}

function presentLane(row) {
    return {
        id: row.id,
        position: row.position,
        rateType: row.rate_type,
        originPort: row.origin_port,
        destinationPort: row.destination_port,
        sailingDate: row.sailing_date,
        containerType: row.container_type,
        allowAlternativeRoutes: row.allow_alternative_routes === 1,
        allowBookingRequest: row.allow_booking_request === 1,
        priceMin: row.price_min,
        priceMax: row.price_max,
        bookingSlots: row.booking_slots,
        acceptMaxSlots: row.accept_max_slots === 1,
        priority: row.priority,
        dateFlexDays: row.date_flex_days
    };
}

function canEdit(actor, row) {
    return actor.id === row.created_by_user_id || isCompanyAdmin(actor);
}

function present(actor, id) {
    const row = db.prepare('SELECT * FROM swarms WHERE id = ? AND company_id = ?').get(id, actor.company.id);
    if (!row) throw new SwarmError(404, 'Swarm not found.');
    const lanes = db.prepare(`
        SELECT * FROM swarm_lanes WHERE swarm_id = ? ORDER BY position ASC, id ASC
    `).all(id);
    return {
        id: row.id,
        companyId: row.company_id,
        createdByUserId: row.created_by_user_id,
        name: row.name,
        instructions: row.instructions,
        totalSpendCap: row.total_spend_cap,
        totalSlotsCap: row.total_slots_cap,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canEdit: canEdit(actor, row),
        lanes: lanes.map(presentLane)
    };
}

function requireSwarm(actor, id) {
    const row = db.prepare('SELECT * FROM swarms WHERE id = ? AND company_id = ?').get(id, actor.company.id);
    if (!row) throw new SwarmError(404, 'Swarm not found.');
    return row;
}

function requireEditor(actor, row) {
    if (!canEdit(actor, row)) {
        throw new SwarmError(403, 'You do not have permission to change this swarm.');
    }
}

function requireNoActiveRun(id) {
    if (db.prepare("SELECT 1 FROM swarm_runs WHERE swarm_id = ? AND status = 'running'").get(id)) {
        throw new SwarmError(409, 'This swarm has an active run.', 'run_active');
    }
}

function insertLanes(swarmId, lanes) {
    const insert = db.prepare(`
        INSERT INTO swarm_lanes (
            id, swarm_id, position, rate_type, origin_port, destination_port, sailing_date,
            container_type, allow_alternative_routes, allow_booking_request, price_min, price_max,
            booking_slots, accept_max_slots, priority, date_flex_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return lanes.map((lane, index) => {
        const id = randomUUID();
        insert.run(
            id, swarmId, index + 1, lane.rateType, lane.originPort, lane.destinationPort, lane.sailingDate,
            lane.containerType, Number(lane.allowAlternativeRoutes), Number(lane.allowBookingRequest),
            lane.priceMin, lane.priceMax, lane.bookingSlots, Number(lane.acceptMaxSlots),
            lane.priority, lane.dateFlexDays
        );
        return id;
    });
}

function list(actor) {
    requireEnabled(actor);
    return db.prepare(`
        SELECT id FROM swarms WHERE company_id = ? ORDER BY created_at DESC, id DESC
    `).all(actor.company.id).map(row => present(actor, row.id));
}

function get(actor, id) {
    requireEnabled(actor);
    requireSwarm(actor, id);
    return present(actor, id);
}

function create(actor, body) {
    requireEnabled(actor);
    return transaction(() => {
        const parsed = parseBody(actor, body);
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO swarms (
                id, company_id, created_by_user_id, name, instructions,
                total_spend_cap, total_slots_cap, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, actor.company.id, actor.id, parsed.name, parsed.instructions,
            parsed.totalSpendCap, parsed.totalSlotsCap, now, now
        );
        const laneIds = insertLanes(id, parsed.lanes);
        recordAudit(EVENT_SWARM_CREATED, {
            actorUserId: actor.id,
            detail: { swarmId: id, companyId: actor.company.id, laneIds: laneIds.join(',') }
        });
        return present(actor, id);
    });
}

function update(actor, id, body) {
    requireEnabled(actor);
    return transaction(() => {
        const existing = requireSwarm(actor, id);
        requireEditor(actor, existing);
        requireNoActiveRun(id);
        const parsed = parseBody(actor, body);
        db.prepare(`
            UPDATE swarms SET
                name = ?, instructions = ?, total_spend_cap = ?, total_slots_cap = ?, updated_at = ?
            WHERE id = ? AND company_id = ?
        `).run(
            parsed.name, parsed.instructions, parsed.totalSpendCap, parsed.totalSlotsCap,
            new Date().toISOString(), id, actor.company.id
        );
        db.prepare('DELETE FROM swarm_lanes WHERE swarm_id = ?').run(id);
        const laneIds = insertLanes(id, parsed.lanes);
        recordAudit(EVENT_SWARM_UPDATED, {
            actorUserId: actor.id,
            detail: { swarmId: id, companyId: actor.company.id, laneIds: laneIds.join(',') }
        });
        return present(actor, id);
    });
}

function remove(actor, id) {
    requireEnabled(actor);
    transaction(() => {
        const existing = requireSwarm(actor, id);
        requireEditor(actor, existing);
        requireNoActiveRun(id);
        db.prepare('DELETE FROM swarm_lanes WHERE swarm_id = ?').run(id);
        const result = db.prepare('DELETE FROM swarms WHERE id = ? AND company_id = ?').run(id, actor.company.id);
        if (!result.changes) throw new SwarmError(404, 'Swarm not found.');
        recordAudit(EVENT_SWARM_DELETED, {
            actorUserId: actor.id,
            detail: { swarmId: id, companyId: actor.company.id }
        });
    });
}

module.exports = {
    SwarmError,
    access,
    list,
    get,
    create,
    update,
    remove
};
