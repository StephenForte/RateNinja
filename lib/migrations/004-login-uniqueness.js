'use strict';

// Case-insensitive login uniqueness (D-022). up() runs inside the runner's
// transaction. Do not BEGIN, COMMIT, ROLLBACK, or call lib/db.js transaction().
// A colliding database still completes: the index is skipped, the ids are logged,
// and the runner records 004. New logins are refused in application code either way.

const INDEX_NAME = 'users_lower_username_key';

function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_submissions (
            submission_id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);

    const colliding = db.prepare(`
        SELECT id FROM users
        WHERE username IS NOT NULL
          AND lower(username) IN (
            SELECT lower(username) FROM users
            WHERE username IS NOT NULL
            GROUP BY lower(username)
            HAVING COUNT(*) > 1
          )
        ORDER BY id
    `).all();
    if (colliding.length > 0) {
        console.log(`004-login-uniqueness colliding-user-ids ${colliding.map(row => row.id).join(' ')}`);
        return;
    }

    const existing = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get(INDEX_NAME);
    if (!existing) {
        db.exec(`CREATE UNIQUE INDEX ${INDEX_NAME} ON users (lower(username))`);
    }
}

module.exports = {
    id: '004',
    description: 'Reject case-insensitive duplicate login names, unless existing rows already collide.',
    up
};
