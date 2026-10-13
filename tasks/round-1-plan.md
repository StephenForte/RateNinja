# Round 1 Enhancements — Implementation Plan

Spec: `tasks/prd-round-1-enhancements.md` (merged in #8, status "Draft for product review").
Decisions: `tasks/round-1-decisions.md` — cite by id (D-NNN); never re-decide in a PR.
Owner of this file and the decisions log: the planner. **Workers never edit either file.**

## Baseline (verified 2026-10-12)

- main at `0c3e89f`. `npm run check` clean; `npm test` 50 pass / 0 fail / 0 skipped
  (run from a `git archive` copy, Node 26 locally; CI uses Node 22).
- Schema lives inline in `lib/db.js` (`CREATE TABLE IF NOT EXISTS` + `addColumn`). No migration ids exist yet.
- Routes are one `if` chain in `server.js` (1,062 lines). Frontend is one `script.js` (1,175 lines) + `index.html` with hidden sections.
- PRD claims verified against code:
  - `lib/foundation.js` `ensureUser` rewrites `admin_screen`, company, and display name for SteveF/Alan/Bob on **every** startup; `ensureCompany` rewrites company type every startup. → R1-02.
  - `server.js` user list/password/2FA/update handlers check only `requireAdmin` (no company scope). → R1-02.
- **Found during planning (not in PRD):** `serveStatic` serves any non-dot file under the repo root.
  Production returns 200 for `https://rate-ninja.onrender.com/lib/db.js` and `/package.json`
  (checked 2026-10-12 with curl). The prod DB is at `/var/data` and returns 404, but a local/dev DB
  under `data/` is downloadable (reproduced locally: `/data/t.db` → 200). → R1-00, dispatch first.
- `lib/domain.js` `calculateRate` treats a stored margin percent `> 1` as whole percent and `<= 1` as a
  fraction, so a stored `1` means 100%. → D-013, R1-07.

## Commit-and-merge contract (every prompt references this section)

1. Branch `r1/NN-slug` from **current** `origin/main`. One PR per task, title `R1-NN: <title>`.
2. Touch only files your task **owns** or may **append to** (task table). Anything else → stop and report in RISKS.
3. Use the migration id assigned to your task. Never pick "the next number".
4. New tests go in `test/r1-NN-*.test.js`; shared helpers you add go in `test/helpers/r1-NN.js`.
5. Gate before handoff, on Node 22: `npm ci && npm run check && npm test` all green, plus the task-specific gate in the brief.
6. Rebase on `origin/main` immediately before handoff; CI must be green on the PR.
7. Do not merge. Do not edit `tasks/round-1-*.md`. Handoff uses the `dispatch-worker` return format.
8. Operator squash-merges after planner review. Integration order below.

## Migration ids (pre-assigned — D-002)

| Id | File | Task |
| --- | --- | --- |
| 001 | `lib/migrations/001-roles.js` | R1-02 |
| 002 | `lib/migrations/002-password-lifecycle.js` | R1-04 |
| 003 | `lib/migrations/003-saved-preferences.js` | R1-05 |
| 004 | `lib/migrations/004-login-uniqueness.js` | R1-06 |
| 005 | `lib/migrations/005-customer-authorization.js` | R1-07 |
| 006 | `lib/migrations/006-data-operations.js` | R1-08 |
| 007 | reserved | R1-09 (use only if needed) |
| 008 | `lib/migrations/008-import-jobs.js` | R1-11a |
| 009 | reserved | R1-12 (use only if needed) |
| 010+ | unassigned | ask the planner |

Next free: **010**.

## Task tree

Tier key: **S** = strongest model (security, data integrity, money). **M** = standard model.
Model names are the planner's proposal; operator overrides recorded in the Run column.

| Task | Title | PRD | Depends on | Tier / model | Status |
| --- | --- | --- | --- | --- | --- |
| R1-00 | Static serving lockdown (hotfix) | — | — | M / Sonnet 5.5 | approved 2026-10-12, PR #12 |
| R1-01 | Scaffolding: migration runner, route modules, test harness, limits | §Data | R1-00 | S / Opus 5.5 | merged 2026-10-13, PR #14 |
| R1-02 | Roles and company isolation | Roles, Delivery 1 | R1-01 | S / Opus 5.5 | briefed 2026-10-13 (W1) |
| R1-03 | App shell: addressable pages and menu | FR1 | R1-01 | M / Sonnet 5.5 | briefed 2026-10-13 (W1) |
| R1-04 | Profile and password lifecycle | FR4 | R1-02, R1-03 | S / Opus 5.5 | not dispatched |
| R1-05 | Saved queries and saved views | FR2, FR3 | R1-03 | M / Sonnet 5.5 | not dispatched |
| R1-06 | Company and user onboarding | FR5, FR6 | R1-04 | S / Opus 5.5 | not dispatched |
| R1-07 | Customer authorization and live preview | FR7 | R1-02, R1-03 | S / Opus 5.5 | not dispatched |
| R1-08 | Data workspace core: soft delete, versions, edit, delete/restore, history | FR9 | R1-02, R1-03 | S / Opus 5.5 | not dispatched |
| R1-09 | Pull-forward wizard and operation undo | FR9 | R1-08 | S / Opus 5.5 | not dispatched |
| R1-10 | Imports discovery spike, CSV + Excel (no product code) | FR8 | representative files from operator | M / Sonnet 5.5 | awaiting files |
| R1-11a | Imports implementation: CSV + Excel | FR8 | R1-08, R1-10 | S / Opus 5.5 | not dispatched |
| R1-12 | MCP / partner API parity incl. predictive | FR11 | R1-01 | S / Opus 5.5 | briefed 2026-10-13 (W1) |
| R1-13 | API and MCP instructions + docs alignment | FR10 | R1-07, R1-12 | M / Sonnet 5.5 | not dispatched |
| R1-14 | Integrated release acceptance | §Validation | all P1 | M / Sonnet 5.5 + operator | not dispatched |
| R1-15 | P2: bulk price adjustment | FR12 | R1-09 | S | not planned in detail |
| R1-16 | P2: duplicate handling | FR13 | R1-11a | S | not planned in detail |

### Run order (waves)

- **W0** (serial, one worker): R1-00 → R1-01.
- **W1** (parallel, after R1-01 merges): R1-02, R1-03, R1-12. Merge order: any order, except R1-03 after R1-02 (it consumes D-009). R1-12 must merge before R1-07/R1-08 start (`lib/visibility.js`).
- **W2** (parallel): R1-05 (needs R1-03 only — can start as soon as it lands); R1-04, R1-07, R1-08 (need R1-02 + R1-03).
- **W3**: R1-06 (after R1-04), R1-09 (after R1-08), R1-11a (after R1-08 + R1-10). R1-10 can run any time once representative files are supplied.
- **W4**: R1-13, then R1-14.

Peak concurrency is 4 (W2). If the operator runs fewer agents, drop R1-05 to W3 first.

## Ownership

"Owns" = may create/rewrite. "Appends" = may add to, not restructure. Everything else is read-only for that task.

| Task | Owns | Appends / narrow edits |
| --- | --- | --- |
| R1-00 | `public/` (git mv of `index.html`, `login.html`, `login.js`, `script.js`, `styles.css`, `favicon.svg`, `api-docs.html`, `api-testbed.*`); `test/r1-00-*.test.js` | `server.js` `serveStatic` + page routes only; `README.md` path mentions |
| R1-01 | `lib/migrations/index.js`, `lib/migrations/README.md`, `lib/http.js`, `lib/routes/index.js` + **empty stub for every route module below**, `lib/limits.js`, `test/helpers/app.js`, `test/r1-01-*.test.js` | `lib/db.js` (call runner after baseline DDL; baseline frozen after this), `server.js` (dispatch to route modules; move shared helpers to `lib/http.js`; exact-path routes for `/docs/partner-integration.md` and `/API-README.md`, from the R1-00 review) |
| R1-02 | `lib/permissions.js`, `lib/migrations/001-roles.js`, `lib/routes/admin-context.js`, `test/r1-02-*` | `lib/foundation.js`, `server.js` (session payload, existing admin handlers), `lib/store.js` (`listUsersForAdmin`, user mutators), `lib/session.js` (session-context setter only), `lib/accounts.js` (scope and last-admin guards only), `test/r1-01-migrations.test.js` (delete the no-`NNN` assertion only) |
| R1-03 | `public/index.html`, `public/styles.css`, `public/js/**` (split of `public/script.js`, which is deleted), **stub for every admin/profile section below**, `test/r1-03-*` | `server.js` page-path fallback only |
| R1-04 | `lib/migrations/002-*`, `lib/routes/account.js`, `public/js/profile/account.js`, `public/js/password-required.js`, `test/r1-04-*` | `lib/accounts.js`, `lib/password-reset.js`, `lib/session.js`, `lib/oauth.js` (authorize gate only), `server.js` (restricted-session gate, admin password handler) |
| R1-05 | `lib/migrations/003-*`, `lib/preferences.js`, `lib/view-fields.js`, `lib/routes/preferences.js`, `public/js/rates/queries.js`, `public/js/rates/views.js`, `public/js/rates/grouping.js`, `public/js/profile/preferences.js`, `test/r1-05-*` | `public/js/rates/*.js` existing files (wire-up only) |
| R1-06 | `lib/migrations/004-*`, `lib/onboarding.js`, `lib/routes/onboarding.js`, `lib/routes/users.js`, `public/js/admin/users.js`, `public/js/admin/companies.js`, `test/r1-06-*` | `lib/store.js` (user queries), `lib/permissions.js` (add predicates only) |
| R1-07 | `lib/migrations/005-*`, `lib/pricing.js`, `lib/customer-access.js`, `lib/routes/customer-access.js`, `public/js/admin/customers.js`, `test/r1-07-*` | `lib/visibility.js` (call `lib/pricing.js`; filter revoked links), `lib/domain.js` (`calculateRate` delegates), `lib/store.js` (margin functions only) |
| R1-08 | `lib/migrations/006-*`, `lib/data-ops.js`, `lib/record-validation.js`, `lib/routes/data-ops.js`, `public/js/admin/data.js`, `test/r1-08-*` | `lib/store.js` + `lib/visibility.js` (deleted-row filter on every rate/sailing read), `server.js` (remove legacy pull-forward routes only when R1-09 replaces them — not in R1-08) |
| R1-09 | `lib/pull-forward.js`, `public/js/admin/pull-forward.js`, `test/r1-09-*` | `lib/data-ops.js`, `lib/routes/data-ops.js`, `server.js` (delete legacy pull-forward handlers), `lib/store.js` (pull-forward functions) |
| R1-10 | `docs/imports-discovery.md`, `test/fixtures/imports/**` | — |
| R1-11a | `lib/migrations/008-*`, `lib/imports/**`, `lib/routes/imports.js`, `public/js/admin/imports.js`, `public/templates/*`, `test/r1-11-*` | `package.json`/lockfile (parser + Anthropic deps), `lib/config.js` (import/Claude settings), `lib/data-ops.js` (undo hook), `lib/record-validation.js` |
| R1-12 | `lib/predictive.js`, `lib/mcp-schema.js`, `lib/partner-http.js` (bearer/partner-access/page-arg helpers moved out of `server.js`), `lib/routes/partner.js`, `test/r1-12-*` | `lib/mcp.js`, `lib/visibility.js` (predictive helpers move out), `server.js` (predictive handlers delegate; MCP audit), `lib/audit.js` |
| R1-13 | `public/js/admin/integrations.js` | `public/api-docs.html`, `API-README.md`, `docs/partner-integration.md` |
| R1-14 | `test/r1-14-*`, `docs/release-acceptance-r1.md` | — |

### Pre-registered modules (so nobody edits a registry)

- **Route modules** created empty and registered by R1-01 in `lib/routes/index.js`:
  `admin-context`, `account`, `preferences`, `onboarding`, `users`, `customer-access`, `data-ops`, `imports`, `partner`.
- **Frontend sections** created as stubs and registered by R1-03 (with permission predicates per D-009):
  Profile: `account`, `security` (2FA, moved from existing screen), `preferences`.
  Admin: `users`, `companies` (system admin only), `customers` (owner admin), `data`, `pull-forward`, `imports`, `integrations`, `oauth-clients` (system admin; existing UI moved).

## Integration order and predicted conflicts

Merge order within a wave: the order listed in the wave. Expected conflicts even with the ownership split:

| Hotspot | Tasks | Expected | Resolution |
| --- | --- | --- | --- |
| `server.js` | R1-02, R1-03, R1-04, R1-09, R1-12 | Likely textual, small | Later PR rebases; keep both sides |
| `lib/visibility.js` | R1-07, R1-08, R1-12 | **High** | Merge R1-12 first (W1); R1-07 then R1-08 rebase |
| `lib/store.js` | R1-02, R1-06, R1-07, R1-08, R1-09 | Medium; different functions | Rebase; re-run full suite |
| `lib/permissions.js` | R1-02 owns, R1-06 appends | Low | — |
| `package-lock.json` | R1-11 only | none if rule holds | — |
| Session payload shape | R1-02 produces, R1-03 consumes | Contract, not text | D-009 fixes the shape in advance |

Every migration task must also prove: fresh DB, prod-shaped copy, and re-run (idempotent) all pass — see D-002.

## Notes for later briefs (from reviews)

- **R1-02:** delete the R1-01 assertion in `test/r1-01-migrations.test.js` that `lib/migrations/` has no `NNN-*.js` file (it must, once `001-roles.js` lands); keep the count and second-start checks. Declare it under EXISTING CHECKS MODIFIED.
- **Every migration task:** `up(db)` already runs inside `BEGIN IMMEDIATE`; do not open a transaction (or call `db.js` `transaction()`) inside it.
- **R1-06:** migration 001 installs `users` triggers that keep `admin_screen` and `company_role` in sync (an insert with `admin_screen = 1` becomes `company_admin`). Set `company_role` directly when creating users; never rely on `admin_screen`.
- **R1-11a:** the route dispatcher JSON-parses every unsafe-method session body (1 MB cap) before CSRF. File upload needs a route-level opt-out (for example `body: 'raw'` with header-only CSRF) and its own size limit; that change to `server.js` is in R1-11a's scope.

## Open items

- **Operator question (D-020):** do system admins need to browse rates as another company in P1? Default: no.

- ~~Import formats~~ resolved 2026-10-12 (D-017), narrowed by D-018: Round 1 imports CSV + Excel; PDF deferred.
- **Deferred past Round 1 (D-018):** Claude extraction of unstructured files, and with it PDF import. Guardrails recorded; no Round 1 task. Target: P3 or P4 (operator, 2026-10-12).
- **Operator input needed:** representative rate/sailing files in each format for R1-10.
- PRD defaults (temp-password replacement, 2 group levels, 3 sorts, 30-day window) adopted as D-011 pending product review.
- Real MCP client check (R1-12, R1-14) needs the operator: production has `PARTNER_OAUTH_ENABLED=false`; run locally.

## Review log

_(planner appends: task, PR, verdict, what was independently verified and how)_

- 2026-10-13 · **R1-02, PR #17: changes requested (one item, a planning gap).** Base `d264f95` = main; scope clean. Fresh clone gate 84/0/0, matching the handoff. Live probes (startApp + direct DB edits): a demoted admin's existing session gets 403 on its next request (permissions read live); a company admin's PATCH on another company's user returns 404 and leaves it unchanged; the user list is limited to their own company. **Blocker:** a system admin with no context gets 409 on users and companies, and nothing lists companies to select, so production admin screens are locked once 001 makes SteveF a system admin. The fix is D-021 (company-list endpoint in R1-02, selector in R1-03, back-to-back merge).
- 2026-10-13 · **R1-01, PR #14: approved at `5be291c`.** The fix changed only `.gitignore` (`data/`) and added one test. Fresh clone: 71/0/0. With the fix reverted, the new ignore test fails, so it can catch the problem. Approval posted on #14.
- 2026-10-13 · **R1-01, PR #14: changes requested (one item).** Base `323b4aa` = main; scope clean. Gate re-run in a fresh clone: 70/0/0, matching the handoff. Probes with fixture migrations via `MIGRATIONS_DIR` on the default file DB: no-pending start makes no backup; pending `001` is applied once and backed up once, and the second start is a no-op; a throwing `002` exits 1 with its id in the message, is not recorded, and its partial table is rolled back. Doc routes are an exact map. **Blocker:** `.gitignore` has `data/*.db` but backups go to `data/backups/`, and the repo is **public**, so a full DB copy (hashes, TOTP secrets) shows as untracked and one `git add -A` would publish it. Fix (replace with `data/` + a `git check-ignore` test) proven in the clone; posted on #14.
- 2026-10-12 · **R1-00, PR #12: approved, merge as-is.** Base `af1bee5` = main; scope clean. Gate re-run in a fresh clone (Node 26): 55/0/0, matching the handoff. Probes (`curl --path-as-is` against my own server): source, `public/` prefix, a planted `data/x.db`, encoded and double-encoded traversal, `%00`, `/./`, trailing slash, a planted symlink, and an absolute-form request line all return non-200 with no body leak. Pages still 200. The probes can fail: old main returned 200 for `/lib/db.js` and for a `data/` DB. **Regression:** `/docs/partner-integration.md` (advertised in OAuth metadata, `lib/oauth.js:755,765`) and `/API-README.md` (linked from `api-docs.html`) now 404. The fix is folded into R1-01 (exact-path routes). `/api/health` 503 without secrets is also true on main, so it's environmental. Review posted on #12.
- 2026-10-12 · docs PR #10 merged (`93b5d61`): D-017, import split. D-018 then deferred PDF/unstructured past Round 1.
- 2026-10-12 · docs PR #9 merged (`98bd634`). Verified: both files on main byte-identical to the reviewed drafts (`git show | diff`).
