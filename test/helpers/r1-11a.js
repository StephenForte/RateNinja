'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'imports');

const RATE_MAPPING = [
    ['Rate Type', 'rateType'],
    ['Origin Port', 'originPort'],
    ['Destination Port/Via Port', 'destinationPort'],
    ['Inland Delivery Location', 'inlandDeliveryLocation'],
    ['Carrier', 'carrier'],
    ['Contract Number', 'contractNumber'],
    ['Contract Owner', 'contractOwner'],
    ['20D Rate', 'rate20D'],
    ['40D rate', 'rate40D'],
    ['40HC Rate', 'rate40HC'],
    ['Validity', null],
    ['Effective Date', 'rateEffectiveDate'],
    ['Expiry Date', 'rateExpirationDate'],
    ['Notes 1', 'notes1'],
    ['Notes 2', null],
    ['Notes 3', null],
    ['Note 4', null]
].map(([source, target]) => ({ source, target }));

const SAILING_MAPPING = [
    ['Transit Time', 'transitTime'],
    ['Carrier', 'carrier'],
    ['Departure', 'departure'],
    ['Arrival', 'arrival'],
    ['Departure Port', 'departurePort'],
    ['Arrival Port', 'arrivalPort'],
    ['Voyage', 'voyage'],
    ['Service', 'service'],
    ['Vessel', 'vessel']
].map(([source, target]) => ({ source, target }));

async function readJson(response) {
    const text = await response.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = { error: text };
        }
    }
    return { status: response.status, body, text };
}

async function uploadFile(app, filename, dataset) {
    const body = fs.readFileSync(path.join(FIXTURES, filename));
    const response = await app.request('/api/admin/imports/uploads', {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-import-filename': filename,
            'x-import-dataset': dataset
        },
        body
    });
    return readJson(response);
}

function importBody(app, extra) {
    return {
        companyId: app.company.id,
        ...extra
    };
}

module.exports = {
    FIXTURES,
    RATE_MAPPING,
    SAILING_MAPPING,
    readJson,
    uploadFile,
    importBody
};
