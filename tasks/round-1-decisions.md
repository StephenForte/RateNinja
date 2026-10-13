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
- **Open product question (blocks R1-11b only):** if deterministic extraction fails on the
  representative PDFs, may Claude extract the rows from the whole PDF? Every extracted row would
  then be shown for review before validation and commit, the whole document would be sent to
  Claude, and no missing value would ever be filled in. R1-10 measures both approaches on real
  files before this is asked.
- R1-10 needs representative files of each format from the operator (real rate sheets and
  sailing schedules, redacted if needed).
