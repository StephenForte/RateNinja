'use strict';

const {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER
} = require('./constants');
const { db } = require('./db');
const { expirationAllows } = require('./booking-requests');
const { createPortResolver } = require('./ports');
const { latestPredictiveRateRecords, predictiveWindow } = require('./predictive');
const { ALLOCATION_NOTICE } = require('./visibility');
const store = require('./store');

const CURRENT_RATE_NOTICE = 'A rate is current when it is not soft-deleted and its expiration allows use today in UTC (a blank expiration or a rate expiring today qualifies). Rates not yet effective are included.';

function matchesFilter(value, filter) {
    if (!filter) return true;
    return String(value ?? '').toLowerCase() === String(filter).toLowerCase();
}

function storedText(value) {
    if (value == null) return '';
    return String(value);
}

function todayUtcDate() {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

function parseStoredDateOnly(value) {
    const text = storedText(value).trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    return date;
}

function isoDateOnly(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function earliestDepartingAfter() {
    const start = todayUtcDate();
    for (let offset = 91; offset < 100; offset += 1) {
        const candidate = new Date(start.getTime());
        candidate.setUTCDate(candidate.getUTCDate() + offset);
        const after = isoDateOnly(candidate);
        if (predictiveWindow(after).ok) return after;
    }
    throw new Error('Could not resolve earliestDepartingAfter from predictiveWindow().');
}

function listMeta(total, page, pageSize, returned) {
    return {
        total,
        page,
        pageSize,
        returned,
        notice: ALLOCATION_NOTICE
    };
}

function paginate(rows, page, pageSize) {
    const start = (page - 1) * pageSize;
    const data = rows.slice(start, start + pageSize);
    return { data, meta: listMeta(rows.length, page, pageSize, data.length) };
}

function compareText(left, right) {
    return String(left ?? '').localeCompare(String(right ?? ''));
}

function visibleCurrentRates(access, query = {}) {
    const rows = [];
    if (access.companyType === COMPANY_TYPE_CONTRACT_OWNER) {
        for (const record of store.getRatesByOwner(access.companyRecordId)) {
            rows.push({ record, ownerCompanyName: access.companyName || '' });
        }
    } else if (access.companyType === COMPANY_TYPE_CUSTOMER) {
        // Same linked-owner set as listAvailableRates / appRates: active margins only.
        for (const link of store.listMarginsForCustomer(access.companyRecordId)) {
            for (const record of store.getRatesByOwner(link.ownerCompanyId)) {
                rows.push({ record, ownerCompanyName: link.ownerCompanyName || '' });
            }
        }
    }
    return rows.filter(({ record }) => {
        const fields = record.fields;
        if (!expirationAllows(fields['Rate Expiration Date'])) return false;
        return matchesFilter(fields.Carrier, query.carrier)
            && matchesFilter(fields['Origin Port'], query.originPort)
            && matchesFilter(fields['Destination Port/Via Port'], query.destinationPort);
    });
}

function listRateDateRanges(access, query) {
    const groups = new Map();
    for (const { record } of visibleCurrentRates(access, query)) {
        const fields = record.fields;
        const originPort = storedText(fields['Origin Port']);
        const destinationPort = storedText(fields['Destination Port/Via Port']);
        const rateEffectiveDate = storedText(fields['Rate Effective Date']);
        const rateExpirationDate = storedText(fields['Rate Expiration Date']);
        const key = [originPort, destinationPort, rateEffectiveDate, rateExpirationDate].join('\u0000');
        const existing = groups.get(key);
        if (existing) {
            existing.rateCount += 1;
        } else {
            groups.set(key, {
                originPort,
                destinationPort,
                rateEffectiveDate,
                rateExpirationDate,
                rateCount: 1
            });
        }
    }
    const rows = [...groups.values()].sort((left, right) => (
        compareText(left.originPort, right.originPort)
        || compareText(left.destinationPort, right.destinationPort)
        || compareText(left.rateEffectiveDate, right.rateEffectiveDate)
        || compareText(left.rateExpirationDate, right.rateExpirationDate)
    ));
    return paginate(rows, query.page, query.pageSize);
}

function listDistinctPorts(access, query, fieldName) {
    const resolver = createPortResolver();
    const values = new Set();
    for (const { record } of visibleCurrentRates(access, query)) {
        const value = storedText(record.fields[fieldName]).trim();
        if (!value) continue;
        values.add(value);
    }
    const rows = [...values]
        .map(value => resolver.resolve(value))
        .sort((left, right) => compareText(left.value, right.value) || compareText(left.code, right.code));
    return paginate(rows, query.page, query.pageSize);
}

function listValidOriginPorts(access, query) {
    return listDistinctPorts(access, query, 'Origin Port');
}

function listValidDestinationPorts(access, query) {
    return listDistinctPorts(access, query, 'Destination Port/Via Port');
}

function listValidContractOwners(access, query) {
    const groups = new Map();
    for (const { record, ownerCompanyName } of visibleCurrentRates(access, query)) {
        const value = storedText(record.fields['Contract Owner']);
        const key = `${value}\u0000${ownerCompanyName}`;
        if (groups.has(key)) continue;
        groups.set(key, {
            value,
            code: value,
            name: value,
            ownerCompanyName
        });
    }
    const rows = [...groups.values()].sort((left, right) => (
        compareText(left.value, right.value) || compareText(left.ownerCompanyName, right.ownerCompanyName)
    ));
    return paginate(rows, query.page, query.pageSize);
}

function listSailingDateRanges(access, query) {
    const resolver = createPortResolver();
    const today = todayUtcDate();
    const clauses = ['owner_company_id = ?', 'deleted_at IS NULL'];
    const params = [access.companyRecordId];
    if (query.originPort) {
        clauses.push('lower(departure_port) = lower(?)');
        params.push(query.originPort);
    }
    // Direct SQL: partner sailing DTOs omit arrival_port; getSailingsForOwners omits departurePort.
    const sailings = db.prepare(`
        SELECT departure, departure_port, arrival_port
        FROM sailings
        WHERE ${clauses.join(' AND ')}
    `).all(...params);

    const groups = new Map();
    for (const sailing of sailings) {
        const departureDate = parseStoredDateOnly(sailing.departure);
        if (!departureDate || departureDate.getTime() < today.getTime()) continue;
        const departurePort = sailing.departure_port == null ? '' : String(sailing.departure_port);
        const arrivalPort = sailing.arrival_port == null || sailing.arrival_port === ''
            ? null
            : String(sailing.arrival_port);
        const key = `${departurePort}\u0000${arrivalPort == null ? '' : arrivalPort}`;
        const day = isoDateOnly(departureDate);
        const existing = groups.get(key);
        if (existing) {
            existing.sailingCount += 1;
            if (day < existing.firstDeparture) existing.firstDeparture = day;
            if (day > existing.lastDeparture) existing.lastDeparture = day;
        } else {
            groups.set(key, {
                departurePort: resolver.resolve(departurePort || null),
                arrivalPort: arrivalPort == null ? null : resolver.resolve(arrivalPort),
                firstDeparture: day,
                lastDeparture: day,
                sailingCount: 1
            });
        }
    }
    const sorted = [...groups.values()].sort((left, right) => (
        compareText(left.departurePort.value, right.departurePort.value)
        || compareText(left.arrivalPort && left.arrivalPort.value, right.arrivalPort && right.arrivalPort.value)
        || compareText(left.firstDeparture, right.firstDeparture)
        || compareText(left.lastDeparture, right.lastDeparture)
    ));
    return paginate(sorted, query.page, query.pageSize);
}

function expirationRank(value) {
    const date = parseStoredDateOnly(value);
    return date ? date.getTime() : Number.NEGATIVE_INFINITY;
}

function listPredictiveDateRanges(access, query) {
    const after = earliestDepartingAfter();
    const records = latestPredictiveRateRecords(store.getRatesByOwner(access.companyRecordId)).filter(record => {
        const fields = record.fields;
        return matchesFilter(fields['Origin Port'], query.originPort)
            && matchesFilter(fields['Destination Port/Via Port'], query.destinationPort);
    });
    const groups = new Map();
    for (const record of records) {
        const fields = record.fields;
        const originPort = storedText(fields['Origin Port']);
        const destinationPort = storedText(fields['Destination Port/Via Port']);
        const key = `${originPort}\u0000${destinationPort}`;
        const expiration = storedText(fields['Rate Expiration Date']);
        const existing = groups.get(key);
        if (existing) {
            if (expirationRank(expiration) > expirationRank(existing.baseRateExpiration)) {
                existing.baseRateExpiration = expiration;
            }
        } else {
            groups.set(key, {
                originPort,
                destinationPort,
                earliestDepartingAfter: after,
                latestDepartingAfter: null,
                baseRateExpiration: expiration
            });
        }
    }
    const rows = [...groups.values()].sort((left, right) => (
        compareText(left.originPort, right.originPort)
        || compareText(left.destinationPort, right.destinationPort)
        || compareText(left.earliestDepartingAfter, right.earliestDepartingAfter)
    ));
    return paginate(rows, query.page, query.pageSize);
}

module.exports = {
    CURRENT_RATE_NOTICE,
    listRateDateRanges,
    listValidOriginPorts,
    listValidDestinationPorts,
    listValidContractOwners,
    listSailingDateRanges,
    listPredictiveDateRanges,
    earliestDepartingAfter,
    parseStoredDateOnly
};
