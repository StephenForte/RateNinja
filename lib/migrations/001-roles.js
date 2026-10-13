'use strict';

// Role columns for R1-02. up() runs inside the runner's transaction.
// Do not BEGIN, COMMIT, ROLLBACK, or call lib/db.js transaction().

function columnExists(db, table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
}

function up(db) {
    if (!columnExists(db, 'users', 'is_system_admin')) {
        db.exec('ALTER TABLE users ADD COLUMN is_system_admin INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'users', 'company_role')) {
        db.exec("ALTER TABLE users ADD COLUMN company_role TEXT NOT NULL DEFAULT 'member'");
    }

    // Legacy inserts (the R1-01 harness among them) set admin_screen and not
    // company_role. Copy that flag once, at insert, so authorization can ignore
    // admin_screen afterwards. Updating admin_screen later does not grant a role.
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS users_company_role_from_admin_screen_insert
        AFTER INSERT ON users
        FOR EACH ROW
        WHEN NEW.admin_screen = 1 AND NEW.company_role IS NOT 'company_admin'
        BEGIN
            UPDATE users SET company_role = 'company_admin' WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS users_admin_screen_from_company_role_insert
        AFTER INSERT ON users
        FOR EACH ROW
        WHEN NEW.company_role = 'company_admin' AND NEW.admin_screen IS NOT 1
        BEGIN
            UPDATE users SET admin_screen = 1 WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS users_admin_screen_from_company_role_update
        AFTER UPDATE OF company_role ON users
        FOR EACH ROW
        WHEN NEW.company_role IS NOT OLD.company_role
        BEGIN
            UPDATE users
            SET admin_screen = CASE WHEN NEW.company_role = 'company_admin' THEN 1 ELSE 0 END
            WHERE id = NEW.id;
        END;
    `);

    db.prepare(`
        UPDATE users
        SET company_role = 'company_admin'
        WHERE admin_screen = 1 AND company_role IS NOT 'company_admin'
    `).run();
    db.prepare(`
        UPDATE users
        SET is_system_admin = 1
        WHERE lower(username) = 'stevef' AND is_system_admin IS NOT 1
    `).run();
}

module.exports = {
    id: '001',
    description: 'Add system-admin and company-role columns and backfill them from the existing admin flag.',
    up
};
