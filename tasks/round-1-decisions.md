# Round 1 Decisions

Append-only. Never renumber. To change a decision, add a new entry and mark the old one
`Superseded by D-NNN (date, reason)` in place. Planner-owned; workers cite, never edit.

---

### D-001 — Static files are served only from `public/` (2026-10-12)

`serveStatic` currently serves any non-dot path under the repo root; production returns source
(`/lib/db.js`, `/package.json`). R1-00 moves browser assets into `public/` and resolves static
paths against `public/` only. `/` → `public/index.html`, `/login` → `public/login.html`.
Nothing outside `public/` is ever served. `RateNinja/` (legacy app) stays in the repo, unserved.

### D-002 — Numbered migrations, pre-assigned ids, set-based runner (2026-10-12)

- Existing DDL in `lib/db.js` becomes the frozen baseline. New schema changes go only in
  `lib/migrations/NNN-slug.js`, exporting `{ id: 'NNN', description, up(db) }`.
- Runner (`lib/migrations/index.js`) reads the directory, applies every id **not present** in
  `schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT)` in ascending order, one transaction
  per migration. Set-based, not a high-water mark: migration 003 merged after 004 still runs.
- Consequence: migrations must not depend on each other unless the plan says so.
- Each `up` must be additive and safe if columns already exist (reuse the `addColumn` pattern).
- Ids are assigned in the plan's migration table. Workers never choose one.
- Each migration task's tests prove: fresh DB, a DB built from the pre-change baseline with seeded
  users/margins/rates, and a second startup (no-op).

### D-003 — Pre-migration backup (2026-10-12)

When pending migrations exist and the DB is file-backed, the runner first writes
`VACUUM INTO '<db dir>/backups/rateninja-<UTC timestamp>-pre-<first pending id>.db'`, keeps the
newest 5, and aborts startup if the backup fails. No backup when nothing is pending. The
`backups/` dir is under `/var/data` in production, so it is outside `public/` (D-001).
Restore drill (copy back, start, smoke-test) is part of R1-14.

### D-004 — Route modules (2026-10-12)

Each module in `lib/routes/` exports `routes: [{ method, path | pattern, access, handler }]` with
`access` one of `public`, `session`, `session-unrestricted` (allowed during forced password
change; see D-010). `server.js` keeps its existing chain and consults `lib/routes/index.js`
before the 404. All modules are registered up-front by R1-01; tasks fill their own module.
Shared helpers (`sendJson`, `sendError`, `readJson`, `requireCsrf`, `securityHeaders`) move to
`lib/http.js`.

### D-005 — Role model (2026-10-12)

- `users.is_system_admin INTEGER NOT NULL DEFAULT 0` — independent of company and company role.
- `users.company_role TEXT NOT NULL DEFAULT 'member'` — `'member' | 'company_admin'`.
- Contract-owner admin = `company_role = 'company_admin'` AND the user's company type is Contract Owner.
- Migration 001 backfills `company_role = 'company_admin'` where `admin_screen = 1`.
- `admin_screen` is kept and written in sync (`1` iff company_admin) for rollback safety, but is
  **not read** for authorization after R1-02.
- All checks live in `lib/permissions.js`. Handlers never test company type or flags directly.
- Role/role-flag changes and deactivation bump the target's `session_epoch` (existing revocation
  mechanism) and revoke OAuth grants where the PRD requires.
- Guards: no self-deactivation; cannot remove/deactivate the last active company admin of a
  company or the last active system admin.

### D-006 — SteveF system-admin provisioning (2026-10-12)

Migration 001 sets `is_system_admin = 1` for the user whose `lower(username) = 'stevef'`, once.
No code path infers system admin from a username. `lib/foundation.js` stops updating existing
users and companies: `ensureUser`/`ensureCompany` insert only when missing.

### D-007 — System-admin company context (2026-10-12)

- Stored on the server-side session as `companyContextId`; set via `POST /api/admin/context`
  `{ companyId }` (validated to exist). Cleared on logout.
- Company admins' context is always their own company; they cannot set it.
- Every company-scoped admin endpoint resolves its company through
  `permissions.resolveCompanyContext(session)`. System admin with no context → `409` with
  `code: 'company_context_required'`.
- Mutating company-scoped requests also send `companyId`; mismatch with the resolved context → `409`
  `code: 'company_context_mismatch'` (protects against a stale second tab).

### D-008 — OAuth client administration is system-admin only (2026-10-12)

Partner OAuth clients are platform-level. Existing `/api/admin/oauth-clients*` routes require
system admin after R1-02.

### D-009 — Session payload contract (2026-10-12)

`GET /api/session` → `user`:

```json
{
  "username": "display name", "loginName": "login", "companyName": "", "companyType": "",
  "permissions": { "systemAdmin": false, "companyAdmin": false, "contractOwner": false },
  "mustChangePassword": false,
  "companyContext": { "id": "", "name": "" }
}
```

`companyContext` is `null` for a system admin with no context. `isAdmin`/`isContractOwner` remain
until R1-03 merges, then R1-04 removes them. Produced by R1-02; consumed by R1-03 (which can build
against this shape before R1-02 merges). `mustChangePassword` is always `false` until R1-04.

### D-010 — Frontend architecture (2026-10-12)

No framework, no build. Native ES modules under `public/js/`. History API routes: `/rates`,
`/profile[/section]`, `/admin/<section>`; server returns `public/index.html` for those paths.
`/` redirects to `/rates` client-side. Sections are pre-registered stubs (plan: Ownership).
A forced-password-change session renders only `public/js/password-required.js`.

### D-011 — PRD implementation defaults adopted pending product review (2026-10-12)

Temporary passwords force replacement; 2 grouping levels; 3 sort rules; 30-day restore/undo
window. Values live in `lib/limits.js` (R1-01) so product review can change them in one place.

### D-012 — Soft delete and change detection (2026-10-12)

- `rates` and `sailings` gain `deleted_at TEXT`, `deleted_operation_id TEXT`,
  `row_version INTEGER NOT NULL DEFAULT 1` (migration 006).
- Every read path — app, predictive, partner, MCP, demo `/api/v1/*` — filters `deleted_at IS NULL`.
  R1-08 owns the sweep and a test that enumerates every data-serving path.
- Restore allowed while `deleted_at` is within the D-011 window. No automatic purge in P1.
- Previews carry the `row_version` set they were computed against; execution rejects on mismatch.
- Every write increments `row_version`.

### D-013 — Margin percent storage and one pricing path (2026-10-12)

- `lib/pricing.js` exports `customerPrice(base, { marginPercent, marginNumber })`; app browsing,
  predictive browsing, and live preview all call it. `Math.round` whole-dollar, as today.
- Existing heuristic preserved for stored values (`> 1` = whole percent, `<= 1` = fraction).
- New writes from the UI store the **fraction** (UI input `10` → stored `0.10`). The UI always
  displays whole percent.
- Known hazard: a stored legacy value of exactly `1` means 100%. R1-07 migration reports (logs,
  does not change) any margin with `margin_percent = 1`.

### D-014 — Customer authorization state (2026-10-12)

`company_margins.status TEXT NOT NULL DEFAULT 'active'` (`active | revoked`), plus
`authorized_at`, `revoked_at`, `updated_by`. Migration 005 marks all existing links `active`.
Visibility reads only `active` links. Revoking keeps the margin values. Authorize re-activates.

### D-015 — Shared predictive service (2026-10-12)

`lib/predictive.js` owns the >90-day validation, full-30-day-period count, latest-rate selection,
and 5%/period formula. Demo `/api/v1/predictive-pricing`, app `/api/rates/predictive`, partner
`/api/partner/v1/me/predictive-pricing`, and the MCP tool all call it. Nothing is persisted.

### D-016 — Claude-assisted import mapping (2026-10-12, provisional until R1-10)

Server-side call to the Anthropic Messages API; key in `ANTHROPIC_API_KEY`; model in
`IMPORT_MAPPING_MODEL` (default `claude-sonnet-5-5`). Sends headers + a bounded sample only;
response must validate against a fixed JSON schema of target fields or it is discarded and manual
mapping continues. R1-10 confirms limits and parser choices; R1-11 implements.

### D-017 — Import formats: CSV, Excel, and PDF (2026-10-12)

Product decision (operator, 2026-10-12): all three formats are in P1 scope. This resolves the
PRD's remaining open decision.

- CSV and Excel (`.xlsx`; `.xls` only if R1-10 finds it in representative files) go through
  the PRD workflow unchanged: deterministic parse → Claude-suggested column mapping on headers +
  bounded sample → deterministic validation → commit.
- PDF is **delivered as a separate task (R1-11b) after CSV/Excel (R1-11a)**. Reason: a PDF has no
  column structure to map. Getting rows out of it needs either deterministic text-layer table
  extraction (fails on scanned or irregular sheets) or model extraction. Model extraction
  conflicts with PRD FR 8: "Parsing … remain[s] deterministic" and "the model receives only
  … headers and a bounded representative sample".
- **Open product question — resolved 2026-10-12 by D-018: yes in principle, deferred out of Round 1.** Original text: if deterministic extraction fails on the
  representative PDFs, may Claude extract the rows from the whole PDF? Every extracted row would
  then be shown for review before validation and commit, the whole document would be sent to
  Claude, and no missing value would ever be filled in. R1-10 measures both approaches on real
  files before this is asked.
- R1-10 needs representative files of each format from the operator (real rate sheets and
  sailing schedules, redacted if needed).

### D-018 — Claude-assisted extraction of unstructured import sources: deferred (2026-10-12)

Product decision (operator, 2026-10-12): Claude may eventually turn unstructured source
documents into candidate rows, but this is **deferred well past Round 1** ("keep for way later").
It is not part of P1 or P2. The guardrails below are recorded now so the later work starts from
them; model, prompt, limits, and chunking are decided then.

Round 1 consequence: imports are CSV + Excel only (R1-11a). PDF import, which needs extraction
in practice (D-017), moves out of Round 1 with it. R1-11b is removed from the Round 1 plan.
R1-10 covers CSV and Excel only.

- **Scope:** PDFs, plus Excel sheets that R1-10 finds have no usable header/column structure.
  CSV and structured Excel keep the D-016 mapping-only path. Extraction is never used when
  deterministic parsing succeeds.
- **One client:** a single server-side Claude module (`lib/imports/claude.js`) serves both
  mapping (D-016) and extraction. Key in `ANTHROPIC_API_KEY`; never sent to the browser.
- **Consent:** before sending, the UI states that the whole document (not a sample) will go to
  Claude. Declining ends the import for that file; nothing is sent.
- **Provenance:** every extracted row carries its source location (page or sheet, and line or
  region). Rows without provenance are rejected.
- **No invention:** values absent from the source stay empty. The model must not infer prices,
  dates, ports, carriers, or currency. Output must validate against a fixed schema of target
  fields or the whole response is discarded.
- **Same pipeline after extraction:** extracted rows go through the same deterministic
  conversion and validation as CSV rows (FR 8 rate/sailing rules, USD only), then the same
  review and atomic commit. The user reviews every extracted row before commit.
- **Failure:** if Claude is unavailable, times out, or returns invalid output, the import stops
  cleanly with nothing written, and the user is told plainly.
- **Retention:** the D-016 / FR 8 retention rules apply to the full document. Operation history
  keeps metadata and outcomes only, never document contents or model output.
- **Cost:** model spend scales with document size. The later task measures cost per
  representative file and proposes per-file and per-day limits before dispatch.

### D-019 — Owner-scoped predictive pricing parameters (2026-10-13)

`GET /api/partner/v1/me/predictive-pricing` and MCP `rateninja_get_my_predictive_pricing` take:
`after` (required, `YYYY-MM-DD`, more than 90 days in the future, same check as the demo),
`carrier` and `originPort` (optional exact-match filters, same matching as partner rates),
`page` and `pageSize` (same defaults and bounds as partner rates).

They differ from the demo, which requires carrier and originPort, because the owner-scoped
dataset is already bounded and an AI client should not need to know port names before asking.
Output is base contract pricing only (no customer margin), marked as an estimate. It carries the
input date, the basis (the D-015 formula), the owner company, and `partnerListMeta` pagination.

### D-020 — System-admin browsing context is not in R1-02 (2026-10-13)

The PRD role table lists system-admin browsing "in selected company context". R1-02 scopes
**administration** endpoints to the selected context (D-007). Rate and sailing browsing stays on
the system admin's own company. Whether system admins need to browse as another company in P1 is
an open operator question. Until it is answered, no task implements it.

**Resolved 2026-10-13 (operator): no.** System admins administer the selected company (D-007, D-021) but always browse rates and sailings as their own company. No task implements cross-company browsing.

**Amended 2026-11-15 (operator), D-031:** the admin API key may read the six D-030 reference lookups across all companies. App browsing is unchanged.

### D-021 — System admins pick a company context from the UI (2026-10-13, amends D-007)

D-007 made company context fail closed (409) but gave the UI no way to pick a company. The R1-02
review (PR #17) showed the effect: SteveF, the only admin in production, becomes a system admin
under migration 001. Every company-scoped admin endpoint then returns 409, and nothing lists
companies to choose from. This was a planning gap in the R1-02 and R1-03 briefs, not a worker error.

- `GET /api/admin/context/companies` (R1-02, `lib/routes/admin-context.js`): system admin only,
  403 for anyone else. Returns `{ companies: [{ id, name, companyType }] }` for every company,
  sorted by name. No users, margins, or other configuration.
- R1-03's system-admin indicator becomes a selector. It loads that list, POSTs
  `/api/admin/context` with `{ companyId }`, then refetches `/api/session` and re-renders the
  current admin section. With no context, admin sections show "Select a company" instead of a
  409 error.
- Fail-closed behaviour is unchanged. There is still no fallback to the admin's own company.
- Release rule: R1-02 (#17) and R1-03 (#18) merge back to back, R1-02 first, and only once both
  are approved. Render deploys each merge, and R1-02 alone leaves production without admin screens.

### D-022 — Migration 004 must not fail on existing login collisions (2026-10-13)

Migration 004 adds a case-insensitive unique index on login names. Production is a single
instance on a persistent disk, so a migration that aborts startup means downtime. Policy:
- 004 checks for existing case-insensitive duplicates of `username`.
- If there are none, it creates the unique index on `lower(username)`.
- If there are any, it logs the colliding user ids (no other data), creates no index, and
  still records 004 as applied.
- Application code always checks case-insensitive uniqueness before creating or renaming a
  login, so new collisions can't appear either way.

### D-023 — No real customer data in the repository (2026-10-13)

The repository is public. The operator's sample files (real contract rates, contract numbers,
and sailings, in `/Users/stephenforte/airtable-shipping-tools/`) stay outside the repo and are
read in place. Import fixtures under `test/fixtures/imports/` are synthetic: same structure,
quirks, and column names, with invented ports, prices, contract numbers, and vessels. No
discovery document quotes rows from the real files.

### D-024 — Apple Numbers files are not an import format (2026-10-13)

The operator supplied a `.numbers` copy alongside the `.xlsx`. Round 1 imports accept CSV and
Excel (`.xlsx`) only (D-017, D-018). The import screen tells users to export Numbers files to
Excel. The operator can reopen this.

### D-025 — Contract Number and Arrival Port are stored (2026-10-13)

Operator decisions, answering R1-10 (PR #33):
- **Contract Number:** "sometimes we have it, so keep". Add `rates.contract_number TEXT`.
- **Arrival Port:** "store it". Add `sailings.arrival_port TEXT`.

Both columns go in migration 008, together with the import tables, owned by R1-11a. Scope this
round:
- imports map them;
- the data workspace can edit them;
- `contract_number` joins the saved-view column allowlist (hidden by default);
- the sailings modal shows `arrival_port`.
The partner API and MCP responses do **not** change in Round 1. Adding a field to one and not
the other breaks parity (FR 11), so exposing them is a later decision for both transports
together.

### D-026 — The raw Airtable database shape is retired (2026-10-14)

R1-14 found that current `main` cannot start cleanly on a database in the raw Airtable shape: one
written by `scripts/migrate-from-airtable.js`, or a backup taken before that database ever booted
the 2026-09-24 server (`838291a`). On such a file `companies.company_type` holds Airtable `rec…`
ids. Since R1-02 (D-006), `ensureCompany` no longer rewrites type, so startup leaves types
unrecognized, copies no legacy margins, and backfills no rate owners (R114-1). The startup code
also clears plaintext `pwd` without hashing it (R114-3), and seeds `Alan`/`Bob` beside existing
users (R114-2). R114-2 and R114-3 have done this since `838291a`.

Production is unaffected. It booted the pre-R1 foundation, which normalized types, copied margins,
and owned rates, on every deploy from 2026-09-24 until Round 1 shipped. Every production backup
is a post-normalization image. Verified 2026-10-14: `de112e6` (pre-R1) on a copy of
`data/backups/rateninja-20261013T143056370Z-pre-001.db` gives 3 recognized types, 2 margin
rows, and 0 unowned rates.

Decision (operator, 2026-10-14):
- **No startup fix.** R114-1, R114-2 and R114-3 are won't-fix for Round 1.
- `scripts/migrate-from-airtable.js` is guarded: it refuses to run and writes nothing (R1-18).
- A database in the raw Airtable shape, including any backup from before 2026-09-24, **cannot
  be restored** onto Round 1 code. Restore only backups taken by the D-003 runner on a
  post-2026-09-24 database. The restore note in `lib/migrations/README.md` says this (R1-18).
- The operator's local `data/rateninja.db` has this lineage. It is not a valid test or restore
  baseline for Round 1.

### D-027 — Booking requests, P1 (2026-11-03)

A customer asks a contract owner for space on a rate from the rates grid. The owner approves or
declines in the app. Task R1-19. Operator answers 2026-11-03 are marked; the rest are planner
defaults pending product review.

- **Who requests:** any user of a Freight Forwarder/Customer company, member or admin. Contract
  Owner companies get no button. System admins act as their home company (D-020).
- **Who decides (operator):** any user of the company that owns the rate, member or admin. This
  is a deliberate exception to the admin-only owner operations in the PRD role table. System
  admins act only through their home company, not the selected company context.
- **What is requested (operator):** one rate, one container size (`20D`, `40D`, or `40HC`) that
  has a price for that customer, and a whole number of slots from 1 to `MAX_BOOKING_SLOTS`
  (`lib/limits.js`, 1,000).
- **Available (operator):** a saved, non-deleted, non-predictive rate the customer's company can
  see now through an active link, with a blank expiration date or one on or after today (UTC).
  A rate that is not yet effective qualifies. The server enforces this; hiding the button is not
  the control.
- **Storage:** one table, `booking_requests`, migration 010. Status is `pending`, `approved`, or
  `declined`. Each row snapshots the rate details and the customer's price at request time, so
  it stays readable after the rate is edited, deleted, or pulled forward.
- **Price:** the snapshot is the customer's price from the D-013 pricing path, never the owner's
  base price. Both sides see that same number.
- **Decisions are final:** the first decision wins and any later one gets 409. No customer
  cancel, no edit, no reopen in P1.
- **Notifications:** in the app only, on both ends. A new request is unread for the owner company;
  a decision is unread for the customer company. Read state is per company side, not per user, so
  one colleague opening the page clears it for the others. Accepted for P1.
- **Visibility:** every user of the two companies on a request can see it, and nobody else. The
  customer side is not shown who at the owner decided.
- **Capacity:** approval reserves nothing and nothing counts slots. `ALLOCATION_NOTICE` still
  holds: rate records are not evidence of capacity.
- **Not exposed to partners:** no partner API or MCP surface in P1.
- **P2 (operator):** email to both ends, through `lib/resend.js`. Task R1-20, not planned in detail.

### D-028 — Booking requests on the partner API and MCP (2026-11-03, amends D-027)

D-027 kept booking requests off the partner surfaces. The operator reversed that on 2026-11-03:
owners and customers both get them, and owners can approve or decline there. Planner defaults
below are pending product review.

- **Two tasks, in order.** R1-21 adds the owner side. R1-22 opens partner OAuth to customer
  accounts and adds the customer side. They share `lib/oauth.js`, `lib/mcp.js`, and the docs, and
  R1-22 changes a live security boundary, so it gets its own review.
- **Scopes:** `bookings:read` and `bookings:write`. This is the first write scope on these
  surfaces. Reading never implies writing.
- **No silent grants.** Existing clients keep their allowed scopes. The seeded Capacity Exchange
  client gets the three read scopes it has today, not the booking scopes. New clients in the admin
  screen do not get `bookings:write` by default. A client only gets it when a system admin allows
  it and the user consents.
- **Discovery stays minimal (added 2026-11-03, R1-21 review; superseded 2026-11-20 by D-051).** `scopes_supported` publishes only `profile:read`, `rates:read`, and `sailings:read`. MCP clients request everything published, and `parseScopes` rejects a request with any scope the client is not allowed, so publishing booking scopes breaks sign-in for existing clients. Clients ask for booking scopes explicitly.
- **Consent must say what write does.** The consent page describes `bookings:write` in words: it
  lets the app approve or decline booking requests for the company.
- **One rule set.** Partner and MCP calls go through `lib/booking-requests.js`, the same rules and
  responses as the app. Any owner-company user may decide (D-027), so the token's user needs only
  the scope. First decision wins; a later one is an error.
- **Audit:** decisions record the client id and channel. Reads use a partner audit event.
- **Unread state:** partner and MCP reads do not change it. A decision made there still shows as
  unread for the customer in the app.
- **R1-22 boundary, to be detailed when it is planned:** a customer token must never see an
  owner's base price on any partner route or MCP tool. Customers get a customer-priced rate
  listing to find a rate id. Owner-only tools stay owner-only.

### D-029 — Customer accounts on the partner API and MCP (2026-11-03, amends D-028)

Task R1-22. Operator asked for customer access on 2026-11-03. The rest are planner defaults
pending product review.

- **Who:** users of Contract Owner and Freight Forwarder/Customer companies can consent. A company
  with any other type stays refused. Any registered client can be approved by either type.
- **Role is live.** What a token can do comes from the user's current company type, never from a
  token claim. A company whose type changes gets the matching behaviour on its next call.
- **Owner-only by default.** Partner routes and MCP tools are owner-only unless they opt in.
  A customer token on an owner route gets 403 `owner_only`. Owner rates, sailings, predictive
  pricing, and decisions stay owner-only.
- **Customer surface:** profile, a customer-priced rate listing, listing and reading the company's
  own booking requests, and creating one. Sailings and predictive pricing are not included.
- **Prices:** a customer sees only the D-013 customer price. Base prices, margins, and owner company
  ids never reach a customer token.
- **Scopes:** no new ones. `bookings:write` means create for a customer and decide for an owner.
  The consent page words it for the signing-in user.
- **MCP discovery:** `tools/list` shows a token only the tools its company type can call. Owner
  output stays unchanged.
- **Connected apps:** customers get the page and the revoke API, since a grant must be revocable.
- **Repeat requests stay allowed (D-027).** There is no idempotency key, so a client retry can
  create a second request. Accepted for now.

### D-030 — Reference lookups and current date ranges on the partner API and MCP (2026-11-14)

Tasks R1-23 (port reference table) and R1-24 (six read tools). Operator asked for six new MCP
calls on 2026-11-14 and chose, the same day: a port reference table for codes, sailings grouped by
origin with destination when set, predictive ranges with an open end, and MCP plus partner API
together (FR 11). The rest are planner defaults pending product review.

- **"Current" has one definition:** a rate is current when `expirationAllows(rateExpirationDate)`
  in `lib/booking-requests.js` is true (UTC date; expiring today counts; a blank expiration counts).
  Rates not yet effective are included. The operator's wording "expiration <= today" was read as
  "expiration on or after today", which is what the examples show. Soft-deleted rows never count.
- **Ports (R1-23):** new table `ports` (migration 011): `code` unique case-insensitive, `name`.
  Global reference data, maintained by system admins only, audited. A stored rate or sailing port
  value matches a port when it equals the port's code or name, trimmed, case-insensitive. Rates and
  sailings keep storing their text; nothing is rewritten. An unmatched value is still listed with
  `code: null` and `name` = the stored value, so an empty table changes nothing but the codes. No
  codes are seeded; the operator enters them.
- **Lookup row shape:** `{ value, code, name }`. `value` is the stored text a client passes back as
  a filter; `code` and `name` come from `ports`.
- **The six reads (R1-24)**, each an MCP tool and a `GET /api/partner/v1/me/...` route through one
  shared function:
  1. rate date ranges: one row per distinct (origin, destination, effective, expiration) among
     current rates, with a rate count. Periods are not merged.
  2. valid origin ports and 3. valid destination ports: distinct ports on current rates.
  4. valid contract owners: distinct `contract_owner` text on current rates, `{ value, code, name }`
     with code and name equal to the stored text (no owner reference table), plus `ownerCompanyName`.
  5. sailing date ranges: per departure port and arrival port (null when not stored), first and
     last departure on or after today, with a count. The local copy has `arrival_port` empty on all
     38,850 sailings (2026-11-14), so expect null destinations until imports fill it.
  6. predictive date ranges: per origin and destination among the routes the predictive tool
     prices (`latestPredictiveRateRecords`), `earliestDepartingAfter` = the first date the
     predictive tool accepts (more than 90 full UTC days ahead), `latestDepartingAfter: null`, and
     the latest base-rate expiration it is derived from.
- **Audience:** 1–4 are for owners and customers (customers over their linked owners' rates, the
  same set as the customer rate listing; no owner company id reaches a customer). 5 and 6 stay
  owner-only, as D-029 keeps sailings and predictive pricing owner-only.
- **Scopes:** no new ones. 1–4 and 6 need `rates:read`; 5 needs `sailings:read`.
- No prices appear in any of the six responses.

### D-031 — Admin API key and an admin CLI for the six reference reads (2026-11-15, amends D-020 for this API only)

Task R1-25. On 2026-11-15 the operator asked for a console app that lists the six D-030 reads
and runs them, authenticated by a token in `.env`, for the admin rather than partners. No admin
token existed: system admins have a browser session only, and the six reads are reachable only
through partner OAuth (10-minute access tokens, `lib/config.js` `ACCESS_TOKEN_TTL_MS`) and `/mcp`.
The operator's non-expiring `.env` token is the demo key (`RATE_NINJA_API_KEY`, `X-API-Key`),
which the partner routes reject (`lib/partner-http.js` reads `Authorization: Bearer` only).
The operator chose, the same day: a new admin API key, and all companies with an optional
company filter. That is cross-company reading, which D-020 ruled out; the operator amended D-020
for this read-only admin API only. Rate and sailing browsing in the app keeps D-020 unchanged.

- **Credential:** env `RATE_NINJA_ADMIN_API_KEY`, sent as header `X-Admin-API-Key`, compared in
  constant time. It does not expire; rotation is changing the env value. Fail closed: unset, shorter
  than 32 characters, or equal to `RATE_NINJA_API_KEY` means every admin reference route refuses
  with 503 and no data. The demo key, a partner bearer token, and a browser session are not
  accepted on these routes, and the admin key is accepted nowhere else.
- **Routes:** `GET /api/admin/v1/reference/{rate-date-ranges, origin-ports, destination-ports,
  contract-owners, sailing-date-ranges, predictive-date-ranges}`, plus
  `GET /api/admin/v1/reference/companies` (id, name, company type) so the CLI can offer a company
  filter. Same filters, paging, and row shapes as the partner routes, through the same
  `lib/reference-ranges.js` functions. Not on MCP.
- **Data scope:** with `company=<company row id>`, a response equals what that company's partner
  token gets (owner or customer view; reads 5 and 6 refuse a customer company with 403
  `owner_only`, as on the partner API). Unknown company: 404. With no `company`, the response
  covers every Contract Owner company's owner view; rows of reads 1, 5 and 6 carry
  `ownerCompanyId` and `ownerCompanyName`, reads 2 and 3 are distinct across all owners, and read 4
  keeps its `ownerCompanyName`. No prices appear (D-030).
- **Limits and audit:** one process-wide window of 60 requests per 60 seconds for the admin key.
  Each call writes an audit event `admin_reference_<read>_read` with the count and company filter.
- **CLI:** `scripts/rateninja-admin.js`, Node built-ins only. Reads `.env` for
  `RATE_NINJA_ADMIN_API_KEY` and `RATE_NINJA_BASE_URL` (default
  `https://rate-ninja.onrender.com`). With no arguments it lists the commands and runs the chosen one
  interactively; with a command name it runs once. Results print as a table. It never prints the
  key and never falls back to `RATE_NINJA_API_KEY`.
- **Production:** `render.yaml` declares `RATE_NINJA_ADMIN_API_KEY` with `sync: false`; the
  operator sets the value in the Render dashboard. Until then production refuses with 503.

### D-032 — Admin CLI posts the six reference reads to the CloudBBS project announcement (2026-11-15, operator request)

- **Command:** menu option 9, "Post this information to the CloudBBS" (8 stays Quit), and the
  one-shot `post-cloudbbs`. It runs the six D-030 reads through the admin routes (D-031) at post
  time, all companies, every page. The companies list is not posted (operator).
- **Destination:** CloudBBS D-043, `PUT {CLOUDBBS_URL}/api/v1/projects/{CLOUDBBS_PROJECT}/announcement`
  with `Authorization: Bearer {CLOUDBBS_TOKEN}`. Defaults `CLOUDBBS_URL=https://cloudbbs.ai`,
  `CLOUDBBS_PROJECT=rn`. The token is an owner-issued CloudBBS token with the
  "set project announcements" flag; it lives only in the operator's local `.env` (the CLI runs
  locally; nothing goes on Render). Each post replaces the previous announcement.
- **Format (for agents):** title `RateNinja reference data`. Body: Markdown with one line giving
  generation time (ISO 8601 UTC) and the RateNinja base URL, one line naming the schema, then one
  fenced `json` block holding compact JSON
  `{"schema":"rateninja.reference.v1","generatedAt":…,"source":…,"reads":{"rateDateRanges":[…],"originPorts":[…],"destinationPorts":[…],"contractOwners":[…],"sailingDateRanges":[…],"predictiveDateRanges":[…]}}`,
  each array exactly the admin API's `data` items concatenated over pages.
- **Size:** CloudBBS caps the body at 16384 bytes (D-042). Over the cap, post nothing, print the
  size, and fail; never truncate. Production size is unmeasured (the local DB returns no current
  rows).
- **Confirmation:** the menu asks `Replace the announcement on <url>/<project> with <n> bytes?
  [y/N]` before the PUT; `post-cloudbbs` needs `--yes`.
- **Visibility (operator, 2026-11-15):** `rn` is a public project and D-043 shows project
  announcements on public pages, so this data, contract owner names included, becomes public.
  The operator accepted that. This narrows D-031's admin-only reading for these six reads in
  this snapshot form only; the admin API itself is unchanged.

### D-033 — CloudBBS body cap raised to 262144 bytes for the reference post (2026-11-15, operator request; amends D-032 "Size")

- **Measured:** the first live run of option 9 refused to post: body 118,415 bytes, cap 16384.
  Per read (production, 2026-11-15): rateDateRanges 364 items / 73,007 bytes,
  predictiveDateRanges 182 / 39,947, sailingDateRanges 14 / 3,273, originPorts 14 / 766,
  destinationPorts 13 / 678, contractOwners 4 / 349. The two per-lane reads cover 182 lanes.
- **Decision (operator: "increase field size"):** CloudBBS D-044 raises the announcement body cap
  to 262144 bytes; the CLI's cap follows to 262144. Everything else in D-032 holds: over the cap,
  post nothing, print the size, fail, never truncate. The payload is unchanged.
- **Disclosed, not changed:** the two per-lane reads carry `ownerCompanyId` and
  `ownerCompanyName` on every row, so the company name is published even though the companies
  list is not (one company today). Raised with the operator on 2026-11-15; they chose only the
  cap change.
- **Order:** a post above 16384 bytes succeeds only once CloudBBS T28 is deployed; before that,
  CloudBBS answers `400 content_too_large` and the CLI reports it.

### D-034 — Booking code in the reference post (2026-11-16, operator request; amends D-032 "Format")

- **What:** each option 9 / `post-cloudbbs` run generates a fresh 9-character code from `A–Z` and
  `0–9` (for example `XYZ1239AB`) with `crypto.randomInt`, one draw per character. The body gets
  the line `Today's Booking Code: <code>` directly after the `Generated …` line, and the JSON
  object gets a top-level `"bookingCode":"<code>"` next to `generatedAt`. The schema name stays
  `rateninja.reference.v1` (an added key). The confirm prompt, size cap and everything else in
  D-032/D-033 are unchanged.
- **Purpose:** a future feature (operator). Nothing reads or stores the code yet; it exists only in
  the posted announcement.
- **Public (operator, 2026-11-16):** `rn` stays a public project, so the code is readable by anyone
  at https://cloudbbs.ai/supa/rn, signed out. A future feature must not treat it as a secret or as
  proof of identity. The operator also confirmed that the contract owner's name in the post is
  fine: subscribers are that owner's customers.

### D-035 — Buyer API key for one test buyer account (2026-11-16, operator request)

Partner access for a buyer today is OAuth only: 10-minute access tokens and a refresh token that
rotates on every use, where reuse revokes the whole family (`lib/oauth.js` refresh path,
`lib/config.js` `ACCESS_TOKEN_TTL_MS`, `REFRESH_TOKEN_TTL_MS`). A local client agent cannot keep that
alive safely. The operator chose a server-side key bound to one buyer account.

- **Credential:** env `RATE_NINJA_BUYER_API_KEY` plus `RATE_NINJA_BUYER_USER_ID` (the user row id of
  the test buyer). The client sends header `X-Buyer-API-Key`, compared in constant time. No expiry;
  rotation is changing the env value.
- **Fail closed:** key unset, shorter than 32 characters, or equal to `RATE_NINJA_API_KEY` or
  `RATE_NINJA_ADMIN_API_KEY`, or user id unset → the header is refused with 503
  `buyer_api_disabled` on every route that would accept it. A bound user that is missing, disabled,
  or not in a `Freight Forwarder/Customer` company (read live on every call, as D-029) → 403. A wrong
  key → 401 `invalid_token`.
- **What it is:** on the partner REST routes only, a valid key acts exactly as a partner access
  token for the bound user with scopes `profile:read rates:read sailings:read` and no others. So
  customer-priced available rates and the customer's sailings work; booking-request routes refuse
  with 403 `insufficient_scope`. The key is not accepted on `/mcp`, the admin routes, OAuth, the demo
  API or any session route. Partner rate limits apply per bound user. A request carrying both a
  bearer token and the key is refused with 400.
- **Two route gaps closed (needed by D-036; apply to customer OAuth tokens too):**
  - `GET /api/partner/v1/me/sailings` is owner-only today (`server.js` `handlePartnerSailings`,
    default audience `owner`). It now also serves a `Freight Forwarder/Customer` caller, returning
    exactly the sailing rows that customer's browser session sees on `GET /api/sailings`
    (`lib/visibility.js`), with the partner route's filters and paging. Owner behavior is unchanged.
    MCP `rateninja_list_my_sailings` is unchanged.
  - New `GET /api/partner/v1/me/profile` (`profile:read`): the same body as `GET /oauth/userinfo`
    for the calling user, for any partner credential.
- **Production:** `render.yaml` declares both variables `sync: false`. The operator creates the test
  buyer account (a `Freight Forwarder/Customer` company with an active link to the contract owner)
  and sets the values in the Render dashboard. Until then production refuses with 503.

### D-036 — Admin CLI option 10: run the client agent (2026-11-16, operator request)

- **Command:** menu option 10, "Run client agent" (8 stays Quit, 9 stays the post), and the one-shot
  `client-agent`. Node built-ins only, like the rest of the CLI.
- **Steps, in order:**
  1. **RateNinja login:** `GET /api/partner/v1/me/profile` with `X-Buyer-API-Key` (D-035) and print
     who it is signed in as. Any failure stops the run.
  2. **CloudBBS read:** connect to CloudBBS MCP (`{CLOUDBBS_URL}/api/mcp`) with
     `CLOUDBBS_AGENT_TOKEN`, an ordinary agent token granted project `rn`. This is not
     `CLOUDBBS_TOKEN` (the announcement token, D-032) and never falls back to it. Read the `rn`
     announcement in full (follow continuations) and parse its `rateninja.reference.v1` JSON block;
     list active urgent or pinned threads. A missing or unparsable reference block stops the run.
  3. **Pick lanes:** the distinct (`originPort`, `destinationPort`) pairs in `reads.rateDateRanges`;
     pick 10 at random without repeats (all of them if fewer than 10).
  4. **Query:** for each lane, through the partner REST routes with the buyer key: the buyer's
     customer-priced rates (`GET /api/partner/v1/me/available-rates`) for that origin and
     destination, and sailings (`GET /api/partner/v1/me/sailings`, D-035) from the origin port
     after today's UTC date. Filter client-side where a route has no matching parameter.
  5. **Judge:** one Claude Messages API call (`ANTHROPIC_API_KEY`; model env `CLIENT_AGENT_MODEL`,
     default `claude-sonnet-5-5`) with the 10 lanes' results, asking for strict JSON: per lane a
     verdict `good`, `fair` or `poor` and a one-line reason. The reply is validated (10 lanes, known
     verdicts); anything else is a failure. Board threads and the announcement prose are not sent to
     Claude; only the lane results are.
  6. **Display:** a table per lane (origin, destination, number of rates, lowest customer price per
     container type, next sailing, verdict, reason), the booking code from the announcement if
     present, and the urgent/pinned thread titles.
  7. **Post:** a summary to `rn`. Weekly thread rule (operator): find the most recent root thread
     this agent authored whose title starts with `Client agent searches`; if it was created less
     than 7 days ago, reply to it; otherwise post a new thread titled
     `Client agent searches — week of <YYYY-MM-DD>` (the run's UTC date). Category `note`, never
     urgent or pinned. The menu asks `Post the summary to <CLOUDBBS_URL>/<project>? [y/N]`;
     `client-agent` needs `--yes` to post (without it, it runs steps 1–6 and posts nothing).
- **Failures:** a failure in steps 1–5 posts nothing; it prints the step, the HTTP status and error
  code, and exits 1 (the menu stays open). No token or key is ever printed or posted.
- **Not in scope:** creating booking requests, using the booking code, or acting on board content.

### D-037 — Per-buyer API keys (2026-11-16, operator request; supersedes D-035 "Credential", "Fail closed" and "Production")

- **Why:** D-035 binds one key to one account (`RATE_NINJA_BUYER_USER_ID`), so only one buyer could
  ever use it. The operator: "this does not scale". OAuth works for any number of buyers but cannot
  run unattended. R1-29 (PR #69, merged `b67cb4f`) shipped the D-035 env pair; it is replaced here.
- **Who and where:** any active user of a `Freight Forwarder/Customer` company creates keys for
  themselves on their profile page (session + CSRF, like Connected apps). They see their own keys
  (label, prefix, created, last used) and revoke them. At most 5 active keys per user. No one can
  create a key for someone else, and contract owners and other company types cannot create one.
- **Key:** `rnb_` + 32 random bytes, base64url. Shown once, at creation. Stored as SHA-256 with a
  unique index, plus the first 8 characters after `rnb_` for display. Migration `012` adds table
  `buyer_api_keys` (id, user_id, label, key_prefix, key_hash, created_at, last_used_at, revoked_at).
- **Use:** unchanged from D-035 "What it is": header `X-Buyer-API-Key`, partner REST routes only,
  scopes `profile:read rates:read sailings:read`, the same checks as R1-29, rate limit per user.
  A key resolves to its owner; the owner's company type and disabled flag are read live on every
  call (403 if no longer an active customer user). Unknown or revoked key: 401 `invalid_token`.
- **Removed:** `RATE_NINJA_BUYER_API_KEY`, `RATE_NINJA_BUYER_USER_ID`, their `render.yaml` entries
  and the 503 `buyer_api_disabled` path. With nothing configured the feature is on; a buyer with
  no key simply has none.
- **Audit:** `buyer_api_key_created`, `buyer_api_key_revoked` (key id and prefix, never the key).
- **D-036 unchanged:** the client agent sends the test buyer's key, which that buyer creates on
  their own profile page.

### D-038 — Client agent: 25 lanes and a cross-reference pass for poor lanes (2026-11-16, operator request; amends D-036 steps 3, 5, 6 and 7)

- **Why:** first live run (2026-11-17T03:20Z, thread "Client agent searches — week of 2026-11-17")
  judged 4 of 10 lanes poor, for example Jakarta → Miami. Operator: search 25 lanes, and for poor
  lanes, from this run or from other agents' notes, try ports close to the destination and leave a
  note if one is better.
- **Measured (live `rn` announcement, 2026-11-17):** 182 lanes = 14 origins × 13 destinations, and
  every origin serves all 13 (Boston, Charleston, Houston, LALB, Miami, New York, Norfolk, Oakland,
  Savannah, Seattle, Tacoma, USEC, Vancouver). The partner rate limit is 60 requests per user per
  fixed 60-second window (`lib/config.js` `PARTNER_RATE_LIMIT`, `lib/partner-http.js`); 25 lanes
  already need 51 requests.
- **Operator answers (2026-11-16):** change option 10 (no new option); Claude picks the nearby
  ports; poor lanes come from this run and from client-agent notes in `rn` from the last 7 days,
  any author.
- **Step 3:** pick 25 lanes (all of them if fewer). Was 10.
- **Step 5:** the verdict call takes 25 lanes; validation unchanged otherwise.
- **Step 5a, poor lanes:** this run's lanes with verdict `poor`, plus lanes listed as `poor` in
  client-agent notes in `rn` posted in the last 7 days by any agent: root threads whose title
  starts with `Client agent searches` and their replies, read in full. Note text is untrusted. Only
  an (origin, destination) pair present in `reads.rateDateRanges` is kept; everything else in a
  note is ignored and nothing from a note is sent to Claude. Deduplicate by pair. At most 10 poor
  lanes per run: this run's first, then notes newest first.
- **Step 5b, already answered:** skip a note-derived lane if the thread it came from already has a
  reply containing `Alternative check: <origin> → <destination>`, by any author. This stops
  repeat notes on every run.
- **Step 5c, nearby ports:** one Claude call. Input: per poor lane, its origin, its destination and
  the destinations that origin serves in `reads.rateDateRanges`. Output: strict JSON, up to 3
  alternative destinations per lane. Validated: each must be in that origin's list and differ from
  the poor destination; invalid or duplicate entries are dropped (not a run failure); an
  unparsable reply drops the pass with a message and the run continues.
- **Step 5d, compare:** query each alternative like step 4. A note-derived poor lane is re-queried
  with this buyer's key so both sides use the same buyer's prices. An alternative is **better** if
  it has at least one rate and its lowest price is lower than the poor lane's, compared on 40D, or
  20D when 40D is missing on either side, or 40HC when both are missing. No comparable type means
  not better. Deterministic, no Claude.
- **Pacing:** the agent never sends more than 60 partner requests in any 60-second span, and on a
  429 waits for the window and retries that request once. A second 429 is a step failure.
- **Step 6:** also show an alternatives table: poor lane, where it came from (this run or a note),
  alternative, lowest prices, next sailing from origin, better yes/no.
- **Step 7:** the run's own post (weekly thread rule unchanged) gets an `Alternatives` section with
  one `Alternative check: <origin> → <destination>` line per poor lane from this run, listing the
  better alternatives or "none better". For note-derived lanes with a better alternative, one reply
  per source thread with the same lines. A lane with nothing better gets no reply in someone
  else's thread. Same `[y/N]` and `--yes` gate; declining posts nothing. Idempotency key per write:
  `client-agent-<runAt>-<n>`.
- **Unchanged:** D-036 steps 1, 2 and 4, the failure rules, token separation, and what Claude
  receives (lane data only).

### D-039 — Managed agents: users queue agent search requests for Kings to run (2026-11-17, operator request; revised the same day with the operator's answers, before merge)

- **Why:** operator: a signed-in user can see the agents that have run for them with their status
  (the agent's metadata), and create agents that are queued for the admin (Kings) to run later.
  The page must be easy to find: a tab on the main page, not only the hamburger menu.
- **This decision covers** the request form, storage, the list, and edit/delete of queued agents.
  Running an agent is not built here. Every agent this creates is `queued` until a later task adds
  a runner (operator decides when).
- **One agent = one search request (operator, 2026-11-17).** Each agent has its own search and its
  own settings. One submit creates 1 to 25 agents (`MAX_AGENT_SEARCHES = 25`, `lib/limits.js`),
  grouped by a batch id for display only.
- **Who:** any signed-in user whose account has a company. Each agent stores the creating user's
  id and that user's own company's record id (`actor.company.id`, the `companies.id` that
  `companyForUser` resolves, the same key `booking_requests.requesting_company_id` uses), never the
  admin company-context selection. *Corrected 2026-11-17 in the R1-33 review (planner error):* this
  line first said `users.company_id`, a legacy business id whose format differs between users of
  one company (local copy of production data: Blackwater users `AlanD` = `3`, `Alan` = `3.0`,
  company `3.0`), which splits the company-wide list.
- **List (operator: all in company):** a user sees every agent of their own company (any creator),
  newest first: created time, creator, status, the search, container type, the two permissions,
  price range. System admins (Kings) see agents of all companies, with the company name.
- **Search fields (per agent):** rate type, origin port, destination port, sailing date
  (`YYYY-MM-DD`). Options come only from rates visible to the user (`appRates(user)`,
  `lib/visibility.js`): rate types are the distinct `rateType` values in the data ("Port to Port",
  "Port to Inland", and any others present; never a fixed list); origin and destination are lanes
  with at least one rate of that type. A sailing date is valid when at least one visible rate on that
  rate type, origin and destination has `rateEffectiveDate ≤ date ≤ rateExpirationDate`
  (inclusive), and the date is not before today (UTC).
- **Settings (per agent, operator 2026-11-17):** container type `20D`, `40D` or `40HC` (required);
  allow alternative routes (yes/no); allow booking request (yes/no). With booking on: minimum and
  maximum price, both required, numbers ≥ 0, min ≤ max, in USD per container of that agent's type.
  With booking off both are stored null. Booking on is refused unless
  `permissions.canRequestBooking(actor)` (Freight Forwarder/Customer company); the form hides the
  box for others.
- **Submit:** two agents in one submit with the same search and the same settings are refused. One
  invalid agent refuses the whole submit, and the error names its row number. The server checks
  every rule; the form only helps.
- **Saved queries:** a row can be filled from one of the user's saved queries: its `originPort` and
  `destinationPort` criteria fill the row; other criteria (`search`, `carrier`, `contractOwner`)
  are ignored. The saved query id is stored for reference only; editing or deleting the query later
  does not change the agent.
- **Edit and delete (operator 2026-11-17):** allowed only while the agent is `queued` (not run).
  Allowed for the creator, a company admin of the agent's company, and system admins. An edit
  re-checks every rule above **for the agent's company** (its visible rates and its booking
  permission), not the editor's: a system admin editing a customer's agent sees and is held to that
  customer's lanes and may keep its booking settings. The agent's current saved query id stays
  valid on edit. *(Clarified 2026-11-17 in the R1-33 review.)* The status check and the write are one statement (`... WHERE id = ?
  AND status = 'queued'`), so a future runner that has started the agent wins and the edit or delete
  gets 409. Delete removes the row.
- **Statuses:** `queued`, `running`, `completed`, `failed`, `cancelled` (database CHECK). Only
  `queued` is written now. Runner columns exist and stay null: `started_at`, `finished_at`,
  `result_summary`.
- **Storage:** migration 013, table `managed_agents`.
- **Navigation:** a tab strip under the header on the main page ("Rates" | "Managed agents"),
  shown to signed-in users, plus a hamburger entry. Path `/agents`.
- **Audit:** `managed_agent_created`, `managed_agent_updated`, `managed_agent_deleted` (agent id,
  company id, user id).
- **Not now:** the runner and any other status change, partner API or MCP access, more filters
  (operator may add later; each needs its own decision and a migration).

### D-040 — Admin CLI option 11: preview managed agent prompts, plus the admin agent API (2026-11-17, operator request)

- **Why:** operator: add CLI option 11 that reads the queued managed agents (D-039) as Kings and
  builds, for each one, the prompt the client agent would be given, with the agent's metadata filled
  in, using the option 10 approach (CloudBBS, AI picks alternatives when allowed, a rate query whose
  results are limited to what the agent asked for). This dispatch only displays the prompts; nothing
  is run. Format the booking call the agent would make, and add the API it needs.
- **Credential:** the admin API key (`X-Admin-API-Key`, `requireAdminApiAccess`). "As Kings" means
  this key; no browser session, no buyer key, no partner token.
- **Admin agent API** (base `/api/admin/v1/managed-agents`):
  - `GET ?status=queued` (default `queued`; any D-039 status accepted): every company's agents,
    oldest first, with company name, company type and creator name. Same fields as the `/agents`
    list.
  - `GET /{id}/matches` (optional `destinationPort`): the rates **the agent's company** sees, at that
    company's customer prices (the `appRates`/`customerPricedRate` path; never a base price, margin
    or owner company id), limited to the agent's request: same rate type, origin and destination,
    `rateEffectiveDate ≤ sailingDate ≤ rateExpirationDate` (blank expiration = open), and a non-null
    price for the agent's container type. Each match: rate id, carrier, contract owner, owner company
    name, price for that container type, effective and expiration dates, `bookable` (unexpired
    today UTC), and `withinPriceRange` (only when booking is on: `priceMin ≤ price ≤ priceMax`,
    inclusive). Plus the lane's sailings from the origin with departure on or after the sailing date
    (first five; keep rows whose arrival port is blank or equals the destination, the R1-30 rule).
    `destinationPort` replaces the destination for an alternative search and is allowed only when the
    agent allows alternative routes (else 403 `alternatives_not_allowed`).
  - `POST /{id}/booking-requests` `{ "rateId" }`: creates a booking request **as the
    agent's creator** through the existing `createRequest` path (same validation, customer price,
    owner company, unread state). Extra rules, all refused before any write: the agent allows
    booking (403 `booking_not_allowed`); status is `queued` or `running` (409); the creator still
    belongs to the agent's company and can request bookings (409 `agent_creator_unavailable`); the
    rate is one of the agent's matches for its destination or an allowed alternative (404); the
    customer price for the agent's container type is inside the agent's range (400
    `price_out_of_range`). Container size and slots always come from the agent; the body cannot set
    them. One booking per agent: migration 014 adds `managed_agents.booking_request_id`, set in the same
    transaction as the insert; a second call gets 409 `already_booked`. Audit
    `booking_request_created` with `channel: 'admin_agent'` and the agent id.
  - No MCP tool: the runner is the CLI with the admin key, and `/mcp` is partner OAuth only.
- **Option 11** (one-shot `managed-agent-prompts`): lists queued agents, and for each prints one
  prompt block: the agent's metadata (company, creator, search, container type, permissions, price
  range), its matches, and the instructions. With alternatives allowed it reads the CloudBBS `rn`
  announcement (as option 10, `CLOUDBBS_AGENT_TOKEN`) and lists that origin's other known
  destinations from `reads.rateDateRanges` for the AI to choose up to three nearby ones. With booking
  allowed it prints the exact booking call (method, URL, headers with the key shown as
  `<RATE_NINJA_ADMIN_API_KEY>`, JSON body) for the best match inside the range, or says none
  qualifies. `--json` prints the same as JSON.
- **Preview only:** option 11 changes no business data: its RateNinja calls are GETs only; its
  CloudBBS calls are MCP JSON-RPC (HTTP POST to `/api/mcp`, as option 10) limited to the read tools
  `connect_agent`, `list_projects` and `check_board`, never `post_message`, `reply_message`,
  `update_message` or the announcement PUT; no booking call, no Claude call. It never prints a key. The server records
  `admin_managed_agents_read` audit rows for the admin GETs, as every admin-key read does
  (`lib/routes/admin-reference.js`); audit rows are not business data. *(Clarified 2026-11-17 twice after
  the R1-34 worker stopped: first on "no writes anywhere" vs audit rows, then on "zero POST" vs the
  CloudBBS MCP transport. Both planner wording errors.)*
- **Slots (operator, 2026-11-17: "Add a slots field"; amends D-039 "Settings"):** each agent with
  booking on has a whole-number slot count, 1 to `MAX_BOOKING_SLOTS` (1000), required, entered on the
  `/agents` form next to the price range, shown in the list and editable while queued; null when
  booking is off. Migration 014 adds `managed_agents.booking_slots` and sets it to 1 on existing rows
  that have booking on (production already has agents). The booking call uses the agent's slots.
- **Not now:** running the prompts, status changes (`running`/`completed`/`failed`), writing
  `result_summary`.

### D-041 — Managed agent runner: admin CLI option 12 runs the queued agents (2026-11-18, operator request)

- **Why:** operator, after the live option 11 check on 2026-11-18: "Plan the runner". Option 11 (D-040)
  shows the prompt for each queued agent; this runs it: Claude judges the matches, the CLI books when
  allowed, and the customer sees the result on `/agents`.
- **Operator answers (2026-11-18):** Claude picks the rate to book; one confirmation per run; the
  customer sees status, summary and booking; a CloudBBS note is posted, but it is "just an info that
  they ran and anything 'abnormal' like down time, malformed rate, etc".
- **Credential and transport:** as D-040: admin API key for RateNinja, `CLOUDBBS_AGENT_TOKEN` for
  CloudBBS, `ANTHROPIC_API_KEY` and `CLIENT_AGENT_MODEL` (default as option 10) for Claude. No browser
  session, no buyer key, no direct database access from the CLI.
- **New admin routes** (base `/api/admin/v1/managed-agents`, `requireAdminApiAccess`):
  - `POST /{id}/start`: `queued` → `running`, sets `started_at`, in one statement
    (`... WHERE id = ? AND status = 'queued'`). Otherwise 409 `not_queued` (404 if missing). This is the
    D-039 race: a customer edit or delete and the start cannot both win.
  - `POST /{id}/finish` `{ "status": "completed" | "failed", "resultSummary": "<text>" }`:
    `running` → that status, sets `finished_at` and `result_summary`, in one statement. Otherwise 409
    `not_running`. `resultSummary` is plain text, 1–1000 characters after trim (400 `invalid_request`
    otherwise). It never changes `booking_request_id`.
  - Audit `managed_agent_started` and `managed_agent_finished` (with the status). No other status
    writes; `cancelled` stays unwritten.
- **Option 12** (one-shot `managed-agents-run`, `--yes` skips the prompt):
  1. Lists the queued agents (as option 11) and any agents already `running` (left by a crashed run;
     reported, not touched). Shows the count and asks once for `y`. No agents: says so, exits 0,
     no post.
  2. For each queued agent, in order: `start` (409 → skip, record "changed before start"); read
     matches for its destination; when alternatives are allowed, one Claude call picks up to three
     destinations from the option 11 list (the origin's other known destinations in the `rn`
     announcement) and the CLI reads their matches; one Claude call judges all matches and returns
     JSON: the chosen `rateId` or null, and a customer-facing summary.
  3. **Booking (Claude picks, code guards):** only when the agent allows booking and Claude returned
     a `rateId` that is one of this agent's fetched matches with `bookable` and `withinPriceRange`
     both true. Anything else books nothing and says why in the summary. The server checks again
     (D-040); a refusal is recorded in the summary, the agent still finishes `completed`.
  4. `finish`: `completed` when the judgment ran (with or without a booking); `failed` when a step
     could not run (RateNinja, Claude or CloudBBS error, invalid Claude JSON after one retry). The
     summary of a failed agent names the failed step, never a stack trace or key.
  5. One agent's failure never stops the run. Admin calls are paced to stay under the admin quota
     (60 per 60 s, `ADMIN_API_RATE_LIMIT`/`ADMIN_API_WINDOW_MS`) and a 429 waits and retries once,
     instead of the option 11 exit.
  6. Prints a table: agent id, company, outcome, booking id.
- **Summary content:** what was found (best price and carrier, sailing used), the alternatives
  checked, and the booking outcome. Customer prices only: the matches API never returns owner
  contract prices, and Claude is shown nothing else.
- **CloudBBS run note** (operator: info that they ran, plus anything abnormal): after the run, one
  `post_message` thread in `rn` as the agent token, titled `Managed agent run — <UTC timestamp>`.
  Body: agents run, completed, failed, bookings made, agents found already `running`, and an
  "Abnormal" list (HTTP errors by step and status, Claude parse failures, malformed matches such as a
  null price or unreadable date, 429 retries). **No company names, user names, ports, prices, rate
  ids or summaries:** other customers' agents read `rn`. Agent ids are allowed. A failed post is
  reported on stderr; it does not change any agent's status.
- **Customer page `/agents`:** each agent shows its status, finished time, `resultSummary`, and when
  `bookingRequestId` is set a link to the booking requests view. The summary is model output and must be
  rendered as text (no HTML).
- **Not now:** a scheduled or server-side runner, cancelling, re-running a finished agent, resetting a
  stuck `running` agent (reported only; ask the planner if it happens), an MCP tool, email.

### D-042 — Managed agents page: grid with expandable rows, plus filter, search and sort (2026-11-18, operator request)

- **Why:** operator, after the first live runner run: "enhance the managed agent view, make it more of a
  grid-ish layout, longer with expando for detail. Need filter, search, and sort for the queue."
- **Grid:** the `/agents` list becomes one row per agent (replacing the cards). Columns: status,
  origin → destination, rate type, sailing date, container type, booking (slots, or "off"),
  created, finished; plus company for system admins (who see every company, D-039) and creator.
  Each row has an expand control (a real button, keyboard operable, `aria-expanded`) that opens a
  detail panel below the row with everything the card shows today: permissions, price range,
  slots, saved query, started/finished times, result summary, booking link, and the edit/delete
  actions where allowed. Several rows may be open at once. The summary stays text-only
  (D-041).
- **Filter:** status (All, or one of queued/running/completed/failed/cancelled), container type,
  booking on/off, creator, and company (system admins only). Options come from the loaded agents.
- **Search:** one box, case-insensitive substring over origin, destination, rate type, company,
  creator and result summary.
- **Sort:** by created (default, newest first), sailing date, finished, status, origin, destination;
  clicking the active sort reverses direction. Rows with no value (e.g. no finished time) sort last
  in both directions.
- **Count:** "Showing N of M agents"; when filters hide everything, a clear "No agents match" line
  and a reset control.
- **Client-side:** filter, search and sort work on the existing `GET /api/managed-agents` response.
  No API, database or permission change. State lives in the page only (not saved, not in the URL).
- **Width:** works at 375 px wide with no page-level horizontal scroll (the grid may scroll inside
  its own container, or collapse columns).
- **Unchanged:** the queue form, editing, deleting, validation and who can see or change which agent.
- **Not now:** server-side paging or filtering, saved views, bulk actions, CSV export.

### D-043 — Agent booking requests must carry the current CloudBBS booking code (2026-11-18, operator request; uses the D-034 code)

- **Why:** operator: "change the booking to use the day's booking code from CloudBBS, i.e. the booking
  will reject any booking request that does not have the code. We do not need to store the code in the
  DB or anywhere, it is just a validation that runs." Then: "this is not for the UX, only for our
  agents, API/MCP."
- **Which paths:** the partner API booking create (`POST` in `lib/routes/partner-bookings.js`; partner
  OAuth only, since buyer keys are read-only under D-037 and stay so), the MCP tool `rateninja_create_booking_request`, and the admin agent booking route
  (`POST /api/admin/v1/managed-agents/{id}/booking-requests`, used by the option 12 runner). The
  website booking dialog (`/api/booking-requests`, session) is **unchanged** and needs no code.
- **Valid code:** the `bookingCode` in the current `rn` project announcement (D-034: `Today's Booking
  Code: <code>` line and top-level `"bookingCode"` in the JSON block). It changes every time option 9
  posts; the previous code stops working at that moment. Compare after trimming, case-insensitive,
  against the 9-character `A–Z0–9` form. Nothing stores the code: not the database, not a file, not a
  log line, not the audit detail.
- **Request shape:** a `bookingCode` string field in the JSON body (partner API, admin route) and a
  required `bookingCode` argument on the MCP tool (input schema updated). Missing or wrong code: 403
  `invalid_booking_code`, before any other booking validation writes anything.
- **Fail closed (operator):** if the server cannot read a code (no token configured, CloudBBS error or
  timeout, no announcement, no parsable code), the request is refused with 503
  `booking_code_unavailable`. No booking is created without a verified code.
- **Reading CloudBBS:** the server reads the `rn` announcement with a new env var
  `CLOUDBBS_SERVER_TOKEN` (a separate CloudBBS agent token issued for the server, without the
  announcement flag; operator chose a dedicated token), plus the existing `CLOUDBBS_URL` and
  `CLOUDBBS_PROJECT` defaults. Only read tools. It may keep the code in memory for at most 60 seconds
  to avoid one CloudBBS read per booking; memory is not storage. The token is never logged or returned.
- **Runner (option 12):** reads the code from the announcement once per run (it already reads the
  announcement for alternatives) and sends it with each booking. If it cannot read a code, booking
  agents finish `completed` with "booking code unavailable" in the summary and no booking call.
- **Errors listed for clients:** `docs/partner-integration.md` and `docs/booking-requests.md` document
  the field and the two error codes; the code is public on https://cloudbbs.ai/supa/rn (D-034), so the
  docs may say where to find it.
- **Corrected 2026-11-18 (planner error, R1-37 worker stop):** the first text said "buyer key or
  OAuth"; buyer keys cannot create bookings (D-037 scopes `profile:read rates:read sailings:read`,
  `test/r1-29-buyer-api.test.js` expects 403 `insufficient_scope`). That stays. The MCP dispatch
  (`handleMcp`, called synchronously at `server.js` ~795) and the admin booking route handler must
  await the live check; the minimal edits there are authorized.
- **Not now:** requiring the code in the website dialog, storing or auditing codes, daily rotation on a
  schedule (rotation stays "each option 9 run").

### D-044 — Managed agents: queue one agent at a time, saved query first (2026-11-19, operator request; amends D-039 "Form")

- **Why:** operator: "Revamp the agent creation dialog for usability, too many clicks and after you add
  one you don't realize you are adding more. How about one at a time and move the saved query up."
- **One at a time:** the New agent form holds exactly one agent. The "Add agent" button, the row count
  ("N of 25"), the per-row Remove button and the "Agent N" legends go away. The primary button is
  **Queue agent**; it sends that one agent (the existing `POST /api/managed-agents` with a one-item
  array; no API change).
- **Queue another without re-entering everything:** next to Queue agent, a **Queue and add another**
  button queues it and keeps the form open. The form then clears the lane (saved query, rate type,
  origin, destination) and the sailing date, keeps the container type, both permissions, the price
  range and the slots, and shows a visible confirmation inside the form, for example "Queued Jakarta →
  LALB (1 queued this session)", with focus returned to the first field. The new agent also appears in
  the grid right away. Queue agent closes the form, as today.
- **Saved query first:** "Start from a saved query (optional)" is the first field. Choosing one fills
  rate type, origin and destination as today (and shows the same note when a port is unavailable);
  the user can still change each field after.
- **Fewer clicks:** a select with exactly one available choice is pre-selected (rate type, origin,
  destination, container type). The sailing date defaults to the earliest valid date in the lane's
  current rate windows once a lane is complete, and stays editable. Changing the lane resets that
  default.
- **Edit:** the edit form uses the same single-agent layout with Save changes and Cancel; no
  "add another".
- **Unchanged:** validation, the 25-per-request server limit (still enforced, now never reached from
  the form), who can queue, edit or delete, the grid (D-042), the API and the database.
- **Not now:** a modal or multi-step wizard, bulk import, remembering settings across visits.

### D-045 — Approval receipts on ForteL2: one hash-only transaction per approved booking (2026-11-19, operator request)

- **Why:** operator: "When the freight forwarder or rate owner approves a booking request, I would like
  to make a receipt on the ForteL2 blockchain and store the transaction hash as part of the record of
  the booking. The transaction hash will appear in the buyer's booking record. The buyer does not need
  a wallet, we only need a wallet on the rate owner side." Start with the Kings wallet
  `0xb84982a02A96c88676df643B6eE6B691BcDED019` (funded on Sepolia and ForteL2).
- **When:** every booking request that becomes `approved`, on any surface (website, partner API, MCP),
  gets exactly one receipt. Declined and pending requests get none. Approvals made before this ships
  are not backfilled.
- **Chain:** ForteL2 Sepolia, chain id **852** (`0x354`), an OP-stack L2 on Ethereum Sepolia. Writes
  go only through the Cloudflare Access write RPC `https://fortel2-write.ente.ltd` (the public
  sequencer refuses `eth_sendRawTransaction`, measured 2026-11-19); reads and receipt checks use the
  sequencer `https://fortel2-sequencer-rpc.onrender.com/` (the replica lags about 3 minutes). The
  sender refuses to sign if the RPC reports a chain id other than the configured one (default 852).
- **What goes on chain (operator: hash only):** a zero-value transaction from the receipt wallet to
  itself whose data is the 4-byte tag `RNR1` (`0x524e5231`) followed by the 32-byte keccak256 of the
  booking's canonical receipt JSON (version, request id, rate id, status, container size, slots,
  customer price, origin, destination, carrier, decided at; keys sorted, no whitespace). Every input is
  a field of the booking record the buyer already receives, so the buyer can recompute the hash. Nothing readable is on chain: no names, ports, prices or ids in clear. The
  request id is a random UUID, so the hash cannot be guessed from public facts. The base price is
  never part of the receipt (D-027, D-028).
- **Approval never waits for the chain (operator):** the approval commits as today; in the same
  database transaction a receipt row is queued. A background sender in the web process signs and
  broadcasts, retries with backoff, and marks the receipt `confirmed` once the sequencer returns a
  successful transaction receipt, or `failed` after its retries run out or the transaction reverts.
  A chain outage never blocks or fails an approval. Receipts queued while the sender is not configured
  wait as `pending` and go out once it is.
- **One receipt per booking:** at most one receipt row per request (database-enforced). The signed
  transaction and its hash are stored before broadcast, so a restart rebroadcasts the same transaction
  rather than signing a second one. Sends are serialized in one process.
- **Key custody (operator: the Render web server):** env vars `FORTEL2_RECEIPT_PRIVATE_KEY`,
  `FORTEL2_CF_ACCESS_CLIENT_ID`, `FORTEL2_CF_ACCESS_CLIENT_SECRET` set in the Render dashboard only;
  `FORTEL2_WRITE_RPC_URL`, `FORTEL2_READ_RPC_URL`, `FORTEL2_CHAIN_ID`, `FORTEL2_EXPLORER_URL` have the
  defaults above. The key and secrets are never committed, logged, returned, audited or stored in the
  database. Keep only small test funds in the wallet. The Kings wallet is also used by the RateNinja futures-contracts
  prototype (nonce 5 on 2026-11-19), so the sender must tolerate a nonce moved by that prototype.
- **Who sees it:** the booking record (`present()`, so website, partner API and MCP alike) gains a
  `receipt` object for approved requests: status (`pending`, `submitted`, `confirmed`, `failed`), the
  transaction hash once known, the receipt hash, and an explorer link (`<FORTEL2_EXPLORER_URL>tx/<hash>`, default base
  `https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/`; format confirmed by the operator
  2026-11-19). Both the buyer and the owner see
  it. The buyer needs no wallet.
- **Corrected 2026-11-19 (planner error, R1-40 worker stop):** the first text also hashed the
  requesting and owner company ids. Neither is in the booking record (`present()`), so a buyer could
  not recompute the hash. Both are dropped; the random request id already ties the receipt to one
  booking. There is no MCP output schema in the repo (`lib/mcp.js` declares input schemas only), so
  MCP clients get `receipt` through `present()` with no schema edit.
- **Live 2026-11-19 (verified on chain):** the first production receipt
  `0xeaa87d8270181dd4a51f30662f6b5b7d99df18f0ac0fbee641cabe14c9f54e2a` is signed by
  `0xf8b8b3b58ebac9fc530d9244c22f391e90cc8ae2`: chain `0x354`, type 2, to = from,
  value 0, data `RNR1` + 32 bytes, status 1, 22,440 gas, total fee about 2.3e9 wei. Operator 2026-11-19: this is
  the Kings wallet (the address in the first request, `0xb849…D019`, was a different one). Its
  earlier transactions came from OceanRelay, the RateNinja futures prototype, and top-ups through
  ChainBank or the operator, so the key is shared and R1-41's nonce-conflict fix applies.
- **Not now:** receipts for declines, backfill of earlier approvals, a smart contract, buyer wallets or
  signatures, Sepolia L1 receipts, a manual retry button, a dedicated (non-Kings) wallet.

### D-046 — Admin CLI option 13: queue three sample managed agents per chosen customer (2026-11-19, operator request)

- **Why:** operator: "In our terminal application, can we add an option to automatically create 3
  random but valid managed agents into the queue for each of the 3 customers (so 9 in total) Alan,
  Bob, and TestBuyer. Of the 3 each: Make one a lowball price with AI booking request turned on, one
  'regular' i.e. a high price acceptance, and one with auto booking turned off."
- **Who (operator: pick from a list):** option 13 lists every active user in a Freight
  Forwarder/Customer company (display name, username, company) and pre-selects users whose display
  name or username matches Alan, Bob or TestBuyer (case-insensitive, spaces ignored). The operator
  confirms or edits the selection before anything is written. Production on 2026-11-19 has three
  customer companies: Blackwater Shippers, Blue Sky Shipping, Test Buyer Co.
- **What each chosen user gets:** three queued agents, created as that user (same rules, validation,
  audit and visibility as the `/agents` form, D-039), in one batch:
  1. **Lowball:** booking request on, price range 0 to half the lowest customer price that matches
     the agent's lane, container type and sailing date (rounded down to a whole dollar), alternatives
     off, so a correct runner books nothing.
  2. **Regular:** booking request on, price range 0 to 125% of the highest such customer price
     (rounded up), alternatives random, so a matching rate is within range.
  3. **No booking:** booking request off, no price range, alternatives random.
- **Random but valid:** each agent's rate type, lane, container type, sailing date (today or later,
  inside one of the lane's current rate windows) and slots (1 to 3) are chosen at random from that
  user's own search options. The two booking agents need a lane, container type and date with at
  least one matching customer price; the no-booking agent may use any valid lane. If a user has no
  such lane, or their company cannot request bookings, nothing is created for that user and the CLI
  says why. All three agents for a user are created together or not at all.
- **Prices:** computed only from the customer-priced rates the runner matches against (the same
  view as the admin matches route), never from the owner's base price (D-027, D-028).
- **Writes:** production writes, so the CLI previews the nine agents and needs a confirmation (or
  `--yes` on the one-shot command) before creating them. It prints what it created.
- **Corrected 2026-11-19 (planner error, found in the first production run):** "matches" was read as
  an exact match, so only Test Buyer was pre-selected; the production users are Alan Davis (`AlanD`,
  Blackwater Shippers), Bob Jones (`BobJ`, Blue Sky Shipping) and Test Buyer (`testbuyer`, Test Buyer
  Co). A user is pre-selected when their display name or username, lower-cased with spaces removed,
  **equals** `alan`, `bob` or `testbuyer` (as before), **or** the first word of their display name,
  lower-cased, equals one of them. The operator still confirms the selection (R1-43). Revised the same
  day after the R1-43 worker stopped: the first wording ("starts with") also picked "Bobby", which the
  R1-42 tests keep unselected on purpose.
- **Not now:** choosing counts or price levels, saved queries for sample agents, deleting samples.

### D-047 — Daily CloudBBS post as a Render Cron Job at 00:17 UTC (2026-11-20, operator request; amends D-043 "Not now")

- **Why:** operator: "The post info to CloudBBS option in the terminal option 9, I would like to also
  be able to do that up on Render, potentially automate it, i.e have it run once a day."
- **How (operator: Render Cron Job):** a second service in `render.yaml`, type `cron`, runs the
  existing one-shot command `node scripts/rateninja-admin.js post-cloudbbs --yes` on schedule
  `17 0 * * *` (00:17 UTC daily, operator's time). It reads production through the admin reference API
  over HTTPS, exactly as the operator's laptop does, and replaces the `rn` announcement. The web
  service is unchanged. The Render dashboard's "Trigger run" button gives an on-demand post.
- **Secrets:** the cron service needs `RATE_NINJA_ADMIN_API_KEY` and `CLOUDBBS_TOKEN` (the
  announcement-capable token), declared `sync: false` and set in the dashboard only. It never gets the
  ForteL2, Resend, Anthropic or buyer keys.
- **Booking code:** every post rotates the code (D-034, D-043), so it now rotates daily at 00:17 UTC
  and also on any manual option 9 or "Trigger run". Agent bookings carrying the previous code fail
  with 403 `invalid_booking_code` within 60 s of a post (the server cache, D-043). Option 12 reads the
  code once per run, so a run spanning 00:17 UTC can see later bookings refused; schedule runs away
  from it.
- **Failure:** a failed post (reference read, size limit, CloudBBS error) leaves the previous
  announcement and code in place, and the run must exit non-zero so Render marks it failed.
- **Not now:** alerts on a failed run, more than one post a day, posting from inside the web service.

### D-048 — System admins start the managed agent run (option 12) from /agents (2026-11-20, operator request)

- **Why:** operator: "when logged into RateNinja as the admin they can manually kick off the '12'
  process via a button and a confirm."
- **Who (operator):** system admins only. Company admins and customers never see the button and get
  403 from the routes.
- **Where it runs (operator: inside the web server):** the button starts the same runner as option 12
  (`runManagedAgents` in `lib/managed-agent-runner.js`, confirmed, same behaviour, same CloudBBS run
  note) in the background of the Render web process, and the request returns at once. The runner
  still reaches the app through the admin API with `RATE_NINJA_ADMIN_API_KEY`, as it does from the
  laptop.
- **Secrets on the web service:** `ANTHROPIC_API_KEY` and `CLOUDBBS_AGENT_TOKEN` (dashboard,
  `sync: false`), next to the existing admin key. If either is missing, the button is disabled with
  the reason, and the route refuses with 503. They are never shown, logged or stored.
- **Confirm:** a dialog shows how many agents are queued (each costs Claude calls) and the next daily
  CloudBBS post time (00:17 UTC, D-047). Starting is refused between 00:15 and 00:19 UTC.
- **One run at a time:** a second start while a server run is in progress is refused (409). The
  laptop option 12 stays available; operators should not run both at once.
- **Run record (migration 016):** each server run is stored: who started it, when, status
  (`running`, `succeeded`, `failed`, `interrupted`), the agent ids it actually started, the runner's
  exit code and its printed summary (already redacted by the runner), finish time. /agents shows the
  latest run's status and summary to system admins.
- **Interrupted runs:** if the process stops mid-run (deploy, restart), on the next start the run is
  marked `interrupted`, and only the agents that run itself started and that are still `running` are
  finished as `failed` with "Run interrupted before this agent finished." Agents started by any other
  runner are never touched.
- **Not now:** a schedule for agent runs, cancelling a run from the page, running a single agent,
  showing past runs beyond the latest.

### D-049 — System admins post the CloudBBS reference data (option 9) from /agents (2026-11-20, operator request)

- **Why:** operator: "can we add a button that runs 'number 9' from our terminal, i.e. a manual run of
  the cron job."
- **Who and where (operator: /agents run panel):** system admins only. The button is "Post to
  CloudBBS now", next to "Run queued agents" (D-048). Others never see it and get 403 from the route.
- **How it runs (operator: inside the web server):** the same post as option 9 and the R1-44 cron
  (D-047): read reference data through the admin API, build the announcement with a new booking code,
  PUT it to the CloudBBS `rn` announcement. The CLI and the button share one implementation, so they
  cannot drift. The CLI's output and exit codes stay as they are.
- **Secret:** `CLOUDBBS_TOKEN` (the token with the announcement capability, the same one the cron
  service uses) is set on the web service (dashboard, `sync: false`). Without it the button is
  disabled with the reason, and the route refuses with 503. It is never shown, logged or stored.
- **It rotates the booking code.** Because of that:
  - A post is refused while a server managed-agent run is `running` (409). A run start is refused
    while a post is in progress (409).
  - Both are refused between 00:15 and 00:19 UTC, around the daily cron post.
  - After a successful post, the web server forgets its cached booking code (`lib/booking-code.js`
    caches it for 60 s), so bookings check the new code at once.
  - The confirm says that the current booking code stops working. The laptop option 12 cannot be
    detected, so operators must not post while a laptop run is going.
- **One post at a time:** a second post while one is in progress is refused (409).
- **Result:** the page shows the outcome (version and time, or the error). Each successful post writes
  an audit event with the actor and the CloudBBS version, never the code or the token.
- **Not now:** a post history on the page, editing the announcement, posting to another project.

### D-050 — Receipt details with an on-chain check on approved booking requests (2026-11-20, operator request)

- **Why:** operator: "in a booking request, can we display the text of the hash if requested and if
  there is anything useful in there."
- **What the chain holds (planner, explorer, tx 0x8f3a…2f3b):** a 0 ETH self-send from the receipt
  wallet. Its whole input is 36 bytes: `0x524e5231` ("RNR1") plus the keccak-256 of the canonical
  receipt JSON (D-045). The hash is one-way and cannot be turned back into text. That is deliberate:
  nothing private is written to the chain.
- **What the page shows instead (operator: with chain check):** on an approved request that has a
  receipt, a "Receipt details" view for anyone who can already see the request (customer side and
  owner side). It shows:
  - the receipt fields in plain words (request, rate, carrier, route, size, slots, price, status,
    decided at, version);
  - the exact canonical text that was hashed;
  - the receipt hash, the transaction hash and the explorer link;
  - the result of a chain check.
- **Chain check:** on request, the server reads the transaction and its receipt from ForteL2 through
  the existing read RPC (`FORTEL2_READ_RPC_URL`). "Verified on ForteL2" only when all of these hold:
  - the canonical text rebuilt from the stored request hashes to the stored receipt hash;
  - the transaction exists, succeeded and is on the configured chain;
  - it was sent by the stored sender address;
  - its input is exactly the tag plus that hash.
  Otherwise it shows "Mismatch" with the part that differs, "Not on chain yet", or "Could not check
  ForteL2" (RPC down or not configured). Read-only: nothing is signed or sent.
- **Not now:** showing receipts for declined requests, hashing in the browser, exposing details on
  the partner or buyer API, storing check results.

### D-051 — Discovery publishes every scope; authorize grants the allowed subset (2026-11-20, operator request; supersedes D-028's discovery bullet)

ChatGPT's connector lets a user choose only scopes that discovery advertises, so a customer could not
get `bookings:write` there (measured 2026-11-20 as Test Buyer: granted `profile:read rates:read
sailings:read`). D-028 kept discovery minimal because `parseScopes` rejected a whole request containing
any scope the client was not allowed.

- **Discovery:** `scopes_supported` in the authorization-server and both protected-resource documents
  is all of `SCOPES`, in `lib/constants.js` order.
- **Narrow, don't reject:** at authorize, granted = requested ∩ client-allowed ∩ `SCOPES`, duplicates
  removed, request order kept. Unknown or disallowed names are dropped (RFC 6749 §3.3). An empty result,
  or a blank or missing `scope`, is `invalid_scope`. Client registration still rejects unknown names.
- **D-028's "No silent grants" still holds:** a client gets a scope only when a system admin allowed it
  on the client and the user approved it. Existing clients' allowed scopes are unchanged.
- **Consent shows what is granted:** the page lists the granted scopes, posts them in the hidden field,
  and shows the `bookings:write` note only when that scope is granted, so the POST cannot grant more
  than the page showed even if the client is widened in between.
- **Not now:** a `scope=` hint on `WWW-Authenticate`, insufficient-scope step-up, dynamic client
  registration, editing an existing client's scopes in the admin screen (use
  `PATCH /api/admin/oauth-clients/{id}`).

### D-052 — Edit and delete OAuth clients; effective scopes are live (2026-11-20, operator request; amended the same day after the R1-53 first run)

- **Edit:** Admin → OAuth clients edits display name, redirect URIs, allowed scopes and status. Client
  type is fixed.
- **Effective scopes = stored ∩ the client's current allowed scopes**, computed at code exchange, at
  refresh (the new refresh row stores the intersected set) and in `verifyAccessToken` on every call. An
  empty result at exchange or refresh is `invalid_grant`. Narrowing takes effect on the next call
  and revokes nothing; widening never adds a scope a connection did not store. The update audit
  lists removed scopes. *Amended:* the first version revoked grants holding a removed scope; the R1-53
  worker showed tokens can carry scopes their grant does not record (code exchange binds the code's
  scopes to the latest grant; refresh re-issues stored scopes; verify trusted payload scopes).
- **Accepted residual:** re-allowing a scope makes it usable again on a credential that still stores
  it: an access token of at most 10 minutes, or a refresh token not used while narrowed. The user
  consented to it and an admin re-allowed it.
- **Delete:** `DELETE /api/admin/oauth-clients/{id}` (system admin, CSRF) removes codes, grants,
  refresh tokens and the client in one transaction; audit rows stay; `oauth_client_deleted` records
  the id, name and grants removed. Tokens from a deleted client get 401 on the next call.
- **Capacity Exchange cannot be deleted** (409, disable it instead): boot re-seeds it
  (`lib/foundation.js:110`), so a delete would silently come back.
- **The confirm names the client and its active connection count.**

### D-053 — Max slots allowed on rates (2026-11-21, operator request)

- **Column:** `rates.max_slots_allowed INTEGER`, nullable, `CHECK (max_slots_allowed IS NULL OR
  max_slots_allowed >= 1)`, no column DEFAULT, no upper bound in the schema (later rules may allow
  more than 5). Migration 017.
- **Existing rates:** every row with no value gets an independent uniform random 1–5, including
  soft-deleted rows and every owner. A row that already has a value keeps it.
- **New rates:** trigger `trg_rates_max_slots_default` (AFTER INSERT, WHEN the value is NULL) sets a
  random 1–5 on that row only; a supplied value is kept. Updates are not covered. Pull-forward copies
  get a new random value, not the source's.
- **Why a trigger:** SQLite accepts a non-constant column DEFAULT on an empty table and rejects it on
  a populated one, so a DEFAULT would pass tests and abort startup in production (measured
  2026-11-21).
- **No surface change yet:** imports, the UI, the partner API, MCP, exports and booking rules gain
  the field in later tasks.

### D-054 — Zero max slots and the customer grid (2026-11-21, operator request; amends D-053)

- **Schema:** `max_slots_allowed INTEGER CHECK (max_slots_allowed IS NULL OR max_slots_allowed >= 0)`.
  Migration 018 swaps the column (add, copy, drop, rename) because SQLite cannot alter a CHECK in
  place; every existing value and every other column, `row_version` included, is kept.
- **New rates:** `trg_rates_max_slots_default` now sets `abs(random()) % 6` (0–5) when the value is
  NULL on insert. A supplied value, 0 included, is kept. Pull-forward copies get a fresh 0–5.
- **Customer view:** `GET /api/rates` rows for a signed-in customer carry `maxSlotsAllowed` (integer
  or null; predictive rows null). The value lives on the store record outside `fields`, so the
  partner API, MCP, the owner view, exports and CloudBBS posts do not gain it.
- **Grid:** a "Max slots" column sits immediately before Request booking; at 0 the button is
  disabled with "No slots available" and opens nothing. Null and 1–5 behave as before.
- **Not yet:** the server still accepts a booking on a 0 rate and does not cap slots; the booking
  logic task owns that.
