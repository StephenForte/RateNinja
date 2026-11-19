'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { leaksBasePrice } = require('./helpers/no-base-price');

const BASE = 8123;
const FLAKE_ID = 'r101-f6e688279038123e';
const UUID_WITH_BASE = 'aaaaaaaa-bbbb-8123-cccc-dddddddddddd';

describe('r1-39 base-price leak check', () => {
    it('flags a number equal to the base at any depth, in an array, and in nested JSON', () => {
        assert.equal(leaksBasePrice(BASE, BASE), true);
        assert.equal(leaksBasePrice({ outer: { price: BASE } }, BASE), true);
        assert.equal(leaksBasePrice({ rows: [1, BASE, 3] }, BASE), true);
        const detail = JSON.stringify({
            requestId: UUID_WITH_BASE,
            rateId: FLAKE_ID,
            customerPrice: BASE,
            notes: 'kept'
        });
        assert.equal(leaksBasePrice(detail, BASE), true);
        assert.equal(leaksBasePrice({ audit: { detail } }, BASE), true);
    });

    it('flags the base as a standalone number, including the UI grouped spellings', () => {
        for (const note of ['8123', '8123.00', 'USD 8123', 'price 8123 per box', '8,123', '$8,123', '$8,123.00']) {
            assert.equal(leaksBasePrice({ notes: note }, BASE), true, note);
        }
        const detail = JSON.stringify({
            requestId: UUID_WITH_BASE,
            notes: 'price 8123 per box'
        });
        assert.equal(leaksBasePrice(detail, BASE), true);
    });

    it('does not flag digits embedded in ids, larger numbers, or letter-glued tokens', () => {
        assert.equal(leaksBasePrice({ decidedBy: { id: FLAKE_ID, name: 'book-owner-a' } }, BASE), false);
        assert.equal(leaksBasePrice({ notes: FLAKE_ID }, BASE), false);
        assert.equal(leaksBasePrice({ id: UUID_WITH_BASE }, BASE), false);
        assert.equal(leaksBasePrice({ requestId: UUID_WITH_BASE }, BASE), false);
        assert.equal(leaksBasePrice({ owner_company_id: UUID_WITH_BASE }, BASE), false);
        assert.equal(leaksBasePrice({ n: 18123 }, BASE), false);
        assert.equal(leaksBasePrice({ n: 81234 }, BASE), false);
        assert.equal(leaksBasePrice({ notes: 'A8123B' }, BASE), false);
        assert.equal(leaksBasePrice({ notes: '18123' }, BASE), false);
        assert.equal(leaksBasePrice({ notes: '81234' }, BASE), false);
        assert.equal(leaksBasePrice({ notes: '8,123,456' }, BASE), false);
        const cleanAudit = JSON.stringify({
            requestId: UUID_WITH_BASE,
            ownerCompanyId: FLAKE_ID,
            customerPrice: 8935,
            notes: 'A8123B'
        });
        assert.equal(leaksBasePrice(cleanAudit, BASE), false);
    });

    it('still flags an exact numeric match under an id key', () => {
        assert.equal(leaksBasePrice({ id: BASE }, BASE), true);
        assert.equal(leaksBasePrice({ rateId: BASE }, BASE), true);
        assert.equal(leaksBasePrice({ owner_company_id: BASE }, BASE), true);
        assert.equal(leaksBasePrice({ id: '8123' }, BASE), true);
    });
});
