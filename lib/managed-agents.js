'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
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
    'containerType', 'allowAlternativeRoutes', 'allowBookingRequest', 'priceMin', 'priceMax', 'bookingSlots', 'acceptMaxSlots'
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

function searchOptions(actor, company = actor.company, now = new Date()) {
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
        today: now.toISOString().slice(0, 10),
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
        allowAlternativeRoutes, allowBookingRequest, priceMin, priceMax, bookingSlots, acceptMaxSlots = false
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
    if (typeof acceptMaxSlots !== 'boolean') invalid('Provide acceptMaxSlots as true or false.');
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
        bookingSlots: allowBookingRequest ? bookingSlots : null,
        acceptMaxSlots: allowBookingRequest && acceptMaxSlots
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
        acceptMaxSlots: Boolean(agent.accept_max_slots),
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
                container_type, allow_alternative_routes, allow_booking_request, price_min, price_max, booking_slots, accept_max_slots
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                booking_slots = ?, accept_max_slots = ?, updated_at = ?
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

function bookingSlotsForRate(agent, maxSlotsAllowed) {
    if (agent.accept_max_slots && maxSlotsAllowed >= 1 && maxSlotsAllowed < agent.booking_slots) {
        return maxSlotsAllowed;
    }
    return agent.booking_slots;
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
    const maxSlotsAllowed = rate.maxSlotsAllowed == null ? null : rate.maxSlotsAllowed;
    const slotsToBook = bookingSlotsForRate(agent, maxSlotsAllowed);
    const slotsFit = maxSlotsAllowed == null
        || (maxSlotsAllowed >= 1 && slotsToBook <= maxSlotsAllowed);
    const match = {
        rateId: rate.id,
        carrier: rate.carrier,
        contractOwner: rate.contractOwner,
        ownerCompanyName: rate.ownerCompanyName,
        price,
        rateEffectiveDate: rate.rateEffectiveDate,
        rateExpirationDate: end === null ? null : rate.rateExpirationDate,
        maxSlotsAllowed,
        ...(agent.accept_max_slots && slotsFit ? { slotsToBook } : {}),
        bookable: expirationAllows(rate.rateExpirationDate) && slotsFit
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
            slots: match.slotsToBook ?? agent.booking_slots
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

function finishInterrupted(id, summary) {
    return transaction(() => {
        const agent = db.prepare(`
            UPDATE managed_agents SET status = 'failed', finished_at = ?, result_summary = ?
            WHERE id = ? AND status = 'running'
            RETURNING company_id, finished_at
        `).get(new Date().toISOString(), summary, id);
        if (!agent) return false;
        recordAudit(EVENT_MANAGED_AGENT_FINISHED, { detail: { agentId: id, companyId: agent.company_id, status: 'failed' } });
        return true;
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

const DAY_MS = 86400000;

function randomFromSeed(seed) {
    let hash = 2166136261;
    const text = String(seed);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    let state = hash >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function unit(random) {
    const value = Number(random());
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 1) return 0.999999;
    return value;
}

function parseDay(value) {
    return Date.parse(`${value}T00:00:00.000Z`);
}

function formatDay(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function addDays(day, count) {
    return formatDay(parseDay(day) + count * DAY_MS);
}

function dayCount(start, end) {
    return Math.round((parseDay(end) - parseDay(start)) / DAY_MS) + 1;
}

function unionRanges(ranges) {
    const sorted = ranges.slice().sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
    const merged = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (!last || range.start > addDays(last.end, 1)) merged.push({ start: range.start, end: range.end });
        else if (range.end > last.end) last.end = range.end;
    }
    return merged;
}

function laterDay(left, right) {
    return left > right ? left : right;
}

function earlierDay(left, right) {
    return left < right ? left : right;
}

function customerRates(actor) {
    const company = actor.company;
    const access = {
        companyRecordId: company.id,
        companyType: company.fields.CompanyType,
        companyName: company.fields.CompanyName
    };
    return access.companyType === COMPANY_TYPE_CUSTOMER ? appRates(access) : [];
}

function containerPrice(rate, containerType) {
    const price = rate[`rate${containerType}`];
    return Number.isFinite(price) && price >= 0 ? price : null;
}

function rateCoverage(rate) {
    const start = rateDate(rate.rateEffectiveDate);
    if (!start) return null;
    const expiration = typeof rate.rateExpirationDate === 'string' ? rate.rateExpirationDate.trim() : '';
    const end = expiration && expiration !== 'N/A' ? rateDate(expiration) : null;
    if (end === '') return null;
    return { start, end };
}

function pricedRanges(lane, containerType, rates, today) {
    const pieces = [];
    for (const window of lane.windows) {
        const windowStart = laterDay(window.start, today);
        if (windowStart > window.end) continue;
        for (const rate of rates) {
            if (rate.rateType !== lane.rateType || rate.originPort !== lane.originPort || rate.destinationPort !== lane.destinationPort) continue;
            if (containerPrice(rate, containerType) == null) continue;
            const coverage = rateCoverage(rate);
            if (!coverage || coverage.start > window.end) continue;
            const start = laterDay(windowStart, coverage.start);
            const end = coverage.end == null ? window.end : earlierDay(window.end, coverage.end);
            if (start <= end) pieces.push({ start, end });
        }
    }
    return unionRanges(pieces);
}

function openRanges(lane, today) {
    const pieces = [];
    for (const window of lane.windows) {
        const start = laterDay(window.start, today);
        if (start <= window.end) pieces.push({ start, end: window.end });
    }
    return unionRanges(pieces);
}

// Both inputs are merged, ordered ranges of inclusive calendar days.
function subtractRanges(ranges, excluded) {
    const remaining = [];
    for (const { start, end } of ranges) {
        let next = start;
        for (const blocked of excluded) {
            if (blocked.end < next) continue;
            if (blocked.start > end) break;
            if (blocked.start > next) remaining.push({ start: next, end: addDays(blocked.start, -1) });
            if (blocked.end >= end) {
                next = null;
                break;
            }
            next = addDays(blocked.end, 1);
        }
        if (next !== null) remaining.push({ start: next, end });
    }
    return remaining;
}

function catalog(lanes, rates, today, priced, excludedRates = []) {
    const items = [];
    for (const lane of lanes.values()) {
        for (const containerType of CONTAINER_TYPES) {
            const covered = priced ? pricedRanges(lane, containerType, rates, today) : openRanges(lane, today);
            const ranges = covered.length && excludedRates.length
                ? subtractRanges(covered, pricedRanges(lane, containerType, excludedRates, today))
                : covered;
            const weight = ranges.reduce((sum, range) => sum + dayCount(range.start, range.end), 0);
            if (weight > 0) items.push({ lane, containerType, ranges, weight });
        }
    }
    return items;
}

function pickWeighted(random, items) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.floor(unit(random) * total);
    for (const item of items) {
        if (cursor < item.weight) return item;
        cursor -= item.weight;
    }
    return items[items.length - 1];
}

function pickDate(random, ranges) {
    const item = pickWeighted(random, ranges.map(range => ({ ...range, weight: dayCount(range.start, range.end) })));
    const offset = Math.floor(unit(random) * dayCount(item.start, item.end));
    return addDays(item.start, offset);
}

function pickSpec(random, items) {
    const item = pickWeighted(random, items);
    return {
        lane: item.lane,
        containerType: item.containerType,
        sailingDate: pickDate(random, item.ranges)
    };
}

function matchingPrices(rates, spec) {
    const probe = {
        rate_type: spec.lane.rateType,
        origin_port: spec.lane.originPort,
        destination_port: spec.lane.destinationPort,
        sailing_date: spec.sailingDate,
        container_type: spec.containerType
    };
    const prices = [];
    for (const rate of rates) {
        const match = matchRate(probe, rate, spec.lane.destinationPort);
        if (!match || !Number.isFinite(match.price) || match.price < 0) continue;
        prices.push(match.price);
    }
    return prices;
}

function agentInput(spec, { booking, priceMax = null, slots = null, alternatives, acceptMaxSlots }) {
    return {
        rateType: spec.lane.rateType,
        originPort: spec.lane.originPort,
        destinationPort: spec.lane.destinationPort,
        sailingDate: spec.sailingDate,
        savedQueryId: null,
        containerType: spec.containerType,
        allowAlternativeRoutes: alternatives,
        allowBookingRequest: booking,
        priceMin: booking ? 0 : null,
        priceMax: booking ? priceMax : null,
        bookingSlots: booking ? slots : null,
        ...(acceptMaxSlots === undefined ? {} : { acceptMaxSlots })
    };
}

// Each draw consumes the random source in this order: lowball lane, date, slots;
// regular lane, date, slots, alternatives; no-booking lane, date, alternatives;
// shared over-limit lane and date.
// Lowball alternatives stay off. Ceilings use customer prices from appRates.
function buildSampleAgents(actor, { random = Math.random, now = new Date() } = {}) {
    const options = searchOptions(actor, actor.company, now);
    const rates = customerRates(actor);
    const bookingChoices = catalog(options.lanes, rates, options.today, true);
    const openChoices = catalog(options.lanes, rates, options.today, false);
    if (bookingChoices.length === 0 || openChoices.length === 0) {
        throw new ManagedAgentError(422, 'This user has no lane with a matching customer price.');
    }
    const lowballSpec = pickSpec(random, bookingChoices);
    const lowballSlots = 1 + Math.floor(unit(random) * 3);
    const lowballPrices = matchingPrices(rates, lowballSpec);
    const regularSpec = pickSpec(random, bookingChoices);
    const regularSlots = 1 + Math.floor(unit(random) * 3);
    const regularAlternatives = unit(random) < 0.5;
    const regularPrices = matchingPrices(rates, regularSpec);
    const quietSpec = pickSpec(random, openChoices);
    const quietAlternatives = unit(random) < 0.5;
    if (lowballPrices.length === 0 || regularPrices.length === 0) {
        throw new ManagedAgentError(422, 'This user has no lane with a matching customer price.');
    }
    const plan = [
        {
            kind: 'lowball',
            input: agentInput(lowballSpec, {
                booking: true,
                priceMax: Math.floor(0.5 * Math.min(...lowballPrices)),
                slots: lowballSlots,
                alternatives: false
            })
        },
        {
            kind: 'regular',
            input: agentInput(regularSpec, {
                booking: true,
                priceMax: Math.ceil(1.25 * Math.max(...regularPrices)),
                slots: regularSlots,
                alternatives: regularAlternatives
            })
        },
        {
            kind: 'no_booking',
            input: agentInput(quietSpec, { booking: false, alternatives: quietAlternatives })
        }
    ];
    const overLimitSlots = 12;
    const cappedRates = rates.filter(rate => rate.maxSlotsAllowed >= 1 && rate.maxSlotsAllowed <= overLimitSlots - 1);
    const fullSizeRates = rates.filter(rate => rate.maxSlotsAllowed == null || rate.maxSlotsAllowed >= overLimitSlots);
    const cappedChoices = catalog(options.lanes, cappedRates, options.today, true, fullSizeRates);
    if (cappedChoices.length === 0) {
        throw new ManagedAgentError(422,
            'This user has no lane with a matching customer price, a maximum of 1 to 11 slots, and no rate that can take all 12 slots.');
    }
    const cappedSpec = pickSpec(random, cappedChoices);
    const cappedSettings = {
        booking: true,
        priceMax: Math.ceil(1.25 * Math.max(...matchingPrices(rates, cappedSpec))),
        slots: overLimitSlots,
        alternatives: false
    };
    plan.push(
        { kind: 'slots_over_skip', input: agentInput(cappedSpec, { ...cappedSettings, acceptMaxSlots: false }) },
        { kind: 'slots_over_accept', input: agentInput(cappedSpec, { ...cappedSettings, acceptMaxSlots: true }) }
    );
    return plan;
}

function requireSampleActor(userId) {
    if (typeof userId !== 'string' || !userId.trim()) throw new ManagedAgentError(400, 'userId is required.');
    const actor = loadActor(userId.trim());
    if (!actor) throw new ManagedAgentError(404, 'No such user.');
    if (actor.disabled) throw new ManagedAgentError(422, 'This user is disabled.');
    if (!canRequestBooking(actor)) throw new ManagedAgentError(422, "This user's company cannot request bookings.");
    return actor;
}

function resolveSampleRandom({ seed, random }) {
    const supplied = typeof seed === 'string' && seed.length > 0 ? seed : null;
    if (supplied && supplied.length > 128) throw new ManagedAgentError(400, 'seed is too long.');
    if (random) return { seed: supplied || 'injected', random };
    const resolved = supplied || randomBytes(16).toString('hex');
    return { seed: resolved, random: randomFromSeed(resolved) };
}

function samplePlanForUser(userId, options = {}) {
    const actor = requireSampleActor(userId);
    const { seed, random } = resolveSampleRandom(options);
    const plan = buildSampleAgents(actor, { random, now: options.now || new Date() });
    return { actor, seed, plan };
}

function presentPlan(actor, seed, plan) {
    return {
        userId: actor.id,
        username: actor.username,
        displayName: actor.displayName || '',
        companyId: actor.company.id,
        companyName: actor.company.fields.CompanyName || '',
        seed,
        agents: plan.map(({ kind, input }) => ({
            sampleKind: kind,
            rateType: input.rateType,
            originPort: input.originPort,
            destinationPort: input.destinationPort,
            sailingDate: input.sailingDate,
            containerType: input.containerType,
            allowAlternativeRoutes: input.allowAlternativeRoutes,
            allowBookingRequest: input.allowBookingRequest,
            priceMin: input.priceMin,
            priceMax: input.priceMax,
            bookingSlots: input.bookingSlots,
            ...(input.acceptMaxSlots === undefined ? {} : { acceptMaxSlots: input.acceptMaxSlots })
        }))
    };
}

function previewSampleAgents(userId, options) {
    const { actor, seed, plan } = samplePlanForUser(userId, options);
    return presentPlan(actor, seed, plan);
}

function createSampleAgents(userId, options) {
    const { actor, seed, plan } = samplePlanForUser(userId, options);
    const created = create(actor, plan.map(item => item.input));
    const mark = db.prepare(`
        UPDATE audit_events
        SET detail = json_set(detail, '$.adminSample', json('true'), '$.sampleKind', ?)
        WHERE event_type = ? AND json_extract(detail, '$.agentId') = ? AND actor_user_id = ?
    `);
    created.forEach((agent, index) => {
        const result = mark.run(plan[index].kind, EVENT_MANAGED_AGENT_CREATED, agent.id, actor.id);
        if (!result.changes) throw new ManagedAgentError(500, 'Could not mark the sample audit.');
    });
    return {
        ...presentPlan(actor, seed, plan),
        agents: created.map((agent, index) => ({ ...agent, sampleKind: plan[index].kind }))
    };
}

function listCustomerUsers() {
    return db.prepare(`
        SELECT u.id, u.username, u.display_name AS displayName, c.id AS companyId, c.company_name AS companyName
        FROM users u
        JOIN companies c ON c.id = u.company_record_id
        LEFT JOIN company_types ct ON ct.id = c.company_type_id
        WHERE u.disabled = 0
          AND COALESCE(NULLIF(ct.name, ''), c.company_type) = ?
        ORDER BY c.company_name COLLATE NOCASE, u.display_name COLLATE NOCASE, u.username COLLATE NOCASE, u.id
    `).all(COMPANY_TYPE_CUSTOMER).map(row => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName || '',
        companyId: row.companyId,
        companyName: row.companyName || ''
    }));
}

module.exports = {
    ManagedAgentError, getOptions, list, create, update, remove, listForAdmin, matchesForAdmin, bookForAdmin,
    startForAdmin, finishForAdmin, finishInterrupted, listCustomerUsers, previewSampleAgents, createSampleAgents,
    buildSampleAgents, validate, searchOptions
};
