'use strict';

// Allow rates.max_slots_allowed to be 0, and draw a new rate's value from 0–5 (D-054).
// Existing values are copied unchanged. up() runs inside the runner's transaction.
// Do not BEGIN, COMMIT, or ROLLBACK.
//
// SQLite cannot alter a column CHECK in place. The swap below adds a new column,
// copies every value, drops the old column, and renames. The insert trigger is
// dropped first because DROP COLUMN fails while a trigger still names the column.
//
// Already-swapped databases are detected from sqlite_master: the rates table SQL
// contains the column CHECK "max_slots_allowed >= 0". In that case the swap is
// skipped and only the 0–5 trigger is ensured.

const ZERO_CHECK = 'max_slots_allowed INTEGER CHECK (max_slots_allowed IS NULL OR max_slots_allowed >= 0)';

function tableSql(db) {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rates'`).get();
    return row && row.sql ? row.sql : '';
}

function allowsZero(db) {
    return tableSql(db).includes(ZERO_CHECK);
}

function ensureTrigger(db) {
    db.exec('DROP TRIGGER IF EXISTS trg_rates_max_slots_default');
    db.exec(`
        CREATE TRIGGER trg_rates_max_slots_default
        AFTER INSERT ON rates
        WHEN NEW.max_slots_allowed IS NULL
        BEGIN
            UPDATE rates
            SET max_slots_allowed = abs(random()) % 6
            WHERE id = NEW.id;
        END
    `);
}

function up(db) {
    if (!allowsZero(db)) {
        db.exec('DROP TRIGGER IF EXISTS trg_rates_max_slots_default');
        db.exec('ALTER TABLE rates ADD COLUMN max_slots_allowed_018 INTEGER CHECK (max_slots_allowed_018 IS NULL OR max_slots_allowed_018 >= 0)');
        db.exec('UPDATE rates SET max_slots_allowed_018 = max_slots_allowed');
        db.exec('ALTER TABLE rates DROP COLUMN max_slots_allowed');
        db.exec('ALTER TABLE rates RENAME COLUMN max_slots_allowed_018 TO max_slots_allowed');
    }
    ensureTrigger(db);
}

module.exports = {
    id: '018',
    description: 'Allow rates.max_slots_allowed to be 0 and fill a random whole number from 0 to 5 when a new rate has none.',
    up
};
