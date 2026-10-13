// Shared predictive pricing (D-015). Demo, app, partner, and MCP all call this
// module. Nothing is persisted. The >90-day check, the full-30-day-period
// count, latest-rate selection, and the 5%-per-period formula live here.

function allocationNotice() {
    return require('./visibility').ALLOCATION_NOTICE;
}

function domain() {
    return require('./domain');
}

function store() {
    return require('./store');
}

function calculatePredictiveRate(value, fullThirtyDayPeriods) {
    const baseRate = Number(value) || 0;
    return Math.round(baseRate * (1 + (fullThirtyDayPeriods * 0.05)));
}

function expirationTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

// Dedupe rate records to the latest (by expiration date) per route. carrier and
// originPort are optional filters: when omitted (undefined) the dedupe runs
// across ALL carriers and origin ports. Passed filters use sameValue, which is
// the historical demo/app behavior. Partner filters are applied before this
// call so they can match the partner API's case-insensitive exact match.
function latestPredictiveRateRecords(records, carrier, originPort) {
    const { normalizeValue, sameValue } = domain();
    const latestByRoute = new Map();
    for (const record of records) {
        const fields = record.fields;
        if (carrier !== undefined && !sameValue(fields.Carrier, carrier)) continue;
        if (originPort !== undefined && !sameValue(fields['Origin Port'], originPort)) continue;
        const destinationPort = normalizeValue(fields['Destination Port/Via Port']);
        const arrival = normalizeValue(fields.Arrival, '');
        const routeKey = [fields.Carrier, fields['Origin Port'], destinationPort, arrival].join('\u0000');
        const latest = latestByRoute.get(routeKey);
        if (!latest || expirationTimestamp(fields['Rate Expiration Date']) > expirationTimestamp(latest.fields['Rate Expiration Date'])) {
            latestByRoute.set(routeKey, record);
        }
    }
    return [...latestByRoute.values()];
}

// Shapes a predictive rate record identically to mapRateRecord (so the existing
// rates table renderer works unchanged) but derives each container price from
// calculatePredictiveRate(baseRate, fullThirtyDayPeriods) before applying the
// company margin via calculateRate. rateEffectiveDate is the requested "after"
// date, rateExpirationDate is 'N/A', and predictive:true flags the row.
function mapPredictiveRateRecord(record, company, fullThirtyDayPeriods, after) {
    const { normalizeValue, calculateRate } = domain();
    const fields = record.fields;
    return {
        id: record.id,
        rateType: normalizeValue(fields['Rate Type']),
        originPort: normalizeValue(fields['Origin Port']),
        destinationPort: normalizeValue(fields['Destination Port/Via Port']),
        inlandDeliveryLocation: normalizeValue(fields['Inland Delivery Location']),
        commodityType: normalizeValue(fields.CommodityType),
        carrier: normalizeValue(fields.Carrier),
        contractOwner: normalizeValue(fields['Contract Owner']),
        rate20D: calculateRate(calculatePredictiveRate(fields['20D Rate'], fullThirtyDayPeriods), company),
        rate40D: calculateRate(calculatePredictiveRate(fields['40D rate'], fullThirtyDayPeriods), company),
        rate40HC: calculateRate(calculatePredictiveRate(fields['40HC Rate'], fullThirtyDayPeriods), company),
        rateEffectiveDate: after,
        rateExpirationDate: 'N/A',
        notes1: normalizeValue(fields['Notes 1'], ''),
        predictive: true
    };
}

const PREDICTIVE_TOO_SOON = 'Departing after must be more than 90 days in the future.';

function predictiveWindow(after) {
    const { parseDateOnly, fullDaysUntil } = domain();
    const departureDate = parseDateOnly(after);
    const daysUntilDeparture = departureDate && fullDaysUntil(departureDate);
    if (!departureDate || daysUntilDeparture <= 90) {
        return { ok: false, error: PREDICTIVE_TOO_SOON };
    }
    return {
        ok: true,
        after,
        daysUntilDeparture,
        fullThirtyDayPeriods: Math.floor(daysUntilDeparture / 30)
    };
}

function demoPredictiveData(records, after) {
    const window = predictiveWindow(after);
    if (!window.ok) return window;
    const { normalizeValue } = domain();
    const predictions = latestPredictiveRateRecords(records).map(record => {
        const fields = record.fields;
        return {
            carrier: normalizeValue(fields.Carrier),
            originPort: normalizeValue(fields['Origin Port']),
            destinationPort: normalizeValue(fields['Destination Port/Via Port']),
            arrival: normalizeValue(fields.Arrival, ''),
            departingAfter: after,
            rate20D: calculatePredictiveRate(fields['20D Rate'], window.fullThirtyDayPeriods),
            rate40D: calculatePredictiveRate(fields['40D rate'], window.fullThirtyDayPeriods),
            rate40HC: calculatePredictiveRate(fields['40HC Rate'], window.fullThirtyDayPeriods)
        };
    });
    return { ok: true, body: { data: predictions, meta: { total: predictions.length } } };
}

function matchesPartnerFilter(value, filter) {
    if (!filter) return true;
    return String(value ?? '').toLowerCase() === String(filter).toLowerCase();
}

function partnerPredictiveDto(record, fullThirtyDayPeriods, after) {
    const { normalizeValue } = domain();
    const fields = record.fields;
    return {
        id: record.id,
        source: 'base_contract',
        estimate: true,
        allocationEvidence: false,
        capacityQuantity: null,
        carrier: normalizeValue(fields.Carrier),
        contractOwner: normalizeValue(fields['Contract Owner']),
        ownerCompanyId: record.ownerCompanyId,
        originPort: normalizeValue(fields['Origin Port']),
        destinationPort: normalizeValue(fields['Destination Port/Via Port']),
        inlandDeliveryLocation: normalizeValue(fields['Inland Delivery Location']),
        commodityType: normalizeValue(fields.CommodityType),
        rate20D: calculatePredictiveRate(fields['20D Rate'], fullThirtyDayPeriods),
        rate40D: calculatePredictiveRate(fields['40D rate'], fullThirtyDayPeriods),
        rate40HC: calculatePredictiveRate(fields['40HC Rate'], fullThirtyDayPeriods),
        currency: null,
        departingAfter: after,
        updatedAt: null,
        notes: normalizeValue(fields['Notes 1'], '')
    };
}

function listOwnerPredictive(access, query) {
    const window = predictiveWindow(query.after);
    if (!window.ok) return { error: window.error };
    const records = store().getRatesByOwner(access.companyRecordId).filter(record => {
        const fields = record.fields;
        return matchesPartnerFilter(fields.Carrier, query.carrier)
            && matchesPartnerFilter(fields['Origin Port'], query.originPort);
    });
    const selected = latestPredictiveRateRecords(records)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const page = query.page;
    const pageSize = query.pageSize;
    const start = (page - 1) * pageSize;
    const data = selected.slice(start, start + pageSize).map(record => partnerPredictiveDto(record, window.fullThirtyDayPeriods, query.after));
    return {
        data,
        meta: {
            total: selected.length,
            page,
            pageSize,
            returned: data.length,
            notice: allocationNotice(),
            estimate: true,
            after: query.after,
            basis: {
                formula: '5_percent_per_full_30_day_period',
                fullThirtyDayPeriods: window.fullThirtyDayPeriods,
                selection: 'latest_expiration_per_route'
            },
            owner: {
                companyId: access.companyRecordId,
                companyName: access.companyName || ''
            }
        }
    };
}

module.exports = {
    PREDICTIVE_TOO_SOON,
    calculatePredictiveRate,
    latestPredictiveRateRecords,
    mapPredictiveRateRecord,
    predictiveWindow,
    demoPredictiveData,
    listOwnerPredictive
};
