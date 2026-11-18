'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction } = require('./db');
const { appRates, appSailings, customerPricedRate } = require('./visibility');
const { listQueries } = require('./preferences');
const { loadActor, canRequestBooking, isCompanyAdmin, isSystemAdmin } = require('./permissions');
const { getCompanyByRecordId } = require('./store');
const { MAX_AGENT_SEARCHES, MAX_BOOKING_SLOTS } = require('./limits');
const {
    recordAudit, EVENT_MANAGED_AGENT_CREATED, EVENT_MANAGED_AGENT_UPDATED, EVENT_MANAGED_AGENT_DELETED,
    EVENT_MANAGED_AGENT_STARTED, EVENT_MANAGED_AGENT_FINISHED
} = require('./audit');

const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { createRequest, expirationAllows } = require('./booking-requests');
const { filterSailingsForLane } = require('./client-agent');

const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const CONTAINER_TYPES = ['20D', '40D', '40HC'];
const AGENT_FIELDS = [
    'rateType', 'originPort', 'destinationPort', 'sailingDate', 'savedQueryId',
    'containerType', 'allowAlternativeRoutes', 'allowBookingRequest', 'priceMin', 'priceMax', 'bookingSlots'
];

class ManagedAgentError extends Error {
    constructor(status, message, row) {
        super(row ? `Row ${row}: ${message}` : message);
        this.status = status;
    }
}

function hasCompany(actor) {
    return Boolean(actor?.company?.id);
}

function requireCompany(actor) {
    if (!hasCompany(actor)) throw new ManagedAgentError(403, 'Your account must belong to a company to manage agents.');
}

function calendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function rateDate(value) {
    // Imported rate dates may carry an ISO time suffix. Lane windows use calendar days.
    if (typeof value !== 'string') return '';
    const day = value.slice(0, 10);
    return calendarDate(day) && (value === day || (value[10] === 'T' && Number.isFinite(Date.parse(value)))) ? day : '';
}

function laneKey(rateType, originPort, destinationPort) {
    return JSON.stringify([rateType, originPort, destinationPort]);
}

function searchOptions(actor, company = actor.company) {
    const rateTypes = new Set();
    const lanes = new Map();
    if (company?.id) {
        const rates = appRates({
            companyType: company.fields.CompanyType,
            companyRecordId: company.id,
            companyName: company.fields.CompanyName
        });
        for (const rate of rates) {
            const { rateType, originPort, destinationPort } = rate;
            if (typeof rateType !== 'string' || !rateType.trim() || rateType === 'N/A') continue;
            rateTypes.add(rateType);
            if (![originPort, destinationPort].every(port => typeof port === 'string' && port.trim() && port !== 'N/A')) continue;

            const key = laneKey(rateType, originPort, destinationPort);
            if (!lanes.has(key)) lanes.set(key, { rateType, originPort, destinationPort, windows: [] });
            const start = rateDate(rate.rateEffectiveDate);
            const end = rateDate(rate.rateExpirationDate);
            if (start && end && start <= end) lanes.get(key).windows.push({ start, end });
        }
    }
    for (const lane of lanes.values()) {
        const unique = new Map(lane.windows.map(window => [`${window.start}/${window.end}`, window]));
        lane.windows = [...unique.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    }
    return {
        rateTypes: [...rateTypes].sort((a, b) => a.localeCompare(b)),
        lanes,
        savedQueries: listQueries(actor.id).map(({ id, name, criteria }) => ({
            id, name, originPort: criteria.originPort, destinationPort: criteria.destinationPort
        })),
        today: new Date().toISOString().slice(0, 10),
        canRequestBooking: canRequestBooking({ ...actor, company })
    };
}

function editSearchOptions(actor, agent) {
    const company = getCompanyByRecordId(agent.company_id);
    if (!company) throw new ManagedAgentError(409, 'The agent’s company no longer exists.');
    return searchOptions(actor, company);
}

function getOptions(actor, agentId = null) {
    const search = agentId === null
        ? searchOptions(actor)
        : editSearchOptions(actor, requireQueuedAgent(actor, agentId));
    const { lanes, ...options } = search;
    return {
        ...options,
        lanes: [...lanes.values()],
        containerTypes: CONTAINER_TYPES,
        maxSearches: MAX_AGENT_SEARCHES,
        maxBookingSlots: MAX_BOOKING_SLOTS,
        canManageAgents: hasCompany(actor)
    };
}

function validate(input, options, row, currentSavedQueryId = null) {
    const invalid = message => { throw new ManagedAgentError(400, message, row); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Enter a search and its settings.');
    const values = Object.fromEntries(AGENT_FIELDS.map(field => [field, input[field]]));
    const {
        rateType, originPort, destinationPort, sailingDate, savedQueryId, containerType,
        allowAlternativeRoutes, allowBookingRequest, priceMin, priceMax, bookingSlots
    } = values;

    const laneFields = [rateType, originPort, destinationPort];
    const lane = laneFields.every(field => typeof field === 'string') && options.lanes.get(laneKey(...laneFields));
    if (!lane) invalid('Select a visible lane for this rate type.');
    if (!calendarDate(sailingDate) || sailingDate < options.today) {
        invalid('Enter a sailing date on or after today (UTC).');
    }
    if (!lane.windows.some(({ start, end }) => start <= sailingDate && sailingDate <= end)) {
        invalid('Choose a sailing date in a rate window for this lane.');
    }
    if (savedQueryId != null && savedQueryId !== currentSavedQueryId && !options.savedQueries.some(query => query.id === savedQueryId)) {
        invalid('Select a saved query from your account.');
    }
    if (!CONTAINER_TYPES.includes(containerType)) invalid('Select 20D, 40D or 40HC as the container type.');
    if (typeof allowAlternativeRoutes !== 'boolean' || typeof allowBookingRequest !== 'boolean') {
        invalid('Provide both agent permissions as true or false.');
    }
    if (allowBookingRequest) {
        if (!options.canRequestBooking) invalid('Your company cannot request bookings.');
        if (![priceMin, priceMax].every(price => Number.isFinite(price) && price >= 0) || priceMin > priceMax) {
            invalid('Enter nonnegative minimum and maximum prices with minimum at or below maximum.');
        }
        if (!Number.isInteger(bookingSlots) || bookingSlots < 1 || bookingSlots > MAX_BOOKING_SLOTS) {
            invalid(`Enter a whole number of slots from 1 to ${MAX_BOOKING_SLOTS}.`);
        }
    }
    return {
        ...values,
        savedQueryId: savedQueryId ?? null,
        priceMin: allowBookingRequest ? priceMin : null,
        priceMax: allowBookingRequest ? priceMax : null,
        bookingSlots: allowBookingRequest ? bookingSlots : null
    };
}

function mayChange(actor, agent) {
    return hasCompany(actor) && (isSystemAdmin(actor) || (
        actor.company.id === agent.company_id && (actor.id === agent.created_by_user_id || isCompanyAdmin(actor))
    ));
}

function present(agent, { showCompany, canEdit }) {
    return {
        id: agent.id,
        batchId: agent.batch_id,
        companyId: agent.company_id,
        ...(showCompany ? { companyName: agent.company_name || '' } : {}),
        createdByUserId: agent.created_by_user_id,
        creatorName: agent.creator_name || '',
        status: agent.status,
        rateType: agent.rate_type,
        originPort: agent.origin_port,
        destinationPort: agent.destination_port,
        sailingDate: agent.sailing_date,
        savedQueryId: agent.saved_query_id,
        containerType: agent.container_type,
        allowAlternativeRoutes: Boolean(agent.allow_alternative_routes),
        allowBookingRequest: Boolean(agent.allow_booking_request),
        priceMin: agent.price_min,
        priceMax: agent.price_max,
        bookingSlots: agent.booking_slots,
        createdAt: agent.created_at,
        updatedAt: agent.updated_at,
        startedAt: agent.started_at,
        finishedAt: agent.finished_at,
        resultSummary: agent.result_summary,
        bookingRequestId: agent.booking_request_id,
        canEdit,
        canDelete: canEdit
    };
}

function presentForSession(actor, agent) {
    return present(agent, {
        showCompany: isSystemAdmin(actor),
        canEdit: agent.status === 'queued' && mayChange(actor, agent)
    });
}

const SELECT_AGENTS = `
    SELECT a.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS creator_name,
        c.company_name, COALESCE(NULLIF(ct.name, ''), c.company_type) AS company_type
    FROM managed_agents a LEFT JOIN users u ON u.id = a.created_by_user_id
    LEFT JOIN companies c ON c.id = a.company_id
    LEFT JOIN company_types ct ON ct.id = c.company_type_id
`;

function list(actor) {
    if (!hasCompany(actor)) return [];
    const order = ' ORDER BY a.created_at DESC, a.rowid DESC';
    const rows = isSystemAdmin(actor)
        ? db.prepare(SELECT_AGENTS + order).all()
        : db.prepare(SELECT_AGENTS + ' WHERE a.company_id = ?' + order).all(actor.company.id);
    return rows.map(agent => presentForSession(actor, agent));
}

function getAgent(id) {
    return db.prepare(SELECT_AGENTS + ' WHERE a.id = ?').get(id);
}

function requireQueuedAgent(actor, id) {
    requireCompany(actor);
    const agent = getAgent(id);
    if (!agent || (!isSystemAdmin(actor) && agent.company_id !== actor.company.id)) {
        throw new ManagedAgentError(404, 'Managed agent not found.');
    }
    if (!mayChange(actor, agent)) throw new ManagedAgentError(403, 'You do not have permission to change this agent.');
    if (agent.status !== 'queued') throw new ManagedAgentError(409, 'Only queued agents can be changed.');
    return agent;
}

function bindings(agent) {
    return AGENT_FIELDS.map(field => typeof agent[field] === 'boolean' ? Number(agent[field]) : agent[field]);
}

function audit(eventType, actor, id, companyId) {
    recordAudit(eventType, { actorUserId: actor.id, detail: { agentId: id, companyId } });
}

function create(actor, input) {
    requireCompany(actor);
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_AGENT_SEARCHES) {
        throw new ManagedAgentError(400, `Submit 1 to ${MAX_AGENT_SEARCHES} agents at a time.`);
    }
    return transaction(() => {
        const options = searchOptions(actor);
        const seen = new Set();
        const agents = input.map((value, index) => {
            const row = index + 1;
            const agent = validate(value, options, row);
            // Saved queries are references. They do not change the search or settings.
            const key = JSON.stringify(AGENT_FIELDS.filter(field => field !== 'savedQueryId').map(field => agent[field]));
            if (seen.has(key)) throw new ManagedAgentError(400, 'This search and its settings duplicate a previous row.', row);
            seen.add(key);
            return agent;
        });
        const batchId = randomUUID();
        const now = new Date().toISOString();
        const insert = db.prepare(`
            INSERT INTO managed_agents (
                id, batch_id, company_id, created_by_user_id, created_at, updated_at,
                rate_type, origin_port, destination_port, sailing_date, saved_query_id,
                container_type, allow_alternative_routes, allow_booking_request, price_min, price_max, booking_slots
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        return agents.map(agent => {
            const id = randomUUID();
            insert.run(id, batchId, actor.company.id, actor.id, now, now, ...bindings(agent));
            audit(EVENT_MANAGED_AGENT_CREATED, actor, id, actor.company.id);
            return presentForSession(actor, getAgent(id));
        });
    });
}

function requireChanged(result) {
    if (!result.changes) throw new ManagedAgentError(409, 'Only queued agents can be changed.');
}

function update(actor, id, input) {
    return transaction(() => {
        const agent = requireQueuedAgent(actor, id);
        const values = validate(input, editSearchOptions(actor, agent), 1, agent.saved_query_id);
        requireChanged(db.prepare(`
            UPDATE managed_agents SET
                rate_type = ?, origin_port = ?, destination_port = ?, sailing_date = ?, saved_query_id = ?,
                container_type = ?, allow_alternative_routes = ?, allow_booking_request = ?, price_min = ?, price_max = ?,
                booking_slots = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'
        `).run(...bindings(values), new Date().toISOString(), id));
        audit(EVENT_MANAGED_AGENT_UPDATED, actor, id, agent.company_id);
        return presentForSession(actor, getAgent(id));
    });
}

function remove(actor, id) {
    transaction(() => {
        const agent = requireQueuedAgent(actor, id);
        requireChanged(db.prepare("DELETE FROM managed_agents WHERE id = ? AND status = 'queued'").run(id));
        audit(EVENT_MANAGED_AGENT_DELETED, actor, id, agent.company_id);
    });
}

function listForAdmin(status) {
    if (!STATUSES.includes(status)) throw new ManagedAgentError(400, 'invalid_request');
    return db.prepare(SELECT_AGENTS + ' WHERE a.status = ? ORDER BY a.created_at, a.rowid').all(status)
        .map(agent => ({
            ...present(agent, { showCompany: true, canEdit: agent.status === 'queued' }),
            companyType: agent.company_type || ''
        }));
}

function requireAgent(id) {
    const agent = getAgent(id);
    if (!agent) throw new ManagedAgentError(404, 'not_found');
    return agent;
}

function matchRate(agent, rate, destinationPort) {
    if (!rate || rate.rateType !== agent.rate_type || rate.originPort !== agent.origin_port
        || rate.destinationPort !== destinationPort) return null;
    const start = rateDate(rate.rateEffectiveDate);
    const expiration = rate.rateExpirationDate?.trim();
    const end = expiration && expiration !== 'N/A' ? rateDate(expiration) : null;
    if (!start || start > agent.sailing_date || (end !== null && end < agent.sailing_date)) return null;

    const price = rate[`rate${agent.container_type}`];
    if (price == null) return null;
    const match = {
        rateId: rate.id,
        carrier: rate.carrier,
        contractOwner: rate.contractOwner,
        ownerCompanyName: rate.ownerCompanyName,
        price,
        rateEffectiveDate: rate.rateEffectiveDate,
        rateExpirationDate: end === null ? null : rate.rateExpirationDate,
        bookable: expirationAllows(rate.rateExpirationDate)
    };
    if (agent.allow_booking_request) {
        match.withinPriceRange = agent.price_min <= price && price <= agent.price_max;
    }
    return match;
}

function matchesForAdmin(id, alternative) {
    const agent = requireAgent(id);
    if (alternative !== null && !agent.allow_alternative_routes) {
        throw new ManagedAgentError(403, 'alternatives_not_allowed');
    }
    if (alternative === '') throw new ManagedAgentError(400, 'invalid_request');
    const destinationPort = alternative ?? agent.destination_port;
    const access = {
        companyRecordId: agent.company_id,
        companyType: agent.company_type,
        companyName: agent.company_name
    };
    // Owner views contain contract prices. This endpoint only exposes customer prices.
    const rates = access.companyType === COMPANY_TYPE_CUSTOMER ? appRates(access) : [];
    const matches = rates.map(rate => matchRate(agent, rate, destinationPort)).filter(Boolean);
    const sailings = filterSailingsForLane(appSailings(access, { originPort: agent.origin_port }), destinationPort)
        .filter(row => rateDate(row.departure) >= agent.sailing_date)
        .slice(0, 5)
        .map(({ ownerCompanyId, ...sailing }) => sailing);
    return { destinationPort, matches, sailings };
}

function bookForAdmin(id, body) {
    const rateId = typeof body?.rateId === 'string' ? body.rateId.trim() : '';
    if (!rateId) throw new ManagedAgentError(400, 'invalid_request');
    return transaction(() => {
        const agent = requireAgent(id);
        if (agent.booking_request_id) throw new ManagedAgentError(409, 'already_booked');
        if (!agent.allow_booking_request) throw new ManagedAgentError(403, 'booking_not_allowed');
        if (agent.status !== 'queued' && agent.status !== 'running') {
            throw new ManagedAgentError(409, 'invalid_request');
        }
        const actor = loadActor(agent.created_by_user_id);
        if (actor?.company?.id !== agent.company_id || !canRequestBooking(actor)) {
            throw new ManagedAgentError(409, 'agent_creator_unavailable');
        }
        const rate = customerPricedRate(actor.company.id, rateId);
        const destinationPort = agent.allow_alternative_routes ? rate?.destinationPort : agent.destination_port;
        const match = matchRate(agent, rate, destinationPort);
        if (!match) throw new ManagedAgentError(404, 'not_found');
        if (!match.withinPriceRange) throw new ManagedAgentError(400, 'price_out_of_range');

        const booking = createRequest(actor, {
            rateId,
            containerSize: agent.container_type,
            slots: agent.booking_slots
        }, { channel: 'admin_agent', agentId: id });
        db.prepare('UPDATE managed_agents SET booking_request_id = ? WHERE id = ?').run(booking.id, id);
        return booking;
    });
}

function startForAdmin(id) {
    return transaction(() => {
        const changed = db.prepare(`
            UPDATE managed_agents SET status = 'running', started_at = ?
            WHERE id = ? AND status = 'queued'
        `).run(new Date().toISOString(), id);
        const agent = requireAgent(id);
        if (!changed.changes) throw new ManagedAgentError(409, 'not_queued');
        recordAudit(EVENT_MANAGED_AGENT_STARTED, { detail: { agentId: id, companyId: agent.company_id, status: 'running' } });
        return present(agent, { showCompany: true, canEdit: false });
    });
}

function finishForAdmin(id, body) {
    const { status, resultSummary } = body ?? {};
    const summary = typeof resultSummary === 'string' ? resultSummary.trim() : '';
    if ((status !== 'completed' && status !== 'failed') || !summary || Array.from(summary).length > 1000) {
        throw new ManagedAgentError(400, 'invalid_request');
    }
    return transaction(() => {
        const agent = db.prepare(`
            UPDATE managed_agents SET status = ?, finished_at = ?, result_summary = ?
            WHERE id = ? AND status = 'running'
            RETURNING company_id, finished_at, booking_request_id
        `).get(status, new Date().toISOString(), summary, id);
        if (!agent) throw new ManagedAgentError(409, 'not_running');
        recordAudit(EVENT_MANAGED_AGENT_FINISHED, { detail: { agentId: id, companyId: agent.company_id, status } });
        return { id, status, finishedAt: agent.finished_at, resultSummary: summary, bookingRequestId: agent.booking_request_id };
    });
}

module.exports = {
    ManagedAgentError, getOptions, list, create, update, remove, listForAdmin, matchesForAdmin, bookForAdmin,
    startForAdmin, finishForAdmin
};
