'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { mountBookingRequests, walk } = require('./helpers/r1-51');

const TX = '0x8f3af98a3d2be38078f64d4ae85c6270ca5f3051f47ef5b2db07042107412f3b';
const HASH = '0x0a3bfcaf99fdd0eac1d1cacc9e0b064508f365f640a8fa5c1e50cb870fdc653c';
const CANONICAL = '{"carrier":"<script>alert(1)</script>","containerSize":"40HC","customerPrice":2468,"decidedAt":"2026-11-19T15:04:05.000Z","destinationPort":"USLAX","originPort":"CNSHA","rateId":"rate-r151-fixed","requestId":"r151-fixed-request","slots":3,"status":"approved","version":1}';

function listItem() {
    return {
        id: 'r151-fixed-request',
        status: 'approved',
        containerSize: '40HC',
        slots: 3,
        customerPrice: 2468,
        carrier: 'List Carrier',
        originPort: 'CNSHA',
        destinationPort: 'USLAX',
        side: 'customer',
        unread: false,
        receipt: {
            status: 'confirmed',
            txHash: TX,
            receiptHash: HASH,
            explorerUrl: `https://explorer.example/fortel2/tx/${TX}`
        }
    };
}

function payload(check) {
    return {
        fields: {
            requestId: 'r151-fixed-request',
            rateId: 'rate-r151-fixed',
            carrier: '<script>alert(1)</script>',
            originPort: 'CNSHA',
            destinationPort: 'USLAX',
            containerSize: '40HC',
            slots: 3,
            customerPrice: 2468,
            status: 'approved',
            decidedAt: '2026-11-19T15:04:05.000Z',
            version: 1
        },
        canonicalText: CANONICAL,
        receiptHash: HASH,
        txHash: TX,
        explorerUrl: `https://explorer.example/fortel2/tx/${TX}`,
        status: 'confirmed',
        check
    };
}

function button(container) {
    return walk(container).find(node => node.tag === 'button' && node.textContent === 'Receipt details');
}

function text(container, className) {
    return walk(container).find(node => node.className?.split(' ').includes(className))?.textContent;
}

async function open(t, check) {
    const page = await mountBookingRequests(t, [
        listItem(),
        { id: 'r151-pending', status: 'pending', carrier: 'Pending', originPort: 'A', destinationPort: 'B', containerSize: '20D', slots: 1, customerPrice: 1, side: 'customer' }
    ], () => Response.json(payload(check)));
    assert.equal(button(page).textContent, 'Receipt details');
    const pendingRow = walk(page).find(node => node.textContent === 'Pending');
    assert.equal(walk(pendingRow).find(node => node.tag === 'button'), undefined);
    const shortLink = walk(page).find(node => node.tag === 'a' && node.textContent === `${TX.slice(0, 10)}…${TX.slice(-6)}`);
    assert.equal(shortLink.href, `https://explorer.example/fortel2/tx/${TX}`);
    await button(page).events.click();
    return page;
}

it('renders receipt fields, canonical text and a verified check as text', async t => {
    const page = await open(t, { state: 'verified' });
    assert.equal(text(page, 'receipt-details-check'), 'Verified on ForteL2');
    assert.equal(text(page, 'receipt-canonical'), CANONICAL);
    const values = walk(page).filter(node => node.className === 'receipt-field-value').map(node => node.textContent);
    assert.deepEqual(values, [
        'r151-fixed-request', 'rate-r151-fixed', '<script>alert(1)</script>', 'CNSHA', 'USLAX',
        '40HC', '3', '2468', 'approved', '2026-11-19T15:04:05.000Z', '1'
    ]);
    assert.equal(walk(page).some(node => node.tag === 'script'), false);
    assert.equal(text(page, 'receipt-hash-value'), HASH);
    const full = walk(page).find(node => node.className === 'receipt-tx-value');
    assert.equal(full.textContent, TX);
    assert.equal(full.href, `https://explorer.example/fortel2/tx/${TX}`);
});

it('renders each ForteL2 check in plain words', async t => {
    const words = [
        [{ state: 'verified' }, 'Verified on ForteL2'],
        [{ state: 'mismatch', part: 'input' }, 'Mismatch: input'],
        [{ state: 'mismatch', part: 'sender' }, 'Mismatch: sender'],
        [{ state: 'mismatch', part: 'chain' }, 'Mismatch: chain'],
        [{ state: 'mismatch', part: 'status' }, 'Mismatch: status'],
        [{ state: 'mismatch', part: 'hash' }, 'Mismatch: hash'],
        [{ state: 'not_on_chain' }, 'Not on chain yet'],
        [{ state: 'unavailable' }, 'Could not check ForteL2']
    ];
    let current = words[0][0];
    const page = await mountBookingRequests(t, [listItem()], () => Response.json(payload(current)));
    for (const [check, phrase] of words) {
        current = check;
        await button(page).events.click();
        assert.equal(text(page, 'receipt-details-check'), phrase);
        assert.equal(text(page, 'receipt-canonical'), CANONICAL);
    }
});
