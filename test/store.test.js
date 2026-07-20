const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-test-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.SQLITE_DB_PATH = dbPath;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { db, dbPath: openedPath } = require('../lib/db');
const store = require('../lib/store');

function insertRate(row) {
    db.prepare(`
        INSERT INTO rates (
            id, rate_type, origin_port, destination_port, inland_delivery_location,
            commodity_type, carrier, contract_owner, rate_20d, rate_40d, rate_40hc,
            rate_effective_date, rate_expiration_date, notes_1, rate_view
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.id,
        row.rate_type ?? 'Spot',
        row.origin_port ?? 'SHA',
        row.destination_port ?? 'LAX',
        row.inland_delivery_location ?? null,
        row.commodity_type ?? null,
        row.carrier ?? 'MSC',
        row.contract_owner ?? 'Acme',
        row.rate_20d ?? 1000,
        row.rate_40d ?? 2000,
        row.rate_40hc ?? 2100,
        row.rate_effective_date,
        row.rate_expiration_date ?? null,
        row.notes_1 ?? null,
        row.rate_view ?? '1.0'
    );
}

function insertCompany(row) {
    db.prepare(`
        INSERT INTO companies (
            id, company_id, company_name, company_type, rate_view, admin, margin_percent, margin_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.id,
        row.company_id,
        row.company_name ?? 'Test Co',
        row.company_type ?? 'Customer',
        row.rate_view ?? '1.0',
        row.admin ?? 0,
        row.margin_percent ?? 0.1,
        row.margin_number ?? 0
    );
}

function insertSailing(row) {
    db.prepare(`
        INSERT INTO sailings (
            id, departure, arrival, transit_time, vessel, voyage, service, carrier, departure_port
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.id,
        row.departure,
        row.arrival ?? null,
        row.transit_time ?? '14',
        row.vessel ?? 'Ship',
        row.voyage ?? '001E',
        row.service ?? 'AE1',
        row.carrier ?? 'MSC',
        row.departure_port ?? 'SHA'
    );
}

function insertUser(row) {
    db.prepare(`
        INSERT INTO users (
            id, username, pwd, display_name, rate_view, company_id, company_reference, admin_screen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.id,
        row.username,
        row.pwd ?? 'secret',
        row.display_name ?? row.username,
        row.rate_view ?? '1.0',
        row.company_id ?? '1.0',
        row.company_reference ?? null,
        row.admin_screen ?? 0
    );
}

describe('store layer', () => {
    before(() => {
        assert.equal(openedPath, dbPath);
        insertCompany({ id: 'co1', company_id: '1.0', company_name: 'Kings', rate_view: '1.0' });
        insertCompany({ id: 'co2', company_id: '2.0', company_name: 'Other', rate_view: '2.0' });
        insertUser({ id: 'u1', username: 'admin', admin_screen: 1, company_id: '1.0' });
        insertRate({
            id: 'r1',
            carrier: 'MSC',
            origin_port: 'SHA',
            destination_port: 'LAX',
            rate_effective_date: '2025-10-06',
            rate_expiration_date: '2025-11-06',
            rate_20d: 1000,
            rate_view: '1.0'
        });
        insertRate({
            id: 'r2',
            carrier: 'CMA',
            origin_port: 'NGP',
            destination_port: 'NYC',
            rate_effective_date: '2025-10-06',
            rate_20d: 1500,
            rate_view: '2.0'
        });
        insertRate({
            id: 'r3',
            carrier: 'MSC',
            origin_port: 'SHA',
            destination_port: 'OAK',
            rate_effective_date: '2025-10-06',
            rate_20d: 1100,
            rate_view: '1.0, 2.0'
        });
        insertSailing({
            id: 's1',
            departure: '2025-10-10T08:00:00.000Z',
            arrival: '2025-10-24T08:00:00.000Z',
            carrier: 'MSC',
            departure_port: 'SHA'
        });
        insertSailing({
            id: 's2',
            departure: '2025-09-01T08:00:00.000Z',
            carrier: 'MSC',
            departure_port: 'SHA'
        });
    });

    after(() => {
        try {
            db.close();
        } catch {
            // ignore close errors on experimental sqlite
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('looks up users and companies by natural keys', () => {
        const user = store.getUserByUsername('admin');
        assert.equal(user.fields.UserName, 'admin');
        assert.equal(user.fields.AdminScreen, true);

        const company = store.getCompanyByCompanyId('1.0');
        assert.equal(company.fields.CompanyName, 'Kings');
        assert.equal(store.getCompanyByCompanyId('missing'), null);
    });

    it('filters rates by RateView including comma-joined multi values', () => {
        const view1 = store.getRatesForView('1.0');
        assert.deepEqual(view1.map(r => r.id).sort(), ['r1', 'r3']);
        const view2 = store.getRatesForView('2.0');
        assert.deepEqual(view2.map(r => r.id).sort(), ['r2', 'r3']);
    });

    it('filters rates by carrier and origin', () => {
        const rows = store.getRatesByCarrierOrigin('MSC', 'SHA');
        assert.deepEqual(rows.map(r => r.id).sort(), ['r1', 'r3']);
    });

    it('paginates public rate search in SQL', () => {
        const page = store.queryPublicRates({ carrier: 'MSC', page: 1, pageSize: 1 });
        assert.equal(page.total, 2);
        assert.equal(page.rates.length, 1);
        assert.equal(page.rates[0].fields.Carrier, 'MSC');
    });

    it('returns sailings after a departure date', () => {
        const sailings = store.getSailings({ carrier: 'MSC', originPort: 'SHA', after: '2025-10-01' });
        assert.equal(sailings.length, 1);
        assert.match(sailings[0].departure, /^2025-10-10/);
    });

    it('updates company margins', () => {
        store.updateCompanyMargins('co1', { marginPercent: 0.2, marginNumber: 15 });
        const company = store.getCompanyByRecordId('co1');
        assert.equal(company.fields.MarginPercent, 0.2);
        assert.equal(company.fields.MarginNumber, 15);
    });

    it('pulls rates forward with price increase and optional delete', () => {
        const first = store.pullForwardRates({
            sourceStart: '2025-10-06',
            sourceEnd: '2025-10-06',
            targetStart: '2026-01-06',
            targetEnd: '2026-01-06',
            offsetDays: 92,
            priceIncreasePercent: 10,
            deleteExisting: false
        });
        assert.equal(first.copied, 3);
        assert.equal(first.deleted, 0);

        const copied = store.getRatesForView('1.0').filter(r => r.fields['Rate Effective Date'] === '2026-01-06');
        assert.ok(copied.length >= 2);
        assert.equal(copied.find(r => r.fields.Carrier === 'MSC' && r.fields['Destination Port/Via Port'] === 'LAX').fields['20D Rate'], 1100);

        const second = store.pullForwardRates({
            sourceStart: '2025-10-06',
            sourceEnd: '2025-10-06',
            targetStart: '2026-01-06',
            targetEnd: '2026-01-06',
            offsetDays: 92,
            priceIncreasePercent: 0,
            deleteExisting: true
        });
        assert.equal(second.deleted, 3);
        assert.equal(second.copied, 3);
    });

    it('pulls sailings forward and preserves time-of-day', () => {
        const result = store.pullForwardSailings({
            sourceStart: '2025-10-10',
            sourceEnd: '2025-10-10',
            targetStart: '2026-01-10',
            targetEnd: '2026-01-10',
            offsetDays: 92,
            deleteExisting: false
        });
        assert.equal(result.copied, 1);
        const sailings = store.getSailings({ carrier: 'MSC', originPort: 'SHA', after: '2026-01-01' });
        assert.equal(sailings.length, 1);
        assert.equal(sailings[0].departure, '2026-01-10T08:00:00.000Z');
    });
});
