'use strict';

function up(db) {
    db.exec(`
        ALTER TABLE managed_agents ADD COLUMN accept_max_slots INTEGER NOT NULL DEFAULT 0
            CHECK (accept_max_slots IN (0, 1))
    `);
}

module.exports = { id: '019', description: 'Add managed agent maximum-slot opt-in.', up };
