const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS } = require('../lib/view-fields');
const { MAX_GROUP_FIELDS, MAX_SORT_RULES } = require('../lib/limits');

let grouping;

before(async () => {
    grouping = await import('../public/js/rates/grouping.js');
});

function rate(id, extras = {}) {
    return {
        id,
        rateType: 'Spot',
        originPort: 'SHA',
        destinationPort: 'LAX',
        inlandDeliveryLocation: '',
        commodityType: 'General',
        carrier: 'MSC',
        contractOwner: 'Kings',
        rate20D: 100,
        rate40D: 200,
        rate40HC: 220,
        rateEffectiveDate: '2026-04-01',
        rateExpirationDate: '2026-12-01',
        notes1: '',
        ...extras
    };
}

describe('r1-05 grouping, sort, and query application', () => {
    it('keeps the client field list identical to the server allowlist', () => {
        assert.deepEqual(grouping.RATE_FIELDS, FIELDS);
        assert.equal(FIELDS.length, 13);
        assert.equal(MAX_GROUP_FIELDS, 2);
        assert.equal(MAX_SORT_RULES, 3);
    });

    it('computes group counts from the whole filtered set, not the page', () => {
        const rates = [];
        for (let index = 0; index < 30; index += 1) rates.push(rate(`m${String(index).padStart(2, '0')}`, { carrier: 'MSC' }));
        for (let index = 0; index < 10; index += 1) rates.push(rate(`c${index}`, { carrier: 'CMA' }));
        const grouped = grouping.groupRates(rates, ['carrier']);
        const counts = Object.fromEntries(grouped.groups.map(group => [group.label, group.count]));
        assert.deepEqual(counts, { CMA: 10, MSC: 30 });
        assert.equal(grouped.total, 40);

        const page1 = grouping.layoutPage(rates, { groupBy: ['carrier'], page: 1, pageSize: 20 });
        const page2 = grouping.layoutPage(rates, { groupBy: ['carrier'], page: 2, pageSize: 20 });
        const mscOnFirst = page1.items.find(item => item.type === 'header' && item.label === 'MSC');
        const mscOnSecond = page2.items.find(item => item.type === 'header' && item.label === 'MSC');
        assert.equal(mscOnFirst.count, 30);
        assert.equal(mscOnFirst.continued, false);
        assert.equal(page1.items.filter(item => item.type === 'row' && item.rate.carrier === 'MSC').length, 10);
        assert.equal(mscOnSecond.count, 30);
        assert.equal(mscOnSecond.continued, true);
        assert.equal(grouping.headerText(mscOnSecond), 'MSC (continued)');
        assert.equal(page2.items.filter(item => item.type === 'row').length, 20);
        assert.equal(page1.matchedTotal, 40);
        assert.equal(page2.matchedTotal, 40);
    });

    it('repeats a nested header when that group crosses a page', () => {
        const rates = [];
        for (let index = 0; index < 25; index += 1) rates.push(rate(`s${String(index).padStart(2, '0')}`, { carrier: 'MSC', originPort: 'SHA' }));
        for (let index = 0; index < 10; index += 1) rates.push(rate(`n${index}`, { carrier: 'MSC', originPort: 'NGB' }));
        const page1 = grouping.layoutPage(rates, { groupBy: ['carrier', 'originPort'], page: 1, pageSize: 20 });
        const page2 = grouping.layoutPage(rates, { groupBy: ['carrier', 'originPort'], page: 2, pageSize: 20 });
        const sha = page2.items.find(item => item.type === 'header' && item.label === 'SHA');
        const carrier = page2.items.find(item => item.type === 'header' && item.label === 'MSC');
        assert.equal(sha.count, 25);
        assert.equal(sha.continued, true);
        assert.equal(grouping.headerText(sha), 'SHA (continued)');
        assert.equal(carrier.continued, true);
        assert.equal(carrier.count, 35);
    });

    it('leaves group counts and the matched total unchanged when a group is collapsed', () => {
        const rates = [];
        for (let index = 0; index < 30; index += 1) rates.push(rate(`m${index}`, { carrier: 'MSC' }));
        for (let index = 0; index < 10; index += 1) rates.push(rate(`c${index}`, { carrier: 'CMA' }));
        const open = grouping.layoutPage(rates, { groupBy: ['carrier'], page: 1, pageSize: 100 });
        const header = open.items.find(item => item.type === 'header' && item.label === 'MSC');
        const closed = grouping.layoutPage(rates, {
            groupBy: ['carrier'],
            page: 1,
            pageSize: 100,
            collapsed: [header.pathKey]
        });
        const collapsedHeader = closed.items.find(item => item.type === 'header' && item.label === 'MSC');
        assert.equal(collapsedHeader.count, header.count);
        assert.equal(collapsedHeader.collapsed, true);
        assert.equal(closed.matchedTotal, open.matchedTotal);
        assert.equal(closed.matchedTotal, 40);
        assert.equal(closed.items.filter(item => item.type === 'row' && item.rate.carrier === 'MSC').length, 0);
        assert.equal(closed.items.filter(item => item.type === 'row' && item.rate.carrier === 'CMA').length, 10);
    });

    it('sorts missing values last and breaks ties on rate id', () => {
        const rates = [
            rate('b', { rate20D: null }),
            rate('a', { rate20D: 5 }),
            rate('d', { rate20D: 5 }),
            rate('c', { carrier: null, rate20D: 1 }),
            rate('e', { rate20D: 9 })
        ];
        assert.deepEqual(
            grouping.sortRates(rates, [{ field: 'rate20D', direction: 'asc' }]).map(item => item.id),
            ['c', 'a', 'd', 'e', 'b']
        );
        assert.deepEqual(
            grouping.sortRates(rates, [{ field: 'rate20D', direction: 'desc' }]).map(item => item.id),
            ['e', 'a', 'd', 'c', 'b']
        );
        const grouped = grouping.groupRates(rates, ['carrier'], grouping.RATE_FIELDS, [{ field: 'rate20D', direction: 'asc' }]);
        assert.deepEqual(grouped.groups.map(group => group.label), ['MSC', '(No value)']);
        assert.deepEqual(grouped.groups[0].rows.map(item => item.id), ['a', 'd', 'e', 'b']);
        assert.deepEqual(grouped.groups[1].rows.map(item => item.id), ['c']);
    });

    it('warns and returns no rows when a saved filter value is missing', () => {
        const rates = [rate('1', { carrier: 'MSC' }), rate('2', { carrier: 'CMA' })];
        const applied = grouping.applySavedQuery({
            criteria: { search: 'west', carrier: 'ZIM', originPort: '', destinationPort: '', contractOwner: '' },
            available: grouping.availableValues(rates),
            predictive: true,
            predictiveAfter: '2027-06-01'
        });
        assert.equal(applied.ok, false);
        assert.match(applied.warning, /ZIM/);
        assert.equal(applied.broadened, false);
        assert.equal(applied.criteria.carrier, 'ZIM');
        assert.deepEqual(grouping.ratesForAppliedQuery(rates, applied), []);
        const broadened = grouping.ratesForAppliedQuery(rates, {
            ok: true,
            criteria: { ...applied.criteria, carrier: '' }
        });
        assert.equal(broadened.length, rates.length);
    });

    it('applies a query on page 1 without changing predictive mode', () => {
        const applied = grouping.applySavedQuery({
            criteria: {
                search: 'sha',
                carrier: 'MSC',
                originPort: 'SHA',
                destinationPort: '',
                contractOwner: '',
                predictive: true,
                page: 4,
                rateEffectiveDate: '2020-01-01'
            },
            available: { carrier: ['MSC'], originPort: ['SHA'], destinationPort: [], contractOwner: [] },
            predictive: false,
            predictiveAfter: ''
        });
        assert.equal(applied.ok, true);
        assert.equal(applied.page, 1);
        assert.equal(applied.predictive, false);
        assert.equal(applied.predictiveAfter, '');
        assert.equal(applied.criteria.search, 'sha');
        assert.equal(Object.hasOwn(applied.criteria, 'predictive'), false);
        assert.equal(Object.hasOwn(applied.criteria, 'page'), false);
        assert.equal(Object.hasOwn(applied.criteria, 'rateEffectiveDate'), false);

        const kept = grouping.applySavedQuery({
            criteria: { search: '', carrier: 'MSC', originPort: '', destinationPort: '', contractOwner: '' },
            available: { carrier: ['MSC'], originPort: [], destinationPort: [], contractOwner: [] },
            predictive: true,
            predictiveAfter: '2027-06-01'
        });
        assert.equal(kept.page, 1);
        assert.equal(kept.predictive, true);
        assert.equal(kept.predictiveAfter, '2027-06-01');
    });

    it('summarises hidden columns, grouping, and sort rules', () => {
        const text = grouping.summarizeView({
            hiddenColumns: ['notes1', 'commodityType'],
            groupBy: ['carrier'],
            sort: [
                { field: 'rate20D', direction: 'desc' },
                { field: 'originPort', direction: 'asc' }
            ]
        });
        assert.equal(text, "2 hidden · grouped by Carrier · sorted by 20' ↓, Origin ↑");
        const nested = grouping.summarizeView({
            hiddenColumns: ['notes1', 'commodityType'],
            groupBy: ['carrier', 'originPort'],
            sort: [
                { field: 'rate20D', direction: 'desc' },
                { field: 'originPort', direction: 'asc' }
            ]
        });
        assert.equal(nested, "2 hidden · grouped by Carrier, then Origin · sorted by 20' ↓, Origin ↑");
    });
});
