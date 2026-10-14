'use strict';

// Apple Numbers is not an import format (D-024). Other types get the same refusal.
const UNSUPPORTED_MESSAGE = 'Apple Numbers files are not supported. Export the file to Excel (.xlsx). Round 1 imports accept CSV and Excel (.xlsx) only.';

class ImportError extends Error {
    constructor(status, code, message, extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

const RATE_TARGETS = [
    { id: 'rateType', label: 'Rate type', required: false, kind: 'text' },
    { id: 'originPort', label: 'Origin port', required: true, kind: 'text' },
    { id: 'destinationPort', label: 'Destination port', required: true, kind: 'text' },
    { id: 'inlandDeliveryLocation', label: 'Inland delivery location', required: false, kind: 'text' },
    { id: 'commodityType', label: 'Commodity type', required: false, kind: 'text' },
    { id: 'carrier', label: 'Carrier', required: true, kind: 'text' },
    { id: 'contractOwner', label: 'Contract owner', required: false, kind: 'text' },
    { id: 'contractNumber', label: 'Contract number', required: false, kind: 'text' },
    { id: 'rate20D', label: '20D rate (USD)', required: false, kind: 'price' },
    { id: 'rate40D', label: '40D rate (USD)', required: false, kind: 'price' },
    { id: 'rate40HC', label: '40HC rate (USD)', required: false, kind: 'price' },
    { id: 'rateEffectiveDate', label: 'Effective date', required: true, kind: 'date' },
    { id: 'rateExpirationDate', label: 'Expiration date', required: true, kind: 'date' },
    { id: 'notes1', label: 'Notes', required: false, kind: 'text' }
];

const SAILING_TARGETS = [
    { id: 'carrier', label: 'Carrier', required: true, kind: 'text' },
    { id: 'departurePort', label: 'Departure port', required: true, kind: 'text' },
    { id: 'arrivalPort', label: 'Arrival port', required: false, kind: 'text' },
    { id: 'departure', label: 'Departure', required: true, kind: 'date' },
    { id: 'arrival', label: 'Arrival', required: false, kind: 'date' },
    { id: 'transitTime', label: 'Transit time', required: false, kind: 'text' },
    { id: 'vessel', label: 'Vessel', required: false, kind: 'text' },
    { id: 'voyage', label: 'Voyage', required: false, kind: 'text' },
    { id: 'service', label: 'Service', required: false, kind: 'text' }
];

const PRICE_TARGETS = ['rate20D', 'rate40D', 'rate40HC'];
const NOTE_APPEND = ['Notes 2', 'Notes 3', 'Note 4'];
const FORBIDDEN_TARGETS = new Set([
    'id',
    'owner_company_id',
    'ownerCompanyId',
    'deleted_at',
    'deletedAt',
    'deleted_operation_id',
    'deletedOperationId',
    'row_version',
    'rowVersion',
    'rateView'
]);

function targetsFor(dataset) {
    if (dataset === 'rates') return RATE_TARGETS;
    if (dataset === 'sailings') return SAILING_TARGETS;
    return [];
}

function targetIds(dataset) {
    return new Set(targetsFor(dataset).map(target => target.id));
}

module.exports = {
    UNSUPPORTED_MESSAGE,
    ImportError,
    RATE_TARGETS,
    SAILING_TARGETS,
    PRICE_TARGETS,
    NOTE_APPEND,
    FORBIDDEN_TARGETS,
    targetsFor,
    targetIds
};
