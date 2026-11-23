'use strict';

const { db, transaction } = require('./db');
const { loadActor, canRequestBooking } = require('./permissions');
const { COMPANY_TYPE_CUSTOMER } = require('./constants');
const { appRates, appSailings, customerPricedRate } = require('./visibility');
const { matchRate, calendarDate, rateDate } = require('./managed-agents');
const { filterSailingsForLane } = require('./client-agent');
const { createRequest, BookingError } = require('./booking-requests');

const DAY_MS = 24 * 60 * 60 * 1000;
const refusal = reason => ({ reason });

function customerAccess(run) {
    return { companyRecordId: run.company_id, companyType: COMPANY_TYPE_CUSTOMER };
}

function laneMatch(lane, rate) {
    return matchRate({
        rate_type: lane.rateType,
        origin_port: lane.originPort,
        sailing_date: lane.sailingDate,
        container_type: lane.containerType,
        booking_slots: lane.bookingSlots,
        allow_booking_request: lane.allowBookingRequest,
        accept_max_slots: lane.acceptMaxSlots,
        price_min: lane.priceMin,
        price_max: lane.priceMax
    }, rate, lane.destinationPort);
}

function searchLane(run, lane) {
    const access = customerAccess(run);
    const matches = appRates(access).map(rate => laneMatch(lane, rate)).filter(Boolean);
    const sailings = filterSailingsForLane(appSailings(access, { originPort: lane.originPort }), lane.destinationPort)
        .filter(row => rateDate(row.departure) >= lane.sailingDate)
        .slice(0, 5)
        .map(({ departure, arrivalPort, carrier, vessel, voyage }) => ({
            departure, arrivalPort, carrier, vessel, voyage
        }));
    return { matches, sailings };
}

function redirectLane(run, lane, first, hadEligibleRate, input, now) {
    if (!first || first.status !== 'completed') return refusal('search_required');
    // Use the match set the search actually saw, including eligible rates it did not choose.
    if (hadEligibleRate) {
        return refusal('bookable_rate_available');
    }
    const { destinationPort, sailingDate } = input;
    if ((typeof destinationPort === 'string') === (typeof sailingDate === 'string')) {
        return refusal('invalid_redirect');
    }
    const rates = appRates(customerAccess(run));
    if (typeof destinationPort === 'string') {
        if (!lane.allowAlternativeRoutes) return refusal('alternatives_not_allowed');
        if (destinationPort === lane.destinationPort || !rates.some(rate =>
            rate.originPort === lane.originPort && rate.destinationPort === destinationPort
        )) return refusal('destination_unavailable');
        return { lane: { ...lane, destinationPort } };
    }
    if (!lane.dateFlexDays) return refusal('date_flex_not_allowed');
    if (!calendarDate(sailingDate) || sailingDate === lane.sailingDate
        || sailingDate < new Date(now).toISOString().slice(0, 10)
        || Math.abs(Date.parse(sailingDate) - Date.parse(lane.sailingDate)) > lane.dateFlexDays * DAY_MS) {
        return refusal('date_out_of_flex');
    }
    const redirected = { ...lane, sailingDate };
    if (!rates.some(rate => laneMatch(redirected, rate))) return refusal('date_outside_rate_window');
    return { lane: redirected };
}

function bookingTerms(run, snapshot, lane, rateId) {
    const live = db.prepare('SELECT status, cancel_requested, spend_booked, slots_booked FROM swarm_runs WHERE id = ?')
        .get(run.id);
    if (!live || live.status !== 'running' || live.cancel_requested) return refusal('not_running');
    if (!lane?.allowBookingRequest) return refusal('booking_not_allowed');
    const booked = db.prepare(`
        SELECT 1 FROM swarm_run_agents WHERE run_id = ? AND lane_position = ? AND booking_request_id IS NOT NULL
    `).get(run.id, lane.position);
    if (booked) return refusal('already_booked');
    if (typeof rateId !== 'string' || !rateId) return refusal('rate_not_reported');
    const search = db.prepare(`
        SELECT destination_port, sailing_date, price, slots FROM swarm_run_agents
        WHERE run_id = ? AND lane_position = ? AND role = 'search' AND status = 'completed' AND rate_id = ?
        ORDER BY attempt DESC LIMIT 1
    `).get(run.id, lane.position, rateId);
    if (!search) return refusal('rate_not_reported');
    if (search.price < lane.priceMin || search.price > lane.priceMax) return refusal('price_out_of_range');
    if (search.slots == null) return refusal('rate_not_bookable');
    const actor = loadActor(run.started_by_user_id);
    if (actor?.company?.id !== run.company_id || !canRequestBooking(actor)) return refusal('cannot_request_booking');

    const rate = customerPricedRate(run.company_id, rateId);
    const chosenLane = { ...lane, destinationPort: search.destination_port, sailingDate: search.sailing_date };
    const match = laneMatch(chosenLane, rate);
    if (!match || !match.bookable) return refusal('rate_not_bookable');
    if (!match.withinPriceRange) return refusal('price_out_of_range');
    const slots = match.slotsToBook ?? lane.bookingSlots;
    const spend = live.spend_booked + match.price * slots;
    const totalSlots = live.slots_booked + slots;
    if (!Number.isSafeInteger(spend) || !Number.isFinite(snapshot.totalSpendCap) || spend > snapshot.totalSpendCap) return refusal('spend_cap');
    if (!Number.isSafeInteger(snapshot.totalSlotsCap) || totalSlots > snapshot.totalSlotsCap) return refusal('slots_cap');
    return { actor, chosenLane, price: match.price, slots, spend, totalSlots };
}

function book(run, snapshot, lane, rateId, agentId) {
    try {
        return transaction(() => {
            const terms = bookingTerms(run, snapshot, lane, rateId);
            if (terms.reason) return terms;
            const booking = createRequest(terms.actor, {
                rateId, containerSize: lane.containerType, slots: terms.slots
            }, { channel: 'swarm_agent', agentId });
            db.prepare('UPDATE swarm_runs SET spend_booked = ?, slots_booked = ? WHERE id = ?')
                .run(terms.spend, terms.totalSlots, run.id);
            const saved = db.prepare(`
                UPDATE swarm_run_agents SET rate_id = ?, price = ?, slots = ?, booking_request_id = ?
                WHERE id = ? AND run_id = ? AND role = 'booking' AND status = 'running'
            `).run(rateId, terms.price, terms.slots, booking.id, agentId, run.id);
            if (!saved.changes) throw new Error('Booking agent row missing.');
            return { bookingRequestId: booking.id, price: terms.price, slots: terms.slots };
        });
    } catch (error) {
        if (error instanceof BookingError) return refusal('booking_refused');
        throw error;
    }
}

module.exports = { searchLane, redirectLane, bookingTerms, book };
