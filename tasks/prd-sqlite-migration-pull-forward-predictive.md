# PRD: SQLite Migration, Pull-Forward Admin Tool, and Predictive Rates View

## Introduction

Rate Ninja currently stores all data (rates, users, companies, sailings) in Airtable and reads it over the Airtable REST API with an in-process cache. This project (1) migrates the backend to a local SQLite database using Node's built-in `node:sqlite` module, (2) rewrites all data access against SQLite, (3) adds an admin "pull forward" feature that copies historical rate and sailing data into a future date range (optionally with a price increase), and (4) adds a "predictive rates" mode to the main screen that shows computed future prices (90+ days out) without writing anything to the database.

Together these changes remove the Airtable dependency (rate limits, latency, API keys) and give admins tools to project future rate data.

## Goals

- Replace Airtable entirely with a local SQLite database; no Airtable API calls remain in the codebase.
- One-time migration script imports all existing Airtable records into SQLite.
- All existing functionality (login, rate search, filters, margins, sailings modal, admin margin editor, public v1 API, predictive-pricing API) works identically against SQLite.
- Admins can "pull forward" rates and sailings from a past date range into a future date range (max 90 days out), with an optional percentage price increase and an optional pre-delete of existing data in the target range.
- Signed-in users can toggle a "predictive rates" mode on the main screen, choose a departure date 90+ days out, and see computed predictive prices (same formula as the public API, with their company margin applied) without any database writes.

## User Stories

Stories are ordered; each builds on the previous. Implement in order.

### US-001: Create SQLite schema and database module
**Description:** As a developer, I need a SQLite database with tables mirroring the Airtable schema so the app has a local data store.

**Acceptance Criteria:**
- [ ] New module `lib/db.js` opens (or creates) the database file using `node:sqlite` (`DatabaseSync`); the file path defaults to `data/rateninja.db` and is overridable via `SQLITE_DB_PATH` env var
- [ ] On startup, `lib/db.js` runs idempotent `CREATE TABLE IF NOT EXISTS` DDL for four tables: `rates`, `users`, `companies`, `sailings`
- [ ] `rates` columns: `id` (TEXT primary key), `rate_type`, `origin_port`, `destination_port`, `inland_delivery_location`, `commodity_type`, `carrier`, `contract_owner`, `rate_20d` (REAL), `rate_40d` (REAL), `rate_40hc` (REAL), `rate_effective_date` (TEXT, ISO `YYYY-MM-DD`), `rate_expiration_date` (TEXT), `notes_1`, `rate_view` (TEXT — comma-joined if multiple views)
- [ ] `users` columns: `id` (TEXT primary key), `username`, `pwd`, `display_name`, `rate_view`, `company_id`, `company_reference`, `admin_screen` (INTEGER 0/1)
- [ ] `companies` columns: `id` (TEXT primary key), `company_id`, `company_name`, `company_type`, `rate_view`, `admin` (INTEGER 0/1), `margin_percent` (REAL), `margin_number` (REAL)
- [ ] `sailings` columns: `id` (TEXT primary key), `departure` (TEXT ISO date), `arrival` (TEXT ISO date), `transit_time`, `vessel`, `voyage`, `service`, `carrier`, `departure_port`
- [ ] Indexes created on `rates(carrier, origin_port)`, `sailings(carrier, departure_port, departure)`, `users(username)`, `companies(company_id)`
- [ ] `data/*.db` added to `.gitignore`
- [ ] `package.json` `engines.node` bumped to `>=22` (required for stable `node:sqlite`)
- [ ] `npm run check` passes (add `lib/db.js` to the check script)

### US-002: One-time Airtable-to-SQLite migration script
**Description:** As a developer, I want a script that copies all existing Airtable records into SQLite so production data survives the migration.

**Acceptance Criteria:**
- [ ] New script `scripts/migrate-from-airtable.js`, runnable via `npm run migrate`
- [ ] Reads Airtable credentials from the existing env vars (`AIRTABLE_PAT`, `AIRTABLE_BASE_ID`, table id vars) and fetches ALL records from all four tables with pagination (reuse or copy the existing `fetchAllRecords` logic)
- [ ] Fetches all fields for users/companies/sailings; for rates fetches at least the fields in `RATE_FIELDS` plus `Arrival` if present
- [ ] Inserts records into SQLite preserving the Airtable record id as `id`; multi-value fields (e.g. `RateView` arrays) are joined with `", "` to match current `normalizeValue` behavior
- [ ] Script is idempotent: re-running upserts by `id` (INSERT OR REPLACE) rather than duplicating rows
- [ ] Prints a per-table summary (e.g. `rates: 1240 migrated`) and exits non-zero on failure
- [ ] Script is standalone — the server does not import it and running the server never triggers it
- [ ] `node --check scripts/migrate-from-airtable.js` passes

### US-003: Replace data access layer with SQLite
**Description:** As a developer, I want all server reads/writes to go through SQLite so Airtable can be retired.

**Acceptance Criteria:**
- [ ] New module `lib/store.js` exposes the same logical operations the server uses today: `getAllRates()`, `getAllCompanies()`, `getUserByUsername(username)`, `getCompanyByRecordId(id)`, `getSailings({ carrier, originPort, after })`, `updateCompanyMargins(id, { marginPercent, marginNumber })`
- [ ] Each function returns objects shaped like the current Airtable records (`{ id, fields: { 'Origin Port': …, … } }`) OR `lib/domain.js` mappers are updated to consume the new row shape — either way, API response JSON is byte-for-byte equivalent in structure to today (same keys, same normalization fallbacks like `'N/A'`)
- [ ] `getSailings` filters `carrier = ?`, `departure_port = ?`, `departure > ?` and orders by `departure` ascending, matching the current Airtable formula
- [ ] `handleLogin` looks up the user by username in SQLite (case-sensitive match, matching current behavior) and compares `pwd`; login/logout/session behavior unchanged
- [ ] `handleAdminCompanyUpdate` performs an SQL `UPDATE` on `companies` and subsequent reads reflect it
- [ ] The in-memory cache layer is removed or reduced to a pass-through (SQLite is local; per-request queries are fine). The `?refresh=1` param on `/api/rates` remains accepted and simply re-queries
- [ ] `lib/airtable.js` is deleted; no file under `lib/` or `server.js` references `api.airtable.com` (the migration script in `scripts/` is the only remaining Airtable reference)
- [ ] `lib/config.js` no longer requires `AIRTABLE_PAT` for the server to start; `requireConfiguration` checks `SESSION_SECRET` (and DB availability) instead
- [ ] All existing endpoints (`/api/auth/login`, `/api/session`, `/api/rates`, `/api/sailings`, `/api/admin/companies` GET/PATCH, `/api/v1/rates`, `/api/v1/sailings`, `/api/v1/predictive-pricing`) return the same JSON shapes as before
- [ ] `npm run check` passes (update the file list)
- [ ] Manual smoke test: start server with a migrated (or seeded) DB, log in, load rates, open sailings modal, edit a company margin, and hit `/api/v1/rates` with the API key — verify in browser using dev-browser skill

### US-004: Pull-forward API endpoint for rates
**Description:** As an admin, I want to copy rates from a past date range into a future date range so next quarter's data exists without manual entry.

**Acceptance Criteria:**
- [ ] New endpoint `POST /api/admin/pull-forward/rates` requiring a session with `isAdmin: true` (403 otherwise)
- [ ] Request body: `{ sourceStart, sourceEnd, targetStart, targetEnd, priceIncreasePercent, deleteExisting }` — dates are `YYYY-MM-DD` strings; `priceIncreasePercent` is a number ≥ 0 (0 allowed, meaning straight copy); `deleteExisting` is boolean
- [ ] Validation (400 with a specific message on failure): all four dates parse via `parseDateOnly`; `sourceStart ≤ sourceEnd`; `targetStart ≤ targetEnd`; `targetStart > sourceEnd`; `targetEnd` is no more than 90 days after today (`fullDaysUntil(targetEnd) ≤ 90`); target range length equals source range length; `priceIncreasePercent` between 0 and 100
- [ ] Source rows = rates where `rate_effective_date` falls within `[sourceStart, sourceEnd]`
- [ ] Each copied row: new generated id (e.g. `crypto.randomUUID()`); `rate_effective_date` and `rate_expiration_date` each shifted by the day offset `targetStart − sourceStart`; `rate_20d`/`rate_40d`/`rate_40hc` multiplied by `(1 + priceIncreasePercent / 100)` and rounded to whole numbers; all other columns copied verbatim
- [ ] If `deleteExisting` is true, rates with `rate_effective_date` within `[targetStart, targetEnd]` are deleted first — delete + insert happen in a single SQLite transaction so a failure leaves the DB unchanged
- [ ] Response: `{ ok: true, copied: <n>, deleted: <n> }`
- [ ] Copying zero source rows is not an error — returns `copied: 0`
- [ ] `npm run check` passes

### US-005: Pull-forward API endpoint for sailings
**Description:** As an admin, I want the same pull-forward capability for sailings so future schedules mirror past ones.

**Acceptance Criteria:**
- [ ] New endpoint `POST /api/admin/pull-forward/sailings`, admin-only, same request body minus `priceIncreasePercent` (ignored if sent)
- [ ] Same date validation rules as US-004
- [ ] Source rows = sailings where `departure` (date part) falls within `[sourceStart, sourceEnd]`
- [ ] Copied rows get new ids; `departure` and `arrival` are shifted by the day offset (preserving any time-of-day component); `transit_time`, `vessel`, `voyage`, `service`, `carrier`, `departure_port` copied verbatim
- [ ] `deleteExisting: true` deletes sailings with `departure` in the target range first, in the same transaction as the inserts
- [ ] Response: `{ ok: true, copied: <n>, deleted: <n> }`
- [ ] `npm run check` passes

### US-006: Pull-forward admin UI
**Description:** As an admin, I want a form in the admin section to run pull-forward for rates or sailings so I don't need API tools.

**Acceptance Criteria:**
- [ ] Admin screen (`#adminScreen`, reached via the hamburger menu) gains a "Pull Forward Data" panel below the existing margin table
- [ ] Panel contains: table selector (Rates / Sailings), source date range (two date inputs), target date range (two date inputs), price increase % number input (visible/enabled only when Rates is selected, default 0), a "Delete existing data in target range" checkbox (default off), and a "Pull Forward" button
- [ ] Client-side validation mirrors the server rules and shows inline error messages (e.g. "Target range must end within 90 days of today"); the button is disabled while the request is in flight
- [ ] When "Delete existing" is checked, clicking Pull Forward shows a confirmation dialog stating what will be deleted before submitting
- [ ] Success shows a summary message ("Copied 132 rates, deleted 0") and failure shows the server's error message
- [ ] After a successful rates pull-forward, the main screen's rate list reflects the new rows on next load/refresh
- [ ] Styling matches the existing admin panel (reuse existing classes in `styles.css`)
- [ ] `npm run check` passes
- [ ] Verify in browser using dev-browser skill: run a rates pull-forward and a sailings pull-forward end-to-end, including a validation failure and the delete-existing confirmation

### US-007: Predictive rates endpoint for signed-in users
**Description:** As a signed-in user, I want an endpoint that returns predictive rates for a future date so the main screen can display them.

**Acceptance Criteria:**
- [ ] New endpoint `GET /api/rates/predictive?after=YYYY-MM-DD` requiring a session (not admin-only)
- [ ] Validation: `after` parses via `parseDateOnly` and `fullDaysUntil(after) > 90`; otherwise 400 "Departing after must be more than 90 days in the future."
- [ ] Uses the same route-dedup logic as the public API (`latestPredictiveRateRecords` generalized to run across ALL carriers/origin ports, not filtered to one) over rates visible to the user's `rateView`
- [ ] Predictive price per container size = `calculatePredictiveRate(baseRate, floor(daysUntilDeparture / 30))`, then the user's company margin applied via the existing `calculateRate` logic (margin applied to the predictive base) — admin-flagged companies see no margin, matching current behavior
- [ ] Response shape matches `/api/rates` (`{ rates: [...] }`) with the same per-rate keys so the existing table renderer works unchanged; `rateEffectiveDate` is set to the requested `after` date and `rateExpirationDate` to `'N/A'` (or similar sentinel), and each rate includes `predictive: true`
- [ ] No database writes occur — the endpoint is read-only
- [ ] `npm run check` passes

### US-008: Predictive rates mode on the main screen
**Description:** As a signed-in user, I want to toggle "Predictive rates" and pick a future date so I can see projected pricing in the familiar rates table.

**Acceptance Criteria:**
- [ ] Main screen controls area gains a "Predictive rates" toggle (checkbox or switch) with a date input labeled "Departing after", enabled only when the toggle is on
- [ ] The date input's `min` attribute is set to today + 91 days; choosing an earlier date shows an inline error and does not fetch
- [ ] Turning the toggle on with a valid date fetches `/api/rates/predictive?after=…` and replaces the table contents; turning it off restores the normal `/api/rates` view (refetch or restore cached list)
- [ ] Search, column filters, sorting, and pagination all work on predictive results exactly as they do on normal results
- [ ] A visible indicator (e.g. banner or badge above the table: "Showing predictive rates for departures after {date} — not saved data") makes the mode unmistakable
- [ ] Changing the date while the toggle is on re-fetches predictive data
- [ ] The Refresh button, while in predictive mode, re-fetches predictive data (not normal rates)
- [ ] Sailings modal links behave sensibly in predictive mode: either open with the predictive `after` date as the effective date, or are disabled — pick one and be consistent
- [ ] `npm run check` passes
- [ ] Verify in browser using dev-browser skill: toggle on, pick a valid date, confirm rates change and banner appears; pick an invalid date, confirm error; toggle off, confirm normal rates return

## Functional Requirements

**Database & migration**
- FR-1: The system must store all rates, users, companies, and sailings data in a SQLite database accessed via Node's built-in `node:sqlite` module; no runtime npm dependencies may be added.
- FR-2: The database file location must default to `data/rateninja.db` and be overridable with `SQLITE_DB_PATH`.
- FR-3: Schema creation must be idempotent and run automatically on server start.
- FR-4: A standalone migration script must copy every Airtable record into SQLite, preserving record ids, and must be safe to re-run (upsert semantics).
- FR-5: After migration, the server must not make any Airtable API calls and must start without `AIRTABLE_PAT`.

**Data access parity**
- FR-6: Every existing endpoint must return the same JSON structure (keys, fallback values such as `'N/A'`, margin math, rate rounding) as the Airtable implementation.
- FR-7: Session auth, admin authorization, public API key auth, and the public API rate limiter must be unchanged.
- FR-8: Sailings queries must filter by carrier, departure port, and departure-after date, sorted by departure ascending.

**Pull forward**
- FR-9: Admin-only endpoints must copy rates (`POST /api/admin/pull-forward/rates`) and sailings (`POST /api/admin/pull-forward/sailings`) from a source date range to a target date range of equal length.
- FR-10: Copied records must have all dates shifted by the day offset between `targetStart` and `sourceStart`; source rows are selected by `rate_effective_date` (rates) or `departure` (sailings).
- FR-11: The target range must end no more than 90 days after today; the target range must start after the source range ends; violations return HTTP 400 with a human-readable message.
- FR-12: For rates, an optional `priceIncreasePercent` (0–100) must scale the three container rates, rounded to whole numbers.
- FR-13: When `deleteExisting` is true, existing target-range rows must be deleted in the same transaction as the inserts; on any error the transaction rolls back entirely.
- FR-14: The admin UI must confirm before any delete-existing operation and must report copied/deleted counts on success.

**Predictive rates**
- FR-15: `GET /api/rates/predictive?after=YYYY-MM-DD` must require a session and reject dates ≤ 90 days out with HTTP 400.
- FR-16: Predictive prices must use the existing formula — base rate × (1 + 0.05 × floor(daysUntilDeparture / 30)) — then apply the user's company margin exactly as normal rate views do.
- FR-17: Predictive results must deduplicate to the latest rate per route (carrier + origin + destination) using the existing `latestPredictiveRateRecords` logic, filtered to the user's `rateView`.
- FR-18: Predictive mode must never write to the database.
- FR-19: The main-screen predictive toggle must clearly indicate predictive mode is active and support all existing table features (search, filter, sort, paginate, refresh).

## Non-Goals (Out of Scope)

- No dual-write or live sync between Airtable and SQLite; Airtable is read exactly once, by the migration script.
- No changes to the predictive pricing formula itself (stays 5% per full 30-day period) or to margin math.
- No user management UI, password hashing changes, or auth improvements (passwords remain stored as-is, matching current behavior).
- No pull-forward for users or companies tables.
- No scheduling/automation of pull-forward (manual admin action only).
- No persistence of predictive rates; they are computed per request only.
- No changes to the RateNinja/ static mockup directory.
- No new npm dependencies and no ORM.

## Technical Considerations

- **Node version:** `node:sqlite` (`DatabaseSync`) requires Node 22+ (stable in 22.5+ / 24). Bump `engines` and verify `render.yaml` uses a compatible Node version.
- **Deployment persistence:** SQLite is a file on disk. On Render, the file must live on a persistent disk mount or the DB resets on every deploy — `render.yaml` needs a disk with `SQLITE_DB_PATH` pointing at the mount. Flag this in the deploy notes; local dev needs nothing.
- **Synchronous driver:** `DatabaseSync` is synchronous; queries are fast for this data size (thousands of rows). Keep statements prepared once in `lib/db.js` where hot.
- **Record shape bridge:** The cheapest parity path is having `lib/store.js` return `{ id, fields: {...} }` objects with the exact Airtable field names, leaving `lib/domain.js` and all mappers untouched. Recommended.
- **Date shifting:** Shift dates in UTC using day arithmetic (reuse `parseDateOnly`) to avoid DST bugs; sailings `departure`/`arrival` may carry timestamps — preserve time-of-day when shifting.
- **Transactions:** Wrap pull-forward delete+insert in `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK` (or a helper) — `node:sqlite` has no built-in transaction wrapper.
- **`Arrival` on rates:** The public predictive-pricing endpoint reads a `fields.Arrival` value that is not in `RATE_FIELDS` (a past commit dropped it from the projection because it was invalid). Confirm during migration whether the rates table actually has an Arrival column; if not, keep the current behavior (empty string fallback) and omit the column.

## Success Metrics

- Zero Airtable API calls after cutover; `/api/rates` p95 latency drops (no external HTTP round-trip, no 60s cache staleness).
- Migration script completes with record counts matching Airtable for all four tables.
- An admin can pull forward a quarter of rates with a price increase in under a minute, with correct row counts reported.
- A user can view predictive rates for a 90+ day-out date in two interactions (toggle + date), and the database row count is unchanged afterward.
- All existing endpoints pass a before/after JSON shape comparison.

## Open Questions

- Should the pull-forward target range be allowed to overlap the source range's shifted tail if source data already extends near today? (Current rule — `targetStart > sourceEnd` — forbids overlap; confirm that's acceptable.)
- Render deployment: does the current plan include a persistent disk, and who provisions it plus the `SQLITE_DB_PATH` env var?
- Should the migration script also be pointed at a JSON export (offline mode) in case the Airtable PAT is revoked before cutover?
- In predictive mode, should the sailings modal be disabled or open with the predictive date? (US-008 leaves the choice to the implementer but requires consistency.)
