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

function fullDaysUntil(date) {
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.floor((date.getTime() - todayUtc) / (24 * 60 * 60 * 1000));
}

function expirationTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function calculatePredictiveRate(value, fullThirtyDayPeriods) {
    const baseRate = Number(value) || 0;
    return Math.round(baseRate * (1 + (fullThirtyDayPeriods * 0.05)));
}

function latestPredictiveRateRecords(records, carrier, originPort) {
    const latestByRoute = new Map();
    for (const record of records) {
        const fields = record.fields;
        if (!sameValue(fields.Carrier, carrier) || !sameValue(fields['Origin Port'], originPort)) continue;
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
    mapSailingRecord,
    parsePageNumber,
    matchesSearch,
    parseDateOnly,
    fullDaysUntil,
    calculatePredictiveRate,
    latestPredictiveRateRecords,
    companyById,
    rateVisibleToView
};
