'use strict';

// Customer authorization is its own state (D-014). up() runs inside the runner's
// transaction. Do not BEGIN, COMMIT, ROLLBACK, or call lib/db.js transaction().

function columnExists(db, table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function up(db) {
    if (!columnExists(db, 'company_margins', 'status')) {
        db.exec(`ALTER TABLE company_margins ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
    }
    if (!columnExists(db, 'company_margins', 'authorized_at')) {
        db.exec('ALTER TABLE company_margins ADD COLUMN authorized_at TEXT');
    }
    if (!columnExists(db, 'company_margins', 'revoked_at')) {
        db.exec('ALTER TABLE company_margins ADD COLUMN revoked_at TEXT');
    }
    if (!columnExists(db, 'company_margins', 'updated_by')) {
        db.exec('ALTER TABLE company_margins ADD COLUMN updated_by TEXT');
    }

    db.prepare(`
        UPDATE company_margins
        SET status = 'active'
        WHERE status IS NULL OR status = ''
    `).run();
    db.prepare(`
        UPDATE company_margins
        SET authorized_at = created_at
        WHERE authorized_at IS NULL OR authorized_at = ''
    `).run();

    // D-013: a stored 1 means 100%. Report it and leave the value alone.
    const flagged = db.prepare(`
        SELECT id FROM company_margins WHERE margin_percent = 1 ORDER BY id
    `).all();
    for (const row of flagged) {
        console.log(`R1-07 customer-authorization margin_percent=1 id=${row.id}`);
    }
}

module.exports = {
    id: '005',
    description: 'Add customer authorization status to company margins without changing stored prices.',
    up
};
