'use strict';

const { MAX_BOOKING_SLOTS } = require('../limits');

function up(db) {
    const names = new Set(db.prepare('PRAGMA table_info(managed_agents)').all().map(column => column.name));
    if (!names.has('booking_slots')) {
        db.exec(`
            ALTER TABLE managed_agents ADD COLUMN booking_slots INTEGER
                CHECK (booking_slots IS NULL OR (
                    typeof(booking_slots) = 'integer' AND booking_slots BETWEEN 1 AND ${MAX_BOOKING_SLOTS}
                ));
        `);
    }
    if (!names.has('booking_request_id')) {
        db.exec('ALTER TABLE managed_agents ADD COLUMN booking_request_id TEXT');
    }
    db.exec('UPDATE managed_agents SET booking_slots = 1 WHERE allow_booking_request = 1 AND booking_slots IS NULL');
}

module.exports = { id: '014', description: 'Add managed agent booking slots and request links.', up };
