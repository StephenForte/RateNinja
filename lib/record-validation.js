'use strict';

// Shared rate and sailing checks. R1-11a imports reuse this module.
// Missing container prices stay null. They are never stored as 0.

const { parseDateOnly } = require('./domain');

const RATE_FIELDS = [
    'rateType',
    'originPort',
    'destinationPort',
    'inlandDeliveryLocation',
    'commodityType',
    'carrier',
    'contractOwner',
    'contractNumber',
    'rate20D',
    'rate40D',
    'rate40HC',
    'rateEffectiveDate',
    'rateExpirationDate',
    'notes1',
    'rateView'
];

const SAILING_FIELDS = [
    'carrier',
    'departurePort',
    'arrivalPort',
    'departure',
    'arrival',
    'transitTime',
    'vessel',
    'voyage',
    'service'
];

function requiredText(value, field, errors) {
    if (typeof value !== 'string' || !value.trim()) {
        errors.push({ field, message: 'Required.' });
        return '';
    }
    return value.trim();
}

function optionalText(value, field, errors) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
        errors.push({ field, message: 'Must be text.' });
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}

function containerPrice(value, field, errors) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push({ field, message: 'Must be a finite non-negative number, or empty.' });
        return null;
    }
    return value;
}

function dateOnly(value, field, errors) {
    if (typeof value !== 'string' || !parseDateOnly(value)) {
        errors.push({ field, message: 'Must be a valid YYYY-MM-DD date.' });
        return '';
    }
    return value;
}

function timestamp(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
        return Number.isNaN(parsed) ? null : parsed;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
}

function validateRate(input) {
    const errors = [];
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (source !== input) errors.push({ field: 'record', message: 'Rate fields are required.' });
    const rate20D = containerPrice(source.rate20D, 'rate20D', errors);
    const rate40D = containerPrice(source.rate40D, 'rate40D', errors);
    const rate40HC = containerPrice(source.rate40HC, 'rate40HC', errors);
    if (rate20D === null && rate40D === null && rate40HC === null && !errors.some(error => ['rate20D', 'rate40D', 'rate40HC'].includes(error.field))) {
        errors.push({ field: 'rate20D', message: 'At least one container price is required.' });
    }
    const rateEffectiveDate = dateOnly(source.rateEffectiveDate, 'rateEffectiveDate', errors);
    const rateExpirationDate = dateOnly(source.rateExpirationDate, 'rateExpirationDate', errors);
    if (rateEffectiveDate && rateExpirationDate && rateExpirationDate < rateEffectiveDate) {
        errors.push({ field: 'rateExpirationDate', message: 'Expiration cannot precede the effective date.' });
    }
    const value = {
        rateType: optionalText(source.rateType, 'rateType', errors),
        originPort: requiredText(source.originPort, 'originPort', errors),
        destinationPort: requiredText(source.destinationPort, 'destinationPort', errors),
        inlandDeliveryLocation: optionalText(source.inlandDeliveryLocation, 'inlandDeliveryLocation', errors),
        commodityType: optionalText(source.commodityType, 'commodityType', errors),
        carrier: requiredText(source.carrier, 'carrier', errors),
        contractOwner: optionalText(source.contractOwner, 'contractOwner', errors),
        contractNumber: optionalText(source.contractNumber, 'contractNumber', errors),
        rate20D,
        rate40D,
        rate40HC,
        rateEffectiveDate,
        rateExpirationDate,
        notes1: optionalText(source.notes1, 'notes1', errors),
        rateView: optionalText(source.rateView, 'rateView', errors)
    };
    return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validateSailing(input) {
    const errors = [];
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (source !== input) errors.push({ field: 'record', message: 'Sailing fields are required.' });
    const departure = requiredText(source.departure, 'departure', errors);
    if (departure && timestamp(departure) === null) {
        errors.push({ field: 'departure', message: 'Must be a valid date or timestamp.' });
    }
    const arrival = optionalText(source.arrival, 'arrival', errors);
    if (arrival && timestamp(arrival) === null) {
        errors.push({ field: 'arrival', message: 'Must be a valid date or timestamp.' });
    }
    if (departure && arrival && timestamp(arrival) !== null && timestamp(departure) !== null && timestamp(arrival) < timestamp(departure)) {
        errors.push({ field: 'arrival', message: 'Arrival cannot precede departure.' });
    }
    const value = {
        carrier: requiredText(source.carrier, 'carrier', errors),
        departurePort: requiredText(source.departurePort, 'departurePort', errors),
        arrivalPort: optionalText(source.arrivalPort, 'arrivalPort', errors),
        departure,
        arrival,
        transitTime: optionalText(source.transitTime, 'transitTime', errors),
        vessel: optionalText(source.vessel, 'vessel', errors),
        voyage: optionalText(source.voyage, 'voyage', errors),
        service: optionalText(source.service, 'service', errors)
    };
    return errors.length ? { ok: false, errors } : { ok: true, value };
}

module.exports = {
    RATE_FIELDS,
    SAILING_FIELDS,
    validateRate,
    validateSailing
};
