'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { customerPrice, storedMarginPercent, displayedMarginPercent } = require('../lib/pricing');
const { calculateRate } = require('../lib/domain');

describe('customerPrice', () => {
    it('prices 1000 at 10% plus 25 as 1125 for a fraction and a whole percent', () => {
        assert.equal(customerPrice(1000, { marginPercent: 0.1, marginNumber: 25 }), 1125);
        assert.equal(customerPrice(1000, { marginPercent: 10, marginNumber: 25 }), 1125);
        assert.equal(calculateRate(1000, { fields: { MarginPercent: 0.1, MarginNumber: 25 } }), 1125);
        assert.equal(calculateRate(1000, { fields: { MarginPercent: 10, MarginNumber: 25 } }), 1125);
    });

    it('keeps a zero margin on the rounded base and treats a stored 1 as 100%', () => {
        assert.equal(customerPrice(1000, { marginPercent: 0, marginNumber: 0 }), 1000);
        assert.equal(customerPrice(1000.4, { marginPercent: 0, marginNumber: 0 }), 1000);
        assert.equal(customerPrice(1000, { marginPercent: 1, marginNumber: 0 }), 2000);
        assert.equal(calculateRate(1000.6, { fields: { MarginPercent: 0.1, MarginNumber: 0 } }), 1101);
    });

    it('stores a whole percent from the UI as a fraction through 100 and shows a whole percent', () => {
        assert.equal(storedMarginPercent(10), 0.1);
        assert.equal(storedMarginPercent(100), 1);
        assert.equal(storedMarginPercent(0), 0);
        assert.equal(storedMarginPercent(150), 150);
        assert.equal(displayedMarginPercent(0.1), 10);
        assert.equal(displayedMarginPercent(10), 10);
        assert.equal(displayedMarginPercent(1), 100);
        assert.equal(displayedMarginPercent(0), 0);
        assert.equal(customerPrice(1000, { marginPercent: storedMarginPercent(10), marginNumber: 25 }), 1125);
    });
});
