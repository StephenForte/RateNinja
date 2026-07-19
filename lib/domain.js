function normalizeValue(value, fallback = 'N/A') {
    if (Array.isArray(value)) return value.join(', ') || fallback;
    return value ?? fallback;
}

function sameValue(left, right) {
    return String(left ?? '') === String(right ?? '');
}

function asArray(value) {
    return Array.isArray(value) ? value : [value];
}

function escapeFormulaString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function calculateRate(value, company) {
    const baseRate = Number(value) || 0;
    if (!company || company.fields.Admin) return Math.round(baseRate);
    const rawPercent = Number(company.fields.MarginPercent) || 0;
    const marginPercent = rawPercent > 1 ? rawPercent / 100 : rawPercent;
    const marginNumber = Number(company.fields.MarginNumber) || 0;
    return Math.round(baseRate * (1 + marginPercent) + marginNumber);
}

function mapRateRecord(record, company) {
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
        rate20D: calculateRate(fields['20D Rate'], company),
        rate40D: calculateRate(fields['40D rate'], company),
        rate40HC: calculateRate(fields['40HC Rate'], company),
        rateEffectiveDate: normalizeValue(fields['Rate Effective Date']),
        rateExpirationDate: normalizeValue(fields['Rate Expiration Date']),
        notes1: normalizeValue(fields['Notes 1'], '')
    };
}

// Shapes a predictive rate record identically to mapRateRecord (so the existing
// rates table renderer works unchanged) but derives each container price from
// calculatePredictiveRate(baseRate, fullThirtyDayPeriods) before applying the
// company margin via calculateRate. rateEffectiveDate is the requested "after"
// date, rateExpirationDate is 'N/A', and predictive:true flags the row.
function mapPredictiveRateRecord(record, company, fullThirtyDayPeriods, after) {
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

function mapSailingRecord(record) {
    return {
        departure: normalizeValue(record.fields.Departure),
        arrival: normalizeValue(record.fields.Arrival),
        transitTime: normalizeValue(record.fields.TransitTime),
        vessel: normalizeValue(record.fields.Vessel),
        voyage: normalizeValue(record.fields.Voyage),
        service: normalizeValue(record.fields.Service)
    };
}

function parsePageNumber(value, fallback, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function matchesSearch(value, query) {
    return !query || String(value).toLowerCase().includes(query.toLowerCase());
}

function parseDateOnly(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
        ? date
        : null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fullDaysUntil(date) {
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.floor((date.getTime() - todayUtc) / MS_PER_DAY);
}

// Shared date validation for the admin pull-forward endpoints (rates + sailings).
// Returns { error } on failure, or { offsetDays } (the UTC day offset targetStart
// - sourceStart) on success. priceIncreasePercent is validated by the caller.
function validatePullForwardRange({ sourceStart, sourceEnd, targetStart, targetEnd }) {
    const start = parseDateOnly(sourceStart);
    const sEnd = parseDateOnly(sourceEnd);
    const tStart = parseDateOnly(targetStart);
    const tEnd = parseDateOnly(targetEnd);
    if (!start || !sEnd || !tStart || !tEnd) {
        return { error: 'sourceStart, sourceEnd, targetStart, and targetEnd must all be valid YYYY-MM-DD dates.' };
    }
    if (start.getTime() > sEnd.getTime()) {
        return { error: 'Source start date must not be after source end date.' };
    }
    if (tStart.getTime() > tEnd.getTime()) {
        return { error: 'Target start date must not be after target end date.' };
    }
    if (tStart.getTime() <= sEnd.getTime()) {
        return { error: 'Target range must start after the source range ends.' };
    }
    if (fullDaysUntil(tEnd) > 90) {
        return { error: 'Target range must end within 90 days of today.' };
    }
    if (sEnd.getTime() - start.getTime() !== tEnd.getTime() - tStart.getTime()) {
        return { error: 'Target range length must equal source range length.' };
    }
    return { offsetDays: Math.round((tStart.getTime() - start.getTime()) / MS_PER_DAY) };
}

// Shift a YYYY-MM-DD date-only string by a whole number of days (UTC). Returns
// the original value unchanged when it is not a parseable date-only string
// (e.g. null expiration dates), so callers can pass columns verbatim.
function shiftDateOnly(value, offsetDays) {
    const date = parseDateOnly(value);
    if (!date) return value;
    return new Date(date.getTime() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

// Shift a date-or-datetime string by a whole number of days while preserving any
// time-of-day component. Only the leading YYYY-MM-DD portion is shifted (UTC day
// arithmetic); everything after it (e.g. "T08:30:00Z") is re-appended verbatim.
// Returns the original value unchanged when it has no parseable date-only prefix.
function shiftDateTime(value, offsetDays) {
    if (typeof value !== 'string' || value.length < 10) return value;
    const datePart = value.slice(0, 10);
    const shifted = shiftDateOnly(datePart, offsetDays);
    if (shifted === datePart) return value;
    return shifted + value.slice(10);
}

function expirationTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function calculatePredictiveRate(value, fullThirtyDayPeriods) {
    const baseRate = Number(value) || 0;
    return Math.round(baseRate * (1 + (fullThirtyDayPeriods * 0.05)));
}

// Dedupe rate records to the latest (by expiration date) per route. carrier and
// originPort are optional filters: when omitted (undefined) the dedupe runs
// across ALL carriers and origin ports, which the predictive main-screen view
// needs; the public predictive-pricing endpoint still passes both to scope it.
function latestPredictiveRateRecords(records, carrier, originPort) {
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

function companyById(companies, companyId) {
    return companies.find(record => sameValue(record.fields.CompanyID, companyId)) || null;
}

function rateVisibleToView(record, rateView) {
    return asArray(record.fields.RateView).some(value => sameValue(value, rateView));
}

module.exports = {
    normalizeValue,
    sameValue,
    asArray,
    escapeFormulaString,
    calculateRate,
    mapRateRecord,
    mapPredictiveRateRecord,
    mapSailingRecord,
    parsePageNumber,
    matchesSearch,
    parseDateOnly,
    fullDaysUntil,
    validatePullForwardRange,
    shiftDateOnly,
    shiftDateTime,
    calculatePredictiveRate,
    latestPredictiveRateRecords,
    companyById,
    rateVisibleToView
};
