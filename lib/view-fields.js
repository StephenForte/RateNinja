'use strict';

const { MAX_GROUP_FIELDS, MAX_SORT_RULES } = require('./limits');

// The rate columns rendered on the Rates table. Clients may hide, reorder,
// group, and sort only these ids. contractNumber is hidden until a view shows it.
const FIELDS = Object.freeze([
    { id: 'rateType', label: 'Rate Type', shortLabel: 'Type', groupable: true, sortable: true, type: 'text' },
    { id: 'originPort', label: 'Origin Port', shortLabel: 'Origin', groupable: true, sortable: true, type: 'text' },
    { id: 'destinationPort', label: 'Destination Port/Via Port', shortLabel: 'Destination', groupable: true, sortable: true, type: 'text' },
    { id: 'inlandDeliveryLocation', label: 'Inland Delivery Location', shortLabel: 'Inland', groupable: true, sortable: true, type: 'text' },
    { id: 'commodityType', label: 'Commodity Type', shortLabel: 'Commodity', groupable: true, sortable: true, type: 'text' },
    { id: 'carrier', label: 'Carrier', shortLabel: 'Carrier', groupable: true, sortable: true, type: 'text' },
    { id: 'contractOwner', label: 'Contract Owner', shortLabel: 'Owner', groupable: true, sortable: true, type: 'text' },
    { id: 'contractNumber', label: 'Contract Number', shortLabel: 'Contract', groupable: true, sortable: true, type: 'text', defaultHidden: true },
    { id: 'rate20D', label: '20D Rate (USD)', shortLabel: "20'", groupable: true, sortable: true, type: 'number' },
    { id: 'rate40D', label: '40D Rate (USD)', shortLabel: "40'", groupable: true, sortable: true, type: 'number' },
    { id: 'rate40HC', label: '40HC Rate (USD)', shortLabel: "40HC", groupable: true, sortable: true, type: 'number' },
    { id: 'rateEffectiveDate', label: 'Rate Effective Date', shortLabel: 'Effective', groupable: true, sortable: true, type: 'date' },
    { id: 'rateExpirationDate', label: 'Rate Expiration Date', shortLabel: 'Expiration', groupable: true, sortable: true, type: 'date' },
    { id: 'notes1', label: 'Notes 1', shortLabel: 'Notes', groupable: true, sortable: true, type: 'text' }
]);

const PAGE_SIZES = Object.freeze([20, 50, 100]);
const CONFIG_VERSION = 1;
const QUERY_KEYS = Object.freeze(['search', 'carrier', 'originPort', 'destinationPort', 'contractOwner']);

const byId = new Map(FIELDS.map(field => [field.id, field]));

function catalog() {
    return {
        fields: FIELDS.map(field => ({ ...field })),
        pageSizes: PAGE_SIZES.slice(),
        maxGroupFields: MAX_GROUP_FIELDS,
        maxSortRules: MAX_SORT_RULES,
        configVersion: CONFIG_VERSION
    };
}

function fieldById(id) {
    return byId.get(id) || null;
}

module.exports = {
    FIELDS,
    PAGE_SIZES,
    CONFIG_VERSION,
    QUERY_KEYS,
    catalog,
    fieldById
};
