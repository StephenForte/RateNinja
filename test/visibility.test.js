const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-visibility-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'visibility.db');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const store = require('../lib/store');
const { appRates, listPartnerRates, listPartnerSailings } = require('../lib/visibility');

function insertCompany(row) {
    db.prepare(`
        INSERT INTO companies (id, company_id, company_name, company_type, company_type_id, rate_view, admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.id, row.name, row.type, row.typeId, row.id, row.admin ? 1 : 0);
}

function insertRate(row) {
    db.prepare(`
        INSERT INTO rates (
            id, carrier, origin_port, destination_port, contract_owner, rate_20d, rate_40d, rate_40hc,
            rate_effective_date, owner_company_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, 'MSC', 'SHA', 'LAX', row.contract || 'Contract', row.rate, row.rate, row.rate, '2026-04-01', row.owner);
}

describe('many-to-many margins', () => {
    after(() => {
        try {
            db.close();
        } catch {
            // The test database is temporary.
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('prices each contract owner margin separately and keeps partner reads on base data', () => {
        insertCompany({ id: 'kings', name: 'Kings', type: 'Contract Owner', typeId: 'contract_owner', admin: 1 });
        insertCompany({ id: 'joes', name: 'Joe Shipping', type: 'Contract Owner', typeId: 'contract_owner' });
        insertCompany({ id: 'blackwater', name: 'Blackwater Shippers', type: 'Freight Forwarder/Customer', typeId: 'freight_forwarder_customer' });
        store.upsertCompanyMargin('kings', 'blackwater', { marginPercent: 0.1, marginNumber: 0 });
        store.upsertCompanyMargin('joes', 'blackwater', { marginPercent: 0.25, marginNumber: 0 });
        insertRate({ id: 'kings-rate', owner: 'kings', rate: 1000 });
        insertRate({ id: 'joes-rate', owner: 'joes', rate: 2000 });
        db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
            VALUES ('kings-sailing', '2026-05-01T00:00:00.000Z', 'MSC', 'SHA', 'kings')
        `).run();
        db.prepare(`
            INSERT INTO sailings (id, departure, carrier, departure_port, owner_company_id)
            VALUES ('joes-sailing', '2026-05-02T00:00:00.000Z', 'MSC', 'SHA', 'joes')
        `).run();

        const customer = { companyRecordId: 'blackwater', companyType: 'Freight Forwarder/Customer' };
        const priced = appRates(customer).sort((left, right) => left.id.localeCompare(right.id));
        assert.deepEqual(priced.map(rate => [rate.id, rate.rate20D, rate.ownerCompanyName]), [
            ['joes-rate', 2500, 'Joe Shipping'],
            ['kings-rate', 1100, 'Kings']
        ]);

        const owner = { companyRecordId: 'kings', companyType: 'Contract Owner', companyName: 'Kings' };
        const own = appRates(owner);
        assert.deepEqual(own.map(rate => [rate.id, rate.rate20D]), [['kings-rate', 1000]]);

        const partner = listPartnerRates({ companyRecordId: 'kings' }, { page: 1, pageSize: 50 });
        assert.deepEqual(partner.data.map(rate => [rate.id, rate.rate20D, rate.source]), [['kings-rate', 1000, 'base_contract']]);
        assert.equal(partner.data[0].allocationEvidence, false);
        assert.equal(partner.data[0].currency, null);

        const sailings = listPartnerSailings({ companyRecordId: 'kings' }, { page: 1, pageSize: 50 });
        assert.deepEqual(sailings.data.map(sailing => sailing.id), ['kings-sailing']);
    });
});
