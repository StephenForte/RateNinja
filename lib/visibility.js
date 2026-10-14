const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER
} = require('./constants');
const {
    normalizeValue,
    mapRateRecord
} = require('./domain');
const {
    mapPredictiveRateRecord,
    latestPredictiveRateRecords,
    calculatePredictiveRate
} = require('./predictive');
const { customerPrice } = require('./pricing');
const store = require('./store');

const ALLOCATION_NOTICE = 'Rate and sailing records are not evidence of allocatable or transferable capacity.';

function marginCompany(link) {
    return {
        fields: {
            MarginPercent: link.marginPercent,
            MarginNumber: link.marginNumber,
            Admin: false
        }
    };
}

// Browsing and predictive browsing both price through customerPrice. fullThirtyDayPeriods
// is omitted for ordinary rates. The mapped object's existing price fields are replaced
// in place so response key order stays the same.
function applyCustomerPrices(mapped, record, link, fullThirtyDayPeriods) {
    const margin = link
        ? { marginPercent: link.marginPercent, marginNumber: link.marginNumber }
        : { marginPercent: 0, marginNumber: 0 };
    const amount = field => (
        fullThirtyDayPeriods == null
            ? record.fields[field]
            : calculatePredictiveRate(record.fields[field], fullThirtyDayPeriods)
    );
    mapped.rate20D = customerPrice(amount('20D Rate'), margin);
    mapped.rate40D = customerPrice(amount('40D rate'), margin);
    mapped.rate40HC = customerPrice(amount('40HC Rate'), margin);
    return mapped;
}

function ownerIdsFor(user) {
    if (!user?.companyRecordId) return [];
    if (user.companyType === COMPANY_TYPE_CONTRACT_OWNER) return [user.companyRecordId];
    if (user.companyType !== COMPANY_TYPE_CUSTOMER) return [];
    return store.listMarginsForCustomer(user.companyRecordId).map(link => link.ownerCompanyId);
}

function appRates(user) {
    if (user.companyType === COMPANY_TYPE_CONTRACT_OWNER) {
        return store.getRatesByOwner(user.companyRecordId).map(record => {
            const mapped = mapRateRecord(record, null);
            applyCustomerPrices(mapped, record, null);
            mapped.contractNumber = record.fields['Contract Number'] || null;
            mapped.ownerCompanyName = user.companyName || '';
            return mapped;
        });
    }
    if (user.companyType !== COMPANY_TYPE_CUSTOMER) return [];
    const rates = [];
    for (const link of store.listMarginsForCustomer(user.companyRecordId)) {
        const margin = marginCompany(link);
        for (const record of store.getRatesByOwner(link.ownerCompanyId)) {
            const mapped = mapRateRecord(record, margin);
            applyCustomerPrices(mapped, record, link);
            mapped.contractNumber = record.fields['Contract Number'] || null;
            mapped.ownerCompanyName = link.ownerCompanyName;
            rates.push(mapped);
        }
    }
    return rates;
}

function appPredictiveRates(user, fullThirtyDayPeriods, after) {
    if (user.companyType === COMPANY_TYPE_CONTRACT_OWNER) {
        return latestPredictiveRateRecords(store.getRatesByOwner(user.companyRecordId)).map(record => {
            const mapped = mapPredictiveRateRecord(record, null, fullThirtyDayPeriods, after);
            applyCustomerPrices(mapped, record, null, fullThirtyDayPeriods);
            mapped.ownerCompanyName = user.companyName || '';
            return mapped;
        });
    }
    if (user.companyType !== COMPANY_TYPE_CUSTOMER) return [];
    const rates = [];
    for (const link of store.listMarginsForCustomer(user.companyRecordId)) {
        const margin = marginCompany(link);
        const records = latestPredictiveRateRecords(store.getRatesByOwner(link.ownerCompanyId));
        for (const record of records) {
            const mapped = mapPredictiveRateRecord(record, margin, fullThirtyDayPeriods, after);
            applyCustomerPrices(mapped, record, link, fullThirtyDayPeriods);
            mapped.ownerCompanyName = link.ownerCompanyName;
            rates.push(mapped);
        }
    }
    return rates;
}

function appSailings(user, filters) {
    return store.getSailingsForOwners(ownerIdsFor(user), filters);
}

function baseRateAmount(value) {
    return Math.round(Number(value) || 0);
}

function partnerRateDto(record) {
    const fields = record.fields;
    return {
        id: record.id,
        source: 'base_contract',
        allocationEvidence: false,
        capacityQuantity: null,
        carrier: normalizeValue(fields.Carrier),
        contractOwner: normalizeValue(fields['Contract Owner']),
        ownerCompanyId: record.ownerCompanyId,
        originPort: normalizeValue(fields['Origin Port']),
        destinationPort: normalizeValue(fields['Destination Port/Via Port']),
        inlandDeliveryLocation: normalizeValue(fields['Inland Delivery Location']),
        commodityType: normalizeValue(fields.CommodityType),
        rate20D: baseRateAmount(fields['20D Rate']),
        rate40D: baseRateAmount(fields['40D rate']),
        rate40HC: baseRateAmount(fields['40HC Rate']),
        currency: null,
        rateEffectiveDate: normalizeValue(fields['Rate Effective Date']),
        rateExpirationDate: normalizeValue(fields['Rate Expiration Date']),
        updatedAt: null,
        notes: normalizeValue(fields['Notes 1'], '')
    };
}

function partnerSailingDto(record) {
    return {
        id: record.id,
        source: 'base_contract',
        allocationEvidence: false,
        capacityQuantity: null,
        departure: record.Departure || record.departure || null,
        arrival: record.Arrival || record.arrival || null,
        transitTime: record.TransitTime || record.transitTime || null,
        vessel: record.Vessel || record.vessel || null,
        voyage: record.Voyage || record.voyage || null,
        service: record.Service || record.service || null,
        carrier: record.Carrier || record.carrier || null,
        departurePort: record.departurePort || null,
        ownerCompanyId: record.ownerCompanyId || null,
        currency: null,
        updatedAt: null
    };
}

function partnerListMeta(total, page, pageSize, returned) {
    return {
        total,
        page,
        pageSize,
        returned,
        notice: ALLOCATION_NOTICE
    };
}

function listPartnerRates(access, query) {
    const { rates, total } = store.queryPartnerRates(access.companyRecordId, query);
    const data = rates.map(partnerRateDto);
    return { data, meta: partnerListMeta(total, query.page, query.pageSize, data.length) };
}

function getPartnerRate(access, rateId) {
    const record = store.getPartnerRate(access.companyRecordId, rateId);
    if (!record) return null;
    return { data: partnerRateDto(record), meta: { notice: ALLOCATION_NOTICE } };
}

function listPartnerSailings(access, query) {
    const { sailings, total } = store.queryPartnerSailings(access.companyRecordId, query);
    const data = sailings.map(partnerSailingDto);
    return { data, meta: partnerListMeta(total, query.page, query.pageSize, data.length) };
}

function getPartnerSailing(access, sailingId) {
    const record = store.getPartnerSailing(access.companyRecordId, sailingId);
    if (!record) return null;
    return { data: partnerSailingDto(record), meta: { notice: ALLOCATION_NOTICE } };
}

module.exports = {
    ALLOCATION_NOTICE,
    applyCustomerPrices,
    ownerIdsFor,
    appRates,
    appPredictiveRates,
    appSailings,
    listPartnerRates,
    getPartnerRate,
    listPartnerSailings,
    getPartnerSailing
};
