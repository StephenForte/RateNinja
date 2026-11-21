'use strict';

// Random 1–5 max slots for rates that do not already have a value (D-053).
// up() runs inside the runner's transaction. Do not BEGIN, COMMIT, or ROLLBACK.
// No column DEFAULT: a non-constant default fails ALTER TABLE once any row exists.

function columnExists(db, table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function up(db) {
    if (!columnExists(db, 'rates', 'max_slots_allowed')) {
        db.exec('ALTER TABLE rates ADD COLUMN max_slots_allowed INTEGER CHECK (max_slots_allowed IS NULL OR max_slots_allowed >= 1)');
    }
    // random() is evaluated per row. A bound value or a scalar subquery would
    // stamp every existing rate with the same number.
    db.exec(`
        UPDATE rates
        SET max_slots_allowed = (abs(random()) % 5) + 1
        WHERE max_slots_allowed IS NULL
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_rates_max_slots_default
        AFTER INSERT ON rates
        WHEN NEW.max_slots_allowed IS NULL
        BEGIN
            UPDATE rates
            SET max_slots_allowed = (abs(random()) % 5) + 1
            WHERE id = NEW.id;
        END
    `);
}

module.exports = {
    id: '017',
    description: 'Add rates.max_slots_allowed and fill a random whole number from 1 to 5 when a rate has none.',
    up
};
