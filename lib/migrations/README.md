# Migrations

`lib/db.js` applies the frozen baseline schema, then calls `runMigrations`. This directory ships `001-roles.js`. Later tasks add only the id assigned to them in `tasks/round-1-plan.md`.

## File shape

`NNN-slug.js` exports `{ id: 'NNN', description, up(db) }`. `id` is the filename prefix. `up` runs inside the runner's transaction and must not call `BEGIN`, `COMMIT`, or `ROLLBACK`. Make `up` additive: existing columns and rows must survive a database that already has them.

## Ordering

The runner applies every id that is absent from `schema_migrations`, lowest id first, one transaction per migration. It is not a high-water mark. If `004` is already recorded and `003` appears later, `003` still runs. Record the id in that same transaction. A throw rolls that migration back, leaves earlier ids recorded, and aborts startup with the failing id in the message.

## Backup

When at least one migration is pending and the database path is a file, the runner runs `VACUUM INTO` (outside a transaction) at `<db dir>/backups/rateninja-<UTC timestamp>-pre-<first pending id>.db`, keeps the newest `MIGRATION_BACKUPS_KEPT` files (`lib/limits.js`), and aborts startup if the backup fails. Nothing is backed up when nothing is pending. `:memory:` is not file-backed.

## Tests

The directory is chosen at call time: `options.migrationsDir`, otherwise `MIGRATIONS_DIR`, otherwise this directory. Set `MIGRATIONS_DIR` or pass `migrationsDir` before `lib/db.js` loads. `lib/db.js` opens the database at require time, so a test that requires it first cannot redirect the path.

## Restore limits

Restore only backups written by the D-003 migration runner from a database that had already booted the 2026-09-24 server (`838291a`) or later. A backup from before 2026-09-24, or anything written by `scripts/migrate-from-airtable.js`, cannot be restored onto Round 1 code (D-026).
