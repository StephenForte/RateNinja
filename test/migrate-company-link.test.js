const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rateninja-migrate-'));
process.env.SQLITE_DB_PATH = path.join(tmpDir, 'migrate.db');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { migrateCompanies, migrateUsers } = require('../scripts/migrate-from-airtable');
const { linkUserCompanies } = require('../lib/store');

describe('migrated contract owner company link', () => {
    after(() => {
        try {
            db.close();
        } catch {
            // Temporary database.
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stores the company record id from the reference or the business id', () => {
        migrateCompanies([
            {
                id: 'rec-owner',
                fields: {
                    CompanyID: 'CO-9',
                    CompanyName: 'Migrated Owner Co',
                    CompanyType: 'Contract Owner'
                }
            }
        ]);
        migrateUsers([
            {
                id: 'user-linked',
                fields: {
                    UserName: 'LinkedOwner',
                    DisplayName: 'Linked Owner',
                    CompanyReference: ['rec-owner'],
                    'CompanyID (from CompanyReference)': 'CO-9'
                }
            },
            {
                id: 'user-business',
                fields: {
                    UserName: 'BusinessOwner',
                    DisplayName: 'Business Owner',
                    CompanyReference: ['rec-gone'],
                    'CompanyID (from CompanyReference)': ['CO-9']
                }
            }
        ]);

        const linked = db.prepare('SELECT company_record_id, company_id, pwd FROM users WHERE id = ?').get('user-linked');
        assert.equal(linked.company_record_id, 'rec-owner');
        assert.equal(linked.company_id, 'CO-9');
        assert.equal(linked.pwd, null);

        const business = db.prepare('SELECT company_record_id FROM users WHERE id = ?').get('user-business');
        assert.equal(business.company_record_id, 'rec-owner');
    });

    it('backfills company_record_id for rows imported before the column existed', () => {
        db.prepare(`
            INSERT INTO users (id, username, display_name, company_id, company_reference, company_record_id)
            VALUES ('user-legacy', 'LegacyOwner', 'Legacy Owner', 'CO-9', 'rec-owner', NULL)
        `).run();
        linkUserCompanies();
        const row = db.prepare('SELECT company_record_id FROM users WHERE id = ?').get('user-legacy');
        assert.equal(row.company_record_id, 'rec-owner');
    });
});
