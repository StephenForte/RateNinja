const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeValue,
    sameValue,
    calculateRate,
    mapRateRecord,
    mapPredictiveRateRecord,
    parsePageNumber,
    matchesSearch,
    parseDateOnly,
    validatePullForwardRange,
    shiftDateOnly,
    shiftDateTime,
    calculatePredictiveRate,
    latestPredictiveRateRecords,
    rateVisibleToView
} = require('../lib/domain');

function utcDateOffset(days) {
    const today = new Date();
    const utc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days);
    return new Date(utc).toISOString().slice(0, 10);
}

describe('normalizeValue / sameValue', () => {
    it('joins arrays and applies fallbacks', () => {
        assert.equal(normalizeValue(['A', 'B']), 'A, B');
        assert.equal(normalizeValue([]), 'N/A');
        assert.equal(normalizeValue(null), 'N/A');
        assert.equal(normalizeValue(undefined, ''), '');
    });

    it('compares values as strings', () => {
        assert.equal(sameValue(1, '1'), true);
        assert.equal(sameValue(null, ''), true);
        assert.equal(sameValue('a', 'b'), false);
    });
});

describe('calculateRate', () => {
    it('returns rounded base rate for admins and missing companies', () => {
        assert.equal(calculateRate(100.4, null), 100);
        assert.equal(calculateRate(100, { fields: { Admin: true, MarginPercent: 0.1 } }), 100);
    });

    it('applies fractional and whole-number percent margins plus fixed margin', () => {
        assert.equal(calculateRate(1000, { fields: { MarginPercent: 0.1, MarginNumber: 25 } }), 1125);
        assert.equal(calculateRate(1000, { fields: { MarginPercent: 10, MarginNumber: 0 } }), 1100);
    });
});

describe('mapRateRecord / mapPredictiveRateRecord', () => {
    const record = {
        id: 'rec1',
        fields: {
            'Rate Type': 'Spot',
            'Origin Port': 'SHA',
            'Destination Port/Via Port': 'LAX',
            Carrier: 'MSC',
            'Contract Owner': 'Acme',
            '20D Rate': 1000,
            '40D rate': 2000,
            '40HC Rate': 2100,
            'Rate Effective Date': '2026-01-01',
            'Rate Expiration Date': '2026-02-01',
            'Notes 1': 'note'
        }
    };

    it('maps fields and applies company margin', () => {
        const mapped = mapRateRecord(record, { fields: { MarginPercent: 0.1, MarginNumber: 0 } });
        assert.equal(mapped.carrier, 'MSC');
        assert.equal(mapped.rate20D, 1100);
        assert.equal(mapped.rate40D, 2200);
    });

    it('builds predictive rows with forecast then margin', () => {
        // 2 full 30-day periods => +10%, then +10% company margin on 1000 => 1210
        const mapped = mapPredictiveRateRecord(record, { fields: { MarginPercent: 0.1, MarginNumber: 0 } }, 2, '2026-09-01');
        assert.equal(mapped.rateEffectiveDate, '2026-09-01');
        assert.equal(mapped.rateExpirationDate, 'N/A');
        assert.equal(mapped.predictive, true);
        assert.equal(mapped.rate20D, 1210);
    });
});

describe('calculatePredictiveRate', () => {
    it('applies 5% per full thirty-day period', () => {
        assert.equal(calculatePredictiveRate(1000, 0), 1000);
        assert.equal(calculatePredictiveRate(1000, 1), 1050);
        assert.equal(calculatePredictiveRate(1000, 3), 1150);
    });
});

describe('latestPredictiveRateRecords', () => {
    it('keeps the latest-expiring record per route and optional filters', () => {
        const records = [
            { id: 'a', fields: { Carrier: 'MSC', 'Origin Port': 'SHA', 'Destination Port/Via Port': 'LAX', Arrival: '', 'Rate Expiration Date': '2026-01-01' } },
            { id: 'b', fields: { Carrier: 'MSC', 'Origin Port': 'SHA', 'Destination Port/Via Port': 'LAX', Arrival: '', 'Rate Expiration Date': '2026-06-01' } },
            { id: 'c', fields: { Carrier: 'CMA', 'Origin Port': 'SHA', 'Destination Port/Via Port': 'LAX', Arrival: '', 'Rate Expiration Date': '2026-12-01' } }
        ];
        const all = latestPredictiveRateRecords(records);
        assert.deepEqual(all.map(r => r.id).sort(), ['b', 'c']);

        const filtered = latestPredictiveRateRecords(records, 'MSC', 'SHA');
        assert.deepEqual(filtered.map(r => r.id), ['b']);
    });
});

describe('rateVisibleToView', () => {
    it('matches single and multi-value RateView entries', () => {
        assert.equal(rateVisibleToView({ fields: { RateView: '1.0' } }, '1.0'), true);
        assert.equal(rateVisibleToView({ fields: { RateView: ['1.0', '2.0'] } }, '2.0'), true);
        assert.equal(rateVisibleToView({ fields: { RateView: ['1.0'] } }, '2.0'), false);
    });
});

describe('parse helpers', () => {
    it('parses page numbers and search matches', () => {
        assert.equal(parsePageNumber('3', 1, 10), 3);
        assert.equal(parsePageNumber('0', 1, 10), 1);
        assert.equal(parsePageNumber('99', 1, 10), 10);
        assert.equal(matchesSearch('Los Angeles', 'angeles'), true);
        assert.equal(matchesSearch('SHA', 'lax'), false);
        assert.equal(matchesSearch('SHA', ''), true);
    });

    it('accepts only valid YYYY-MM-DD dates', () => {
        assert.ok(parseDateOnly('2026-07-19'));
        assert.equal(parseDateOnly('2026-13-01'), null);
        assert.equal(parseDateOnly('07/19/2026'), null);
    });
});

describe('date shifting', () => {
    it('shifts date-only and datetime values', () => {
        assert.equal(shiftDateOnly('2026-01-31', 1), '2026-02-01');
        assert.equal(shiftDateOnly(null, 5), null);
        assert.equal(shiftDateTime('2026-01-31T08:30:00Z', 1), '2026-02-01T08:30:00Z');
        assert.equal(shiftDateTime('not-a-date', 1), 'not-a-date');
    });
});

describe('validatePullForwardRange', () => {
    it('rejects invalid shapes and unequal lengths', () => {
        assert.match(validatePullForwardRange({}).error, /valid YYYY-MM-DD/);
        assert.match(validatePullForwardRange({
            sourceStart: '2026-01-10',
            sourceEnd: '2026-01-01',
            targetStart: '2026-02-01',
            targetEnd: '2026-02-01'
        }).error, /Source start/);
        assert.match(validatePullForwardRange({
            sourceStart: '2026-01-01',
            sourceEnd: '2026-01-07',
            targetStart: '2026-02-01',
            targetEnd: '2026-02-02'
        }).error, /equal source range length/);
    });

    it('rejects targets that start too early or end beyond 90 days', () => {
        assert.match(validatePullForwardRange({
            sourceStart: '2026-01-01',
            sourceEnd: '2026-01-01',
            targetStart: '2026-01-01',
            targetEnd: '2026-01-01'
        }).error, /after the source range/);
        assert.match(validatePullForwardRange({
            sourceStart: utcDateOffset(-200),
            sourceEnd: utcDateOffset(-200),
            targetStart: utcDateOffset(100),
            targetEnd: utcDateOffset(100)
        }).error, /within 90 days/);
    });

    it('returns offsetDays for a valid same-length future range', () => {
        const sourceStart = utcDateOffset(-30);
        const sourceEnd = utcDateOffset(-23);
        const targetStart = utcDateOffset(10);
        const targetEnd = utcDateOffset(17);
        const result = validatePullForwardRange({ sourceStart, sourceEnd, targetStart, targetEnd });
        assert.equal(result.error, undefined);
        assert.equal(result.offsetDays, 40);
    });
});
