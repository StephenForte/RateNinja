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
| R1-02 | Roles and company isolation | Roles, Delivery 1 | R1-01 | S / Opus 5.5 | merged 2026-10-13, PR #17 |
| R1-03 | App shell: addressable pages and menu | FR1 | R1-01 | M / Sonnet 5.5 | merged 2026-10-13, PR #18 |
| R1-04 | Profile and password lifecycle | FR4 | R1-02, R1-03 | S / Opus 5.5 | merged 2026-10-13, PR #24 |
| R1-05 | Saved queries and saved views | FR2, FR3 | R1-03 | M / Sonnet 5.5 | approved 2026-10-13, PR #29 (`9552cc1`) |
| R1-06 | Company and user onboarding | FR5, FR6 | R1-04 | S / Opus 5.5 | not dispatched |
| R1-07 | Customer authorization and live preview | FR7 | R1-02, R1-03 | S / Opus 5.5 | merged 2026-10-13, PR #22 |
| R1-08 | Data workspace core: soft delete, versions, edit, delete/restore, history | FR9 | R1-02, R1-03 | S / Opus 5.5 | merged 2026-10-13, PR #23 |
| R1-09 | Pull-forward wizard and operation undo | FR9 | R1-08 | S / Opus 5.5 | not dispatched |
| R1-10 | Imports discovery spike, CSV + Excel (no product code) | FR8 | representative files from operator | M / Sonnet 5.5 | awaiting files |
| R1-11a | Imports implementation: CSV + Excel | FR8 | R1-08, R1-10 | S / Opus 5.5 | not dispatched |
| R1-12 | MCP / partner API parity incl. predictive | FR11 | R1-01 | S / Opus 5.5 | merged 2026-10-13, PR #19 |
| R1-13 | API and MCP instructions + docs alignment | FR10 | R1-07, R1-12 | M / Sonnet 5.5 | not dispatched |
| R1-14 | Integrated release acceptance | §Validation | all P1 | M / Sonnet 5.5 + operator | not dispatched |
| R1-15 | P2: bulk price adjustment | FR12 | R1-09 | S | not planned in detail |
| R1-16 | P2: duplicate handling | FR13 | R1-11a | S | not planned in detail |

### Run order (waves)

- **W0** (serial, one worker): R1-00 → R1-01.
- **W1** (parallel, after R1-01 merges): R1-02, R1-03, R1-12. Merge order: any order, except R1-03 after R1-02 (it consumes D-009). R1-12 must merge before R1-07/R1-08 start (`lib/visibility.js`).
- **W2** (parallel): R1-05 (needs R1-03 only — can start as soon as it lands); R1-04, R1-07, R1-08 (need R1-02 + R1-03). Merge order: any, except R1-07 before R1-08 (both edit `lib/store.js`; R1-08's preview-exclusion test needs R1-07's preview). Expect `test/r1-01-routes.test.js` and `public/styles.css` conflicts on every merge after the first: keep both sides.
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
| R1-05 | `lib/migrations/003-*`, `lib/preferences.js`, `lib/view-fields.js`, `lib/routes/preferences.js`, `public/js/rates/queries.js`, `public/js/rates/views.js`, `public/js/rates/grouping.js`, `public/js/profile/preferences.js`, `test/r1-05-*` | `public/js/rates/*.js` existing files (wire-up only), `public/index.html` (rates table header region only) |
| R1-06 | `lib/migrations/004-*`, `lib/onboarding.js`, `lib/routes/onboarding.js`, `lib/routes/users.js`, `public/js/admin/users.js`, `public/js/admin/companies.js`, `test/r1-06-*` | `lib/store.js` (user queries), `lib/permissions.js` (add predicates only) |
| R1-07 | `lib/migrations/005-*`, `lib/pricing.js`, `lib/customer-access.js`, `lib/routes/customer-access.js`, `public/js/admin/customers.js`, `test/r1-07-*` | `lib/visibility.js` (call `lib/pricing.js`; filter revoked links), `lib/domain.js` (`calculateRate` delegates), `lib/store.js` (margin functions only), `server.js` (move `handleAdminCompanies`/`handleAdminCompanyUpdate` into `lib/routes/customer-access.js`) |
| R1-08 | `lib/migrations/006-*`, `lib/data-ops.js`, `lib/record-validation.js`, `lib/routes/data-ops.js`, `public/js/admin/data.js`, `test/r1-08-*` | `lib/store.js` + `lib/visibility.js` (deleted-row filter on every rate/sailing read), `server.js` (remove legacy pull-forward routes only when R1-09 replaces them — not in R1-08), `test/r1-12-parity.test.js` (append deleted-row cases only) |
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

- **Every migration task:** `test/r1-02-migration.test.js` asserts the exact list of applied ids. Each new migration extends it, so concurrent merges conflict there. Resolve with the sorted union of the merged ids.
- **All W2 tasks:** `public/styles.css` is append-only for everyone; add a block headed by your task id.

- **R1-02:** delete the R1-01 assertion in `test/r1-01-migrations.test.js` that `lib/migrations/` has no `NNN-*.js` file (it must, once `001-roles.js` lands); keep the count and second-start checks. Declare it under EXISTING CHECKS MODIFIED.
- **Every migration task:** `up(db)` already runs inside `BEGIN IMMEDIATE`; do not open a transaction (or call `db.js` `transaction()`) inside it.
- **Every task that fills a pre-registered route module:** `test/r1-01-routes.test.js` asserts per-module route counts, so it conflicts whenever two tasks fill modules in parallel. Resolve by keeping both counts; assert your own routes in your own test file.
- **R1-09:** legacy pull-forward `deleteExisting` still **hard-deletes** every target-window row, including soft-deleted ones, which permanently destroys restorable deletions. R1-09 must replace it with soft delete through data-ops operations, and pull-forward must never touch deleted rows. (Found in the R1-08 review; disclosed by the worker.)
- **Every migration test that boots with a partial `MIGRATIONS_DIR`:** since R1-08, `lib/store.js` needs migration 006's columns at module load. Partial fixtures must include `006-data-operations.js`.
- **R1-06:** migration 001 installs `users` triggers that keep `admin_screen` and `company_role` in sync (an insert with `admin_screen = 1` becomes `company_admin`). Set `company_role` directly when creating users; never rely on `admin_screen`.
- **R1-11a:** the route dispatcher JSON-parses every unsafe-method session body (1 MB cap) before CSRF. File upload needs a route-level opt-out (for example `body: 'raw'` with header-only CSRF) and its own size limit; that change to `server.js` is in R1-11a's scope.

## Open items

- ~~D-020~~ resolved 2026-10-13: no cross-company browsing for system admins.
- **Production fact (2026-10-13):** `GET https://rate-ninja.onrender.com/api/health` reports `partnerOauthEnabled: true`, so `PARTNER_OAUTH_ENABLED=true` is set in the Render dashboard, overriding `render.yaml` (`"false"`). Partner OAuth and `/mcp` are live in production. **Confirmed intended by the operator 2026-10-13:** the partner API and MCP are live in production. Treat partner/MCP regressions as production incidents.

- ~~Import formats~~ resolved 2026-10-12 (D-017), narrowed by D-018: Round 1 imports CSV + Excel; PDF deferred.
- **Deferred past Round 1 (D-018):** Claude extraction of unstructured files, and with it PDF import. Guardrails recorded; no Round 1 task. Target: P3 or P4 (operator, 2026-10-12).
- **Operator input needed:** representative rate/sailing files in each format for R1-10.
- PRD defaults (temp-password replacement, 2 group levels, 3 sorts, 30-day window) adopted as D-011 pending product review.
- Real MCP client check (R1-12, R1-14) needs the operator: production has `PARTNER_OAUTH_ENABLED=false`; run locally.

## Review log

_(planner appends: task, PR, verdict, what was independently verified and how)_

- 2026-10-13 · **R1-05, PR #29: approved at `9552cc1`.** Base `01f5244` = main; scope clean; fresh clone 152/0/0; CI and Bugbot green. Probe: a second user (system admin, same company) gets 404 on read, patch, delete and set-default of another user's query or view, and sees an empty list; date and page criteria keys, a third group field, and an unknown column each return 400. Browser on a scratch DB (45 rates), after the Bugbot fixes: with no view the standard table shows 20 rows, Page 1 of 3; the default grouped view is restored on reload, and group headers count the full set (CMA 15, MSC 15).
- 2026-10-13 · **R1-08, PR #23: approved at `adc76e4` after rebase onto `04f5516`.** Fresh clone, two runs: 134/0 each; CI green. The merged `store.js` keeps both the deleted_at filters (15) and R1-07's active-link filter. The test edits match the requested resolution.
- 2026-10-13 · **R1-08, PR #23: behaviour approved at `557d624`, rebase requested.** Scope clean; fresh clone 106/0/0. Probe: a filter preview (2 rows) followed by a matching insert, then commit, deletes only the 2 previewed rows; replaying a submissionId leaves 1 operation row; a row_version bump between preview and commit gives 409 `preview_stale` and nothing is deleted; another owner's id in a preview gives 404. The every-path deleted test covers app, demo, partner/MCP (parity), and pull-forward sources. Trial merge onto `7611c2c`: 3 textual conflicts (styles, r1-01-routes, r1-02 id list) plus 2 semantic ones. `store.js` prepares `deleted_at` statements at load, so `r1-04-migration`'s 001-only boot fails (production is safe: migrations run before the store loads), and the full id lists need 006.
- 2026-10-13 · **R1-07, PR #22: changes requested at `02fc87d`, then approved at `2bdd835`.** First pass: fresh clone 115/0/0, scope clean. **Blocker:** the kept legacy `PATCH /api/admin/companies/:id` called `upsertCompanyMargin`, which inserted an **active** link for an unlinked customer (probe: new API returned 404, legacy returned 200 and created `status: active`). That was implicit authorization, which FR 7 and D-014 forbid, and it was reachable in production. Removing the legacy routes broke 7 tests; a link guard plus seeded setup got the scratch suite down to 1 failure, so the direction was proven. Second pass: rebased on `0ef93c1`; 125/0/0, CI green. Probes: legacy PATCH on an unlinked customer → 404 with 0 rows; authorize → revoke → legacy PATCH → 404 and the row stays `revoked`. Test changes (seeded links in r1-02-roles; migration id lists) are strengthenings. Litter: the worker's clone at `/Users/stephenforte/rateninja-r1-07` remains.
- 2026-10-13 · **R1-04, PR #24: approved at `ef2a04d`.** Base `94701d9` = main; scope clean. Fresh clone: 107/0/0. One gate sits right after the shared `requireSession`, before both the legacy and module dispatch, and reads the live row. Probe (`must_change_password = 1`): legacy routes (`/api/rates`, 2FA start, `/oauth/consents` GET and DELETE) and module routes (`/api/account`, admin-context ×3, preferences) all return 403 `password_change_required`; `/api/session` returns 200; a same-password change returns 400 and the flag stays 1. The worker's OAuth test uses a real PKCE request: GET and POST `/oauth/authorize` return 403 with 0 grants, and an unrestricted control sees consent.
- 2026-10-13 · **R1-03, PR #18: approved at `dc572ef`.** Base `d264f95` is stale, but a trial merge of main `05de3f8` + #17 + #18 has no conflicts, and that combined tree passes 97/0/0; CI green on `dc572ef`. Browser check on the combined tree (scratch DB, generated test passwords): a cold `/admin/users` deep link loads its CSS and shows "Select a company" (no 409); choosing Blackwater sets `companyContext` and the user list shows only Alan; Back/Forward work; `aria-expanded` and Escape work; a customer member deep-linking an admin page gets "Access denied" and sees no admin links; `/rates` renders a seeded rate with the menu (z-index 50) above the table. Litter: the worker's clone at `/Users/stephenforte/rateninja-r1-03` remains; the operator should delete it.
- 2026-10-13 · **R1-02, PR #17: approved at `c45a0cb`** after D-021 and the rebase onto `05de3f8`. Fresh clone: 88/0/0. Probes: the company list returns 403 to a company admin; for a system admin it returns only `{id, name, companyType}`, sorted; no context gives 409; after POST context, users returns 200 and the session reports the chosen company. The rebase touched R1-12's files only in the one specified line.
- 2026-10-13 · **R1-12, PR #19: approved at `2797c08`.** Base `d264f95` = main; scope clean. Fresh clone: 74/0/0. The golden test, run against a clean main checkout, passes 2/2, so the captured predictive bytes really are main's. The parity test covers cross-owner `not_found`, scope, schema rejection without an audit row, 90/91 days, the MCP audit channel, revocation, the deployment gate, and demo-key rejection, all over real HTTP. Real client: Inspector 2.10.1 with OAuth; revocation made the next call fail. **Trial merge #19 + #17 + #18:** one textual conflict in `test/r1-01-routes.test.js` (module-count check), plus a semantic one: the R1-12 parity setup creates OAuth clients as a company admin, which D-008 now forbids. With both fixed (one line sets `is_system_admin` in setup), the combined suite is 96/96, 0 cancelled. **Merge order: #19, then #17 (rebased, carrying both fixes), then #18 immediately after (D-021).**
- 2026-10-13 · **R1-02, PR #17: changes requested (one item, a planning gap).** Base `d264f95` = main; scope clean. Fresh clone gate 84/0/0, matching the handoff. Live probes (startApp + direct DB edits): a demoted admin's existing session gets 403 on its next request (permissions read live); a company admin's PATCH on another company's user returns 404 and leaves it unchanged; the user list is limited to their own company. **Blocker:** a system admin with no context gets 409 on users and companies, and nothing lists companies to select, so production admin screens are locked once 001 makes SteveF a system admin. The fix is D-021 (company-list endpoint in R1-02, selector in R1-03, back-to-back merge).
- 2026-10-13 · **R1-01, PR #14: approved at `5be291c`.** The fix changed only `.gitignore` (`data/`) and added one test. Fresh clone: 71/0/0. With the fix reverted, the new ignore test fails, so it can catch the problem. Approval posted on #14.
- 2026-10-13 · **R1-01, PR #14: changes requested (one item).** Base `323b4aa` = main; scope clean. Gate re-run in a fresh clone: 70/0/0, matching the handoff. Probes with fixture migrations via `MIGRATIONS_DIR` on the default file DB: no-pending start makes no backup; pending `001` is applied once and backed up once, and the second start is a no-op; a throwing `002` exits 1 with its id in the message, is not recorded, and its partial table is rolled back. Doc routes are an exact map. **Blocker:** `.gitignore` has `data/*.db` but backups go to `data/backups/`, and the repo is **public**, so a full DB copy (hashes, TOTP secrets) shows as untracked and one `git add -A` would publish it. Fix (replace with `data/` + a `git check-ignore` test) proven in the clone; posted on #14.
- 2026-10-12 · **R1-00, PR #12: approved, merge as-is.** Base `af1bee5` = main; scope clean. Gate re-run in a fresh clone (Node 26): 55/0/0, matching the handoff. Probes (`curl --path-as-is` against my own server): source, `public/` prefix, a planted `data/x.db`, encoded and double-encoded traversal, `%00`, `/./`, trailing slash, a planted symlink, and an absolute-form request line all return non-200 with no body leak. Pages still 200. The probes can fail: old main returned 200 for `/lib/db.js` and for a `data/` DB. **Regression:** `/docs/partner-integration.md` (advertised in OAuth metadata, `lib/oauth.js:755,765`) and `/API-README.md` (linked from `api-docs.html`) now 404. The fix is folded into R1-01 (exact-path routes). `/api/health` 503 without secrets is also true on main, so it's environmental. Review posted on #12.
- 2026-10-12 · docs PR #10 merged (`93b5d61`): D-017, import split. D-018 then deferred PDF/unstructured past Round 1.
- 2026-10-12 · docs PR #9 merged (`98bd634`). Verified: both files on main byte-identical to the reviewed drafts (`git show | diff`).
