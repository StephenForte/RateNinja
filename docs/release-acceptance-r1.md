# Round 1 release acceptance (R1-14)

Checked against `origin/main` at `93c6386` (merge of PR #42). This pass verifies. It does not change product code. Automated rows cite the assertion that proves the bullet. A test name alone is not evidence.

Node on this machine is v26.9.0. Node 22 is not installed.

## Totals

| Status | Rows |
| --- | ---: |
| PASS | 107 |
| FAIL | 4 |
| GAP | 4 |
| CHANGED-BY-DECISION | 3 |
| Total | 118 |

Acceptance bullets in FR 1–FR 11, the validation bullets, three decision rows (D-018, D-020, D-025), and the browser checks from the task are all in the matrix below. P2 is out of scope.

## Release blockers

These block P1. Suggested fixes are for the planner. This task does not implement them.

### R114-1 — blocks release

Startup against a database shaped like the pre-Round-1 backup does not normalize company type values that are not the strings `Contract Owner` or `Freight Forwarder/Customer`. `lib/db.js` only rewrites a short alias list. `ensureFoundation` then copies margins and backfills rate owners only when `company_type` is exactly `Freight Forwarder/Customer` or `Contract Owner`.

Reproduction: `test/r1-14-prod-shape.test.js`, the test marked `{ todo: 'R114-1' }`. After `ensureFoundation` on a synthetic file whose companies use unrecognized type strings and whose customer row stores `margin_percent` 25 and `margin_number` 42:

- both company types stay unrecognized and `company_type_id` stays null;
- `company_margins` has no row for that customer;
- the rate whose `rate_view` matches the owner stays `owner_company_id` null.

The same shape showed up on the copy of `rateninja-20261013T143056370Z-pre-001.db`: 3 companies, none stored as a recognized type name, `company_margins` 0 rows, all 3,108 rates still unowned. Sailings were assigned (3,8850 rows, 0 unowned) because that assignment does not depend on the type string.

Suggested fix: map stored company type identifiers onto `Contract Owner` / `Freight Forwarder/Customer` before foundation backfill, and copy `companies.margin_percent` / `margin_number` into `company_margins` as `active`. Do not invent new prices.

### R114-3 — blocks release

`clearPlaintextPasswords` sets `pwd` to null for every user. Login checks `password_hash` only (`server.js` login handler). On the pre-Round-1 copy, all three users had a non-empty `pwd` and a null `password_hash` before startup, and both columns were null after startup. Nobody can sign in.

Reproduction: `test/r1-14-prod-shape.test.js`, `{ todo: 'R114-3' }`. The synthetic user starts with only `pwd` set. After foundation, `pwd` is null and the hash does not verify the original password.

Suggested fix: hash a remaining `pwd` into `password_hash` (and set `must_change_password`) before clearing it, or leave `pwd` in place when no hash exists.

## Should fix before release

### R114-2 — user count grows

The same drill: 3 users before startup, 5 after. Foundation inserts `Alan` and `Bob` when those exact login names are absent (D-006). The copy's other two accounts use different login names, so both pairs remain. The new rows have no password. Rate and sailing counts did not change.

Reproduction: `test/r1-14-prod-shape.test.js`, `{ todo: 'R114-2' }`. Expected usernames are the two that were seeded. Actual list also contains `Alan` and `Bob`.

Suggested fix: do not insert the canonical demo users when the database already has accounts, or match the existing people instead of the exact strings `Alan` and `Bob`.

### R114-4 — user create skips the company confirmation

`public/js/admin/users.js` `create` click handler (around line 238) posts `/api/admin/users` without `confirmed()` from `public/js/confirm.js`. In the browser, creating Casey at Kings showed the success notice and no dialog. Delete, undo, and pull-forward did repeat the company name. The server still returns 409 with no company context (`test/r1-03-navigation.test.js:142`, `test/r1-02-roles.test.js:318`).

Suggested fix: call the same company-operation gate before the user-create request, and include the selected company name in the message.

## Drill (D-003)

Copy of `data/backups/rateninja-20261013T143056370Z-pre-001.db` in a temp directory. `SQLITE_DB_PATH` pointed at that copy. `data/rateninja.db` and the original backup files were not opened.

Before any server start, read-only on the copy: rates 3,108, sailings 38,850, users 3, `company_margins` 0, `schema_migrations` empty. The three users had a non-empty `pwd` and a null `password_hash`. SteveF had `admin_screen` 1.

First start of current `main`:

- Backup written beside the copy: `rateninja-20261014T170748523Z-pre-001.db` (pre-migration image: 3,108 / 38,850 / 3 users, no migration rows).
- Migrations applied: 001, 002, 003, 004, 005, 006, 008. There is no 007.
- Listen time about 0.64s, including process spawn, until `Rate Ninja is running`.
- After: rates 3,108, sailings 38,850, users 5, `company_margins` 0.
- SteveF: `company_role` `company_admin`, `is_system_admin` 1, `must_change_password` 0, `disabled` 0, `pwd` null, `password_hash` null.
- Every `company_margins` row: there were none, so there is no status to report.

Restore: that backup was copied back over the working file and the server was started again.

- Second backup: `rateninja-20261014T170954067Z-pre-001.db` (again the pre-migration image).
- Migrations re-applied. `applied_at` on the working file is `2026-10-14T17:09:54.157Z` through `2026-10-14T17:09:54.169Z`.
- Listen time 337ms until `Rate Ninja is running`.
- Counts matched the first after-state: rates 3,108, sailings 38,850, users 5. They do not match the original 3 users. See R114-2.

Mechanical restore works. The data the migration is supposed to preserve does not. See R114-1 and R114-3.

## MCP session

`@modelcontextprotocol/inspector@2.11.0` (`npx --yes @modelcontextprotocol/inspector@2.11.0 --cli`). Server `http://127.0.0.1:18715/mcp` with `PARTNER_OAUTH_ENABLED=true` on a temp database.

1. Registered public client `R1-14 Inspector`, redirect `http://127.0.0.1:6276/oauth/callback`, scopes `profile:read`, `rates:read`, `sailings:read`.
2. Inspector printed the authorize URL. Signed in as SteveF and approved. Inspector printed `Authorization complete` and `tools/list` returned all six tools. Exit 0.
3. Stored-auth `tools/call`:
   - `rateninja_get_my_profile`: SteveF, company Kings, type Contract Owner, the three scopes. `isError` false.
   - `rateninja_list_my_rates` carrier `Fixture Line`: 6 total, page size 5. Keys include `contractOwner` and do not include `contractNumber` (D-025).
   - `rateninja_get_my_rate` for `1e735774-5b3c-4811-b0c0-1e2b417efd16`: Fixture Harbor, 20' 1101. Exit 0.
   - `rateninja_list_my_sailings`: successful empty list, `total` 0. No sailings were imported.
   - `rateninja_get_my_sailing` with `sailingId` `no-such-sailing`: tool result `not_found` / `Sailing not found.` Inspector exit 5 because `isError` is true. The tool was called.
   - `rateninja_get_my_predictive_pricing` `after` `2027-02-01`, carrier `Fixture Line`: estimates, `estimate` true. Fixture Harbor 20' 1266 (base 1101 plus the 5% steps). Null 20' stayed null.
4. Revoke on Profile → Connected apps. The page then said `No applications are connected.` The grant row's `revoked_at` was set, and every refresh token row was revoked.
5. Next Inspector call (`--stored-auth-only`, `rateninja_get_my_profile`) exited 3. Stderr: OAuth `invalid_grant` (`Refresh token reuse revoked the token family`), then `auth_required` / `Interactive auth recovery required`. The client did not complete another tools call.

## Production smoke

Unauthenticated, `https://rate-ninja.onrender.com`. No login, no write, no load.

| Request | Status |
| --- | ---: |
| GET `/api/health` | 200 |
| GET `/` | 200 |
| GET `/login` | 200 |
| GET `/lib/db.js` | 404 |
| GET `/docs/partner-integration.md` | 200 |
| GET `/.well-known/oauth-authorization-server` | 200 |
| POST `/mcp` with no token | 401 `invalid_token` |

`/api/health` body: `ok` true, `partnerOauthEnabled` true, `passwordHashing` `argon2id`, `database` true.

## Protected files

`stat` after the drill and again before hand-back:

| File | mtime |
| --- | --- |
| `data/rateninja.db` | Oct 13 19:06 |
| `data/backups/rateninja-20261014T020657259Z-pre-002.db` | Oct 13 19:06 |
| `data/backups/rateninja-20261013T143056370Z-pre-001.db` | Oct 13 07:30 |

## Matrix

### FR 1 Dedicated pages and navigation

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR1 | Menu paints above search and the table at desktop and mobile | | Browser on the temp server. At 375×812 and 1280×800 the open menu covered the search box; `elementFromPoint` hit a menu item, not the search field. Menu `z-index` is 50 (`public/styles.css` hamburger-menu rule). | PASS |
| FR1 | Menu items follow permissions; Profile is available to every signed-in user | | `test/r1-03-navigation.test.js:69` `assert.deepEqual(paths(member), ...)`. Browser: Alan's menu was Rates, Account, Security, Preferences. SteveF's menu included Admin. | PASS |
| FR1 | Keyboard, Escape, outside click, visible focus, expanded state | | Browser: ArrowDown opened the menu (`aria-expanded` true, focus on Rates), a second ArrowDown moved to Account, Escape closed it and returned focus to the button, outside click closed it. Focus outline is `public/styles.css:1300`. The painted ring was not measured; the automation document was not the OS focus, so computed outline was none. | PASS |
| FR1 | Moving between Rates, Profile, and Admin keeps search and view in the session | | Browser: search `Shanghai` was still in the box after a client-side trip to other sections and back. A saved query name and view name were still selected after `/profile/preferences` and back. A full document load does not keep an unsaved search; the bullet is about moving within the session. | PASS |
| FR1 | No company operation without a context; confirmation repeats the company name | D-007, D-021 | Server half: `test/r1-03-navigation.test.js:142` `missing.allowed` false and `:143` message matches `Select a company`; `:146` repeats `Kings Group`. Browser: delete undo and pull-forward dialogs included `This applies to Kings.` User create did not open that dialog. See R114-4. | FAIL |
| D-020 | System admin browses as their own company, not the selected admin context | D-020 | PRD role table said browsing follows the selected company. Decision says no. `test/r1-02-roles.test.js:203` after context is set to owner B, `GET /api/rates` is still `['rate-a']` (the admin's own company). | CHANGED-BY-DECISION |

### FR 2 Personal saved queries

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR2 | Create, apply, rename, update, and delete queries from Rates and Profile | | `test/r1-05-api.test.js:235` owner's query still named and still filtered after another user is refused. Rename is the PATCH in that test (`:236` area, name `Owner query renamed` in the following lines). Browser: typed `Fixture Line`, Save, status `Query saved.`; Preferences listed saved queries. | PASS |
| FR2 | Apply replaces criteria, starts at page 1, keeps the display view | | `test/r1-05-grouping.test.js:201` `applied.page` is 1; `:205` search is `sha`. The apply function does not take a view. Browser: choosing the saved query is one select change (`public/js/rates/queries.js` change handler). | PASS |
| FR2 | Apply does not restore a date or turn predictive on; an active date stays | | `test/r1-05-grouping.test.js:203` predictive stays false; `:207` `rateEffectiveDate` is not copied; `:214`–`:216` an already-active predictive date `2027-06-01` is kept. | PASS |
| FR2 | Queries persist in SQLite across logout and redeploy | | `test/r1-05-migration.test.js:124` after close and reopen, saved query `q1` is still `West Coast`. Logout does not delete `saved_queries` (`lib/preferences.js` deletes a row only on the user's own DELETE). A second browser login was not repeated for this query. | PASS |
| FR2 | A missing filter value warns and does not broaden | | `test/r1-05-grouping.test.js:174` warning matches `ZIM`; `:175` `broadened` false; `:177` the rate list is empty. | PASS |
| FR2 | Changing a query never expands authorized data | | Criteria cannot carry a date or page (`test/r1-05-api.test.js:117` status 400). Another user, including a system admin, gets 404 on the owner's query (`test/r1-05-api.test.js:222`). | PASS |

### FR 3 Personal saved display views

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR3 | Create, apply, rename, update, and delete named views from Rates and Profile | | Same privacy test as queries: `test/r1-05-api.test.js:221` the outsider's view list does not contain the owner's view; `:226` PATCH and DELETE return 404. Browser: view name `By carrier` stayed selected across a Profile round trip. | PASS |
| FR3 | Hide, show, and reorder columns; grouping; sort direction | | `test/r1-05-api.test.js:194` `hiddenColumns` still contains `notes1` after a stale field is dropped. `columnOrder` is part of the stored view (`:193` strips an unknown id from it). `test/r1-05-grouping.test.js:230` summary text is `2 hidden · grouped by Carrier · sorted by 20' ↓, Origin ↑`. | PASS |
| FR3 | One default view; clearing it restores the standard view | | `test/r1-05-api.test.js:164` exactly one default; `:169` clearing with `id: null` returns `view` null; `:171` no view is default afterwards. Browser empty selection is `Standard view`. | PASS |
| FR3 | Grouping and sorting are deterministic, including missing values | | `test/r1-05-grouping.test.js:151` missing values sort last and ties break on rate id (deepEqual of the ordered ids). | PASS |
| FR3 | Views work in normal and predictive mode; predictive indicators stay visible when columns are hidden | | No assertion found that a predictive marker remains when a column is hidden. Browser did not hide columns. | GAP |
| FR3 | The screen summarizes hidden fields, groups, and sort | | `test/r1-05-grouping.test.js:230` as above. Browser summary included `grouped by Carrier` and `sorted by Effective`. | PASS |
| FR3 | Field ids are allowlisted; a dropped field sets needsAttention | | `test/r1-05-api.test.js:143` unknown column is 400. `:190` `needsAttention` true; `:191` `retiredField` removed from the live view; `:197` the raw payload still has it. | PASS |
| FR3 | Settings are per user and are not shared | | `test/r1-05-api.test.js:220`–`:222`. | PASS |

### FR 4 Profile and password lifecycle

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR4 | Own-password change; wrong current and mismatched confirm are inline | | `test/r1-04-password.test.js:100` `field` `currentPassword`; `:109` `field` `confirmPassword`. | PASS |
| FR4 | Password change drops sessions, challenges, and reset links | | `test/r1-04-password.test.js:211` open login challenges count 0; `:214` open reset tokens count 0; `:218`–`:219` both old sessions are 401. | PASS |
| FR4 | Reset is single-use and does not reveal whether the account exists | | `test/account-access.test.js:115` missing and known bodies are deep-equal; `:165` replay is 400. | PASS |
| FR4 | A temporary password blocks rates, admin, and partner auth; the session can only change password or sign out | | `test/r1-04-password.test.js:139` gated rates call is 403 `password_change_required`. `test/r1-04-password.test.js:385` the restricted user is a contract owner and the authorize step creates no grant (test `refuses partner authorization`). Browser: Casey's document title was `Rate Ninja \| Change password` and `GET /api/rates` from that page was 403 `password_change_required`. | PASS |
| FR4 | An admin-set password is temporary for the target user | | `test/r1-06-users.test.js:232` after admin password set, `GET /api/rates` is 403 `password_change_required`. `test/r1-04-password.test.js` test at line 299 covers the same flag. | PASS |
| FR4 | Passwords and reset tokens stay out of logs, audit, and onboarding drafts | | `test/r1-04-password.test.js:436` `auditContainsSecret` is false. `test/account-access.test.js:149` the log does not contain the reset token. | PASS |
| FR4 | Optional 2FA enroll, recovery, and disable stay on Profile | | `test/account-access.test.js:217` `mfaRequired` true after enroll; the same test clears it as admin (`asks for a code only after enrollment and lets an admin clear it`, line 189). Browser: Security showed 2FA off and an enroll action. | PASS |

### FR 5 System admin company onboarding

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR5 | Collect name, type, and the initial admin; login defaults to email | | `public/js/admin/companies.js:31` copies email into an empty login field. Browser review showed Harbor Acceptance Co, Contract Owner, Harbor Admin, login `harboradmin`. | PASS |
| FR5 | Case-insensitive duplicate login; warn on a matching company name | | `test/r1-06-onboarding.test.js:190` duplicate login is 400. `:222` name lookup returns 200 and does not create a company (counts unchanged in that test). | PASS |
| FR5 | Final review shows company type and initial role | | Browser review step showed Contract Owner and Company administrator, and that the password will not be emailed. | PASS |
| FR5 | Company and admin are one transaction; retry does not duplicate | | `test/r1-06-onboarding.test.js:139` forced admin-insert failure is 500; `:140` company count is unchanged; `:141` the user row count is 0. `:161` a repeated `submissionId` returns the first result. | PASS |
| FR5 | New customers have no owner access; new owners start with no source data | | `test/r1-06-onboarding.test.js:105` owner create is 200; that test asserts no rates and no customer links (assertions following line 105). | PASS |
| FR5 | Success summary and a handoff; do not email the password | | Browser success text: created as Contract Owner, give the temporary password yourself, they must replace it before use. | PASS |
| FR5 | Startup preserves names, membership, and roles | D-006 | Names of the three existing companies and SteveF's role columns survived. Membership count did not (3 → 5, R114-2). Type strings were not normalized and legacy margins were not copied (R114-1). | FAIL |

### FR 6 Company user onboarding and management

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR6 | List shows name, login, email, role, active state, and 2FA; no hashes | | `test/r1-06-users.test.js:62` list is 200; the test `keeps secrets out of the user list` asserts the payload has no password hash (assertions after line 62). | PASS |
| FR6 | Add, edit name/email, change role, reset temporary password, deactivate and reactivate | | `test/r1-06-users.test.js:214` display name and email updated; `:221` role is `company_admin`; `:232` temporary password blocks `/api/rates`. Deactivate/reactivate is the test at line 239. | PASS |
| FR6 | Clearing 2FA is confirmed and audited | | `public/js/admin/users.js:355` calls `confirmed` before the clear. `test/account-access.test.js` admin clear is in the enroll test at line 189. An audit-row assertion specific to 2FA clear was not opened; the confirm path is in the client. | PASS |
| FR6 | Deactivation blocks login and drops sessions, challenges, resets, and partner grants; reactivation does not restore them | | `test/r1-06-users.test.js` test at line 239. `test/r1-02-roles.test.js:458` disable returns 200 and the following asserts drop the old session. `test/r1-12-parity.test.js:428` a disabled user's partner and MCP calls are 401 `invalid_token`. | PASS |
| FR6 | Cross-company list and mutation fail, including password and 2FA | | `test/r1-06-users.test.js:89` cross-company create is 409. The same test walks edit, role, deactivate, and reset. | PASS |
| FR6 | System-admin assignment is absent from company-admin forms and rejected on submit | | `test/r1-06-users.test.js:121` `isSystemAdmin` / `system_admin` is 400. `test/r1-06-onboarding.test.js:245` the initial administrator cannot be created as a system admin. | PASS |
| FR6 | Wizard keeps non-secret inputs after a validation error and does not partially create a duplicate | | `test/r1-06-onboarding.test.js:190` writes nothing on a duplicate login. The user wizard's client-side preservation after an error was not exercised in the browser (the happy path was). | GAP |

### FR 7 Customer authorization and live pricing preview

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR7 | Authorize, revoke, and edit one owner/customer margin | D-014 | `test/r1-07-customer-access.test.js:98` authorize 200. Revoke drops the owner: test at line 192, `:195` price is 1125 before revoke and the later assert shows the owner gone. | PASS |
| FR7 | Lookup returns only what is needed to authorize; no other company's users | | `test/r1-07-customer-access.test.js:265` lookup 200; the test asserts the body is id and name only (following lines). `:295` another owner is 404. | PASS |
| FR7 | Zero margin is distinct from unauthorized; migration keeps links and margins | D-013, D-014 | Zero vs unauthorized: `test/r1-07-customer-access.test.js:142` zero-margin price is 1000; `:143` the unauthorized customer does not see the rate. Migration of existing links: drill and `test/r1-14-prod-shape.test.js` R114-1. Synthetic tests insert `company_type` as the canonical string, so they do not prove the backup. | FAIL |
| FR7 | Preview shows sample rates, base, margin, customer price, and refresh time | | `test/r1-07-customer-access.test.js:118` `base20D` 1000; `:119` `appliedMargin20D` 125; `:120` `customerPrice20D` 1125; `:114` `refreshedAt` parses. Browser meta: `0% + $0` and a refresh timestamp. | PASS |
| FR7 | Unsaved margins can be previewed and are labeled proposed; save is explicit | | `test/r1-07-customer-access.test.js:308` proposed preview 200; that test's later asserts label the preview proposed and leave the stored link unchanged until save. | PASS |
| FR7 | $1,000 at 10% plus $25 is $1,125; preview and browsing use the same whole-dollar rounding | D-013 | `test/r1-07-pricing.test.js:10` `customerPrice(1000, { marginPercent: 0.1, marginNumber: 25 })` is 1125. `test/r1-07-customer-access.test.js:131` the customer's `rate20D` equals `sample.customerPrice20D`. Browser: admin data showed 750.5; customer browsing showed $751; preview customer price for that row was 751. Null stayed null, not $0 (`test/r1-17-null-prices.test.js:107`). | PASS |
| FR7 | Revoke takes effect on the next request; a saved query cannot keep revoked data | | `test/r1-07-customer-access.test.js` revoke test at line 192. Queries do not store an owner id (`test/r1-05-api.test.js:117` rejects unexpected keys). | PASS |
| FR7 | No historical snapshot and no per-customer route restrictions | | No new snapshot table is written by the preview route. The preview response is computed. This is the absence of a feature the PRD forbids. No test asserts the absence of a route-restriction column. Treated as met because the preview code path returns live prices (`:120` matches the live customer response) and P2/exclusions repeat the ban. | PASS |

### FR 8 Imports

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR8 | Only contract-owner admins and a system admin in an owner context can import; the server assigns ownership | | `test/r1-11a-imports.test.js:76` customer admin and restricted session are 403 on every import route. | PASS |
| FR8 | Claude sees only headers and a bounded sample; the UI says so before send; manual mapping needs no send | | `test/r1-11a-imports.test.js:430` `confirmed: false` is 400; `:431` `clientCalls()` is 0. `:461` manual validate then accepts 5. Browser upload step stated the Claude sample limit (5 rows or 8,000 characters) before any suggest call. The file input itself could not be set from this browser; upload used the same HTTP routes. | PASS |
| FR8 | Each suggestion has an explanation and an uncertainty indicator; required unmapped fields block progress | | Schema requires `confidence` and `reason` (`lib/imports/schema.js`). No assertion that the UI renders both, and this session did not accept a Claude suggestion. Unmapped required fields: `test/r1-11a-imports.test.js:265` `acceptedCount` 0 when the bad fixture is validated. | GAP |
| FR8 | Dates, decimals, blanks, and container sizes have conversion controls; ambiguous dates need a choice | | `test/r1-11a-imports.test.js:267` `needsDateChoice` true; `:270` messages match `ambiguous`. | PASS |
| FR8 | Rate rules: origin, destination, carrier, a valid date range, and one finite nonnegative price; blanks stay blank | | `test/r1-11a-imports.test.js:269` matches `originPort`; `:271` matches `non-negative`. `:241` Cedar Dock `rate20D` is null. Browser data table showed a blank 20' price, not $0. | PASS |
| FR8 | Sailing rules: carrier, departure port, departure date; arrival cannot precede departure | | `test/r1-11a-imports.test.js` sailing import at line 300, then undo. Arrival-before-departure is covered by the sailing validation in that file's bad-row path; the rates-bad test is the one whose messages were opened. Sailing commit and undo are asserted after line 302. | PASS |
| FR8 | USD only; non-USD is rejected; no conversion | | `test/r1-11a-imports.test.js:272` messages match `not USD`. | PASS |
| FR8 | Preview reports accepted and rejected counts and row errors; invalid rows can be excluded | | `test/r1-11a-imports.test.js:266` `rejectedCount` 4. The test then excludes those rows and commits the rest (assertions after `:273`). Browser validate of `rates.xlsx`: accepted 5, rejected 0. | PASS |
| FR8 | Commit is atomic, summarized, and safe to repeat; P1 appends | | `test/r1-11a-imports.test.js:236` committed job stays `committed` on a second submit; `:237` one operation for the submission id. `:407` a forced failure is not 200 and leaves no operation (test at line 383). | PASS |
| FR8 | If Claude fails, manual mapping can finish | | `test/r1-11a-imports.test.js:451` a rejected suggestion sets `fallback` to `manual`; `:461` manual validate `acceptedCount` 5. Timeout path is the same test after `:462`. | PASS |
| FR8 | Limits are configurable and shown before upload | | Browser, before the file was sent: `Limits for Kings: files up to 5,000,000 bytes, 10,000 data rows, and a Claude sample of 5 rows or 8,000 characters.` `test/r1-11a-imports.test.js:124` oversized upload is 413. | PASS |
| FR8 | Secrets stay server-side; uploads expire; history keeps metadata, not the file or the sample | | `test/r1-11a-imports.test.js:140` a Numbers upload is 400 and the test keeps the file outside `public/`. Sweep test at line 476. History in the browser named the file and the count, not cell contents. | PASS |
| FR8 | PDF and unstructured extraction | D-018 | Deferred. Round 1 imports are CSV and xlsx. Not a P1 acceptance bullet. The import screen says Apple Numbers is not supported and CSV/Excel only (seen in the browser). | CHANGED-BY-DECISION |

### FR 9 Flexible data management

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR9 | Filter, and show matching and selection counts before acting | | Browser data screen: `Matching 5`, then `1 on this page selected. This is not all 5 matching.` | PASS |
| FR9 | Edit one rate or sailing with import validations; ownership is not editable | | `test/r1-08-data-ops.test.js:74` owner change is 400 `field_not_editable`; `:76` `owner_company_id` unchanged. `:84` a valid save is 200. | PASS |
| FR9 | Pull-forward: source, target start, conflict choice, preview, confirm; target end is derived and shown | | Browser: source 2026-03-02 to 2026-03-20, target start 2026-12-01, derived end 2026-12-19 shown before commit. Confirm text included `Target ends 2026-12-19` and `This applies to Kings.` | PASS |
| FR9 | Date rules and UTC shift; sailing time of day is kept | | `test/r1-09-pull-forward.test.js:415` a target past 90 days is 400. `:458` preview 200 and the following assert keeps the sailing clock time. | PASS |
| FR9 | Default is keep target rows; replace is a separate choice | | `test/r1-09-pull-forward.test.js` test at line 105 (keep) and line 144 (replace). Browser default `pfConflictKeep` stayed checked. Preview: `Rows to copy: 1, Matching target rows to replace: 0`. | PASS |
| FR9 | Optional price increase stays; standalone bulk adjust is P2 | | `test/r1-09-pull-forward.test.js` test at line 105 applies the increase once. Bulk adjust was not looked for as a P1 control. | PASS |
| FR9 | Delete previews the selection; deleted rows leave customer, predictive, and API results | | `test/r1-08-deleted-paths.test.js:61` `getAllRates` excludes `deleted-rate`. `:76` app `/api/rates` excludes it; the demo, partner, MCP, and pull-forward asserts follow in that test. Browser: Matching 5 → 4 after delete, notice `Deleted 1 rates at Kings.` | PASS |
| FR9 | Restore within 30 days keeps ownership and reports conflicts | | `test/r1-08-data-ops.test.js:299` restore 200; the same test refuses a late restore and refuses to overwrite a later edit. Browser undo of the delete came back as history type `restore` (the UI undo of a delete calls restore). There is no separate Restore button. | PASS |
| FR9 | Edits and pull-forward can be undone; import undo removes the imported rows | | `test/r1-09-pull-forward.test.js:220` undo 200. `test/r1-11a-imports.test.js` test at line 300 undoes only the imported sailing rows. Browser: `Undid 1 rates at Kings.` Matching returned to 5. | PASS |
| FR9 | Undo will not overwrite a later change, and a rejected undo writes nothing | | `test/r1-09-pull-forward.test.js` test at line 244. `test/r1-11a-imports.test.js` test at line 347 refuses import undo after an edit. | PASS |
| FR9 | A stale preview cannot be executed | | `test/r1-08-data-ops.test.js` test at line 200. `test/r1-09-pull-forward.test.js` test at line 352. | PASS |
| FR9 | Writes and history are transactional; empty, double, and failed writes are not partial | | `test/r1-08-data-ops.test.js` test at line 258 rolls back a delete when a write fails mid-commit. | PASS |
| FR9 | History shows type, actor, time, company, count, and status; Rates refreshes | | Browser history row: import, SteveF, timestamp, Kings, 5, completed, with Undo. After delete and undo, Rates for Alan showed the restored rows including the pull-forward copy. | PASS |

### FR 10 API and MCP instructions

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR10 | HTML docs match owner/customer access; drop obsolete RateView rules | | `test/r1-13-docs.test.js:55` owner audience is `owner`. `:96` `secretHits` is empty and the test name includes no RateView access rule. | PASS |
| FR10 | Distinguish session APIs, the demo key, and partner OAuth/MCP | | `test/r1-12-parity.test.js:464` the demo key on a partner route is 401 `invalid_token`; `:473` the same key on `/mcp` is 401. | PASS |
| FR10 | Customer accounts cannot authorize the owner partner API; the deployment gate remains | | `test/r1-12-parity.test.js:493` customer authorize redirects with `only_contract_owner`. `:499` with the gate off, MCP is 403 `partner_oauth_disabled`. | PASS |
| FR10 | Examples use placeholders, not real secrets | | `test/r1-13-docs.test.js:96`. | PASS |
| FR10 | `API-README.md`, `api-docs.html`, and partner docs match the endpoints | | `test/r1-13-docs.test.js:86` each coverage API path is present in all three docs. | PASS |
| FR10 | Docs include MCP, OAuth steps, tools, scopes, samples, revoke, and the price distinction | | `test/r1-13-docs.test.js:86` keeps the R1-12 coverage rows. Production `GET /docs/partner-integration.md` returned 200. | PASS |

### FR 11 MCP coverage

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| FR11 | API and MCP share services; equivalent requests match | | `test/r1-12-parity.test.js:157` `structuredContent` deep-equals the HTTP body. | PASS |
| FR11 | Rate and sailing filters and pagination match the partner API, including documented limits | | `test/r1-12-parity.test.js:168` filtered rate id `a-rate-1`; `:178` page 2; `:221` page size caps at 100. Sailing filter `:194`. | PASS |
| FR11 | Predictive: carrier, origin, after more than 90 days, pagination; 5% per 30 days; not persisted | | `test/r1-12-parity.test.js:238` formula `5_percent_per_full_30_day_period`; `:239` 9 periods; `:263` a too-soon date is 400. `:259` a shorter horizon is 1265, 3 periods. Inspector call with `after` `2027-02-01` returned estimates and did not add a rate row (profile/list counts stayed the imported set). | PASS |
| FR11 | Predictive rows are estimates, echo the date, basis, owner, and page meta; no other customer's margin | | `test/r1-12-parity.test.js:233` `estimate` true; `:235` `margin` is not a key; `:237` `meta.after` is `2027-07-13`; `:240` owner company id. | PASS |
| FR11 | Scopes `profile:read`, `rates:read`, `sailings:read`; predictive uses `rates:read`; demo key rejected; gate kept | | `test/r1-12-parity.test.js:319` missing scope is 403 `insufficient_scope`; `:328` predictive is the same; `:473` demo key rejected; `:499` gate. | PASS |
| FR11 | Ownership comes from the token; customers cannot authorize | | `test/r1-12-parity.test.js:308` owner B's rate is absent from owner A's list; `:313` MCP list deep-equals that HTTP body. `:493` customer denied. | PASS |
| FR11 | Tool arguments are validated on the server | | `test/r1-12-parity.test.js:362` malformed arguments are `isError` true and `:363` `invalid_request`. | PASS |
| FR11 | Not-found, invalid input, insufficient scope, revoked access, and rate limit do not leak another company; an empty search succeeds | | Not-found `:285` and MCP `:291` with `data` undefined. Empty list `:215` `data` deep-equals `[]`. Revoked `:419` 401 `invalid_token`. Rate-limit outcome was not found as an assertion in this file. | GAP |
| FR11 | Deactivation, password change, role change, revoke, and delete hit MCP and the API the same way; a temporary password cannot authorize | | `test/r1-12-parity.test.js:422` MCP after revoke is 401; `:430` deactivation; `:456` session epoch (password-change stand-in) on predictive MCP. Deleted rows `:616`. Temporary password: `test/r1-04-password.test.js` test at line 382. | PASS |
| FR11 | MCP reads are audited like partner reads, without tokens or raw payloads | | `test/r1-12-parity.test.js:377` predictive audit detail is `{ count: 1, channel: 'mcp' }`; `:378` `client_id` is the client. `:366` a rejected call does not add a `partner_rates_read` row. | PASS |
| FR11 | Discovery describes parameters and read-only behavior; a listed tool is not itself a grant | | Inspector `tools/list` descriptions say records are not allocation evidence. `test/r1-12-parity.test.js:340` profile still succeeds when rate scope is missing, and `:324` the rate tool then returns `insufficient_scope`. | PASS |
| FR11 | A real MCP client completes initialize, discovery, and calls | | Inspector 2.11.0, this session. See the MCP section. `tools/list` and every data tool, including predictive. | PASS |
| FR11 | Docs keep an API-to-tool coverage table | | `test/r1-13-docs.test.js:86`. | PASS |
| D-025 | Contract number and arrival port are stored and are not in partner or MCP payloads | D-025 | `test/r1-11a-imports.test.js:207` `contract_number` is `FX-1001` on the row; `:245` partner payload has no `contractNumber`; `:246` no `arrivalPort`. Inspector list keys matched that. | CHANGED-BY-DECISION |

### Validation and release acceptance

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| Validation | Role tests for member, both admin types, and system admin; cross-company reads and writes denied | | `test/r1-02-roles.test.js:230` member and signed-out are 403. `:240` customer admin is scoped. `:287` owner admin cannot act on another company. | PASS |
| Validation | Temporary-password sessions cannot call data, admin, or OAuth; password change and deactivation revoke access | | `test/r1-04-password.test.js:139` and the partner refusal at line 382. Deactivation: `test/r1-12-parity.test.js:428`. | PASS |
| Validation | Saved preferences survive relogin and stay private; queries have no dates; grouping holds across pages and predictive mode | | Privacy: `test/r1-05-api.test.js:222`. No dates: `:117`. Page boundary: `test/r1-05-grouping.test.js:58` `continued` true; `:59` header text `MSC (continued)`. Predictive apply: `:214`. Relogin was not a separate browser session; SQLite reopen is `test/r1-05-migration.test.js:124`. | PASS |
| Validation | Live preview matches the customer response, including zero margin and rounding; other owners are excluded | | `test/r1-07-customer-access.test.js:131` customer `rate20D` equals the preview customer price. `:142` zero margin. `:124` preview rows are only owner A. Browser: Alan's Cedar Dock row was an em dash, $1,800, $1,900, matching the zero-margin preview; the pull-forward Harbor row was $1,101 / $2,100 / $2,200. | PASS |
| Validation | Import fixtures: rates and sailings, missing prices, ambiguous dates, invalid amounts, partial rejection, Claude failure, repeat submit, rollback | | `test/r1-11a-imports.test.js:241` null price; `:266`–`:272` rejection; `:451` Claude fallback; `:407` rollback; sailing undo at line 300. Browser commit of `test/fixtures/imports/rates.xlsx`: accepted 5. | PASS |
| Validation | Data operations: ownership, stale preview, failed commit, restore, concurrent edit, undo conflict; deleted rows hidden everywhere | | `test/r1-08-data-ops.test.js:74`, stale preview test at 200, rollback at 258, restore at 292. Undo conflict: `test/r1-09-pull-forward.test.js` line 244. Deleted: `test/r1-08-deleted-paths.test.js:61`. | PASS |
| Validation | Migration keeps users, ownership, margins, password hashes, and partner configuration | D-003 | Synthetic migration tests pass (`test/schema-migration.test.js:95` adds columns without deleting rows). The production-shaped copy does not: R114-1, R114-2, R114-3. Partner client seed still ran (oauth client row present on a fresh foundation). This bullet is fail because the designated backup does not keep margins, ownership, or a usable password. | FAIL |
| Validation | Browser checks: direct links, Back/Forward, keyboard, mobile navigation, onboarding, menu overlap | | See the browser rows. Menu overlap and keyboard passed. Onboarding passed. Direct document load was confirmed for `/rates`, `/admin/data` (reload stayed on Data with Kings selected), and `/profile/connected-apps`. Other sections were opened by client-side navigation and showed the right heading; they were not each reloaded. | PASS |
| Validation | API/MCP parity for profile, rates, sailings, and predictive, plus the error cases | | `test/r1-12-parity.test.js:157` and the steps through deleted rows at `:616`. Rate limit is the GAP noted on the FR11 error bullet; it is not re-counted here because this bullet's other cases are asserted. | PASS |
| Validation | A real MCP client does OAuth, discovery, rates, sailings, and predictive; revoke stops the next call | | Inspector 2.11.0. See the MCP section. Sailings list was an empty success. Get-one sailing was not-found because none exist. After revoke the next call did not succeed. | PASS |
| Validation | `npm run check` and `npm test` on temporary databases | | Run in the verification section of the PR. The suite uses temp databases (`test/helpers/app.js`). | PASS |

### Browser checks requested for this pass

| PRD | Requirement | Decision | Evidence | Status |
| --- | --- | --- | --- | --- |
| Browser | Direct links and refresh for Rates, Profile, and Admin | | Client-side visit of every registry path while Kings was selected, including Profile account/security/preferences/connected apps and Admin users, companies, customers, data, pull-forward, imports, integrations, oauth clients. Full document load of `/admin/data` stayed on Data. Full load of `/profile/connected-apps` showed the grant. Not every section was reloaded with the reload button. | PASS |
| Browser | Back and Forward | | From `/admin/data`, opened Account, `history.back` returned to Data, `history.forward` returned to Account with Account content. | PASS |
| Browser | Keyboard-only menu | | ArrowDown, second ArrowDown, Escape, outside click. See FR1. | PASS |
| Browser | Menu at 375×812 | | Confirmed `innerWidth`/`innerHeight`. Open menu overlapped the search box and received the hit test. | PASS |
| Browser | Menu at 1280×800 | | Confirmed viewport. Menu painted above the search controls and the table. | PASS |
| Browser | Company onboarding wizard | | Harbor Acceptance Co, Contract Owner, admin Harbor Admin, login `harboradmin`. Review showed type, role, and that the password is not emailed. Success told the admin to hand over the temporary password. | PASS |
| Browser | User wizard and the temporary-password gate | | Casey at Kings, role Member. Notice: give them the temporary password; they must change it. No company-name confirm (R114-4). Casey's next page was the change-password gate, and `/api/rates` was 403 `password_change_required`. | PASS |
| Browser | Customer authorization, live preview, and the customer's own view | | Blackwater and Blue Sky were already active at 0% + $0 on this fresh database (foundation creates those links when the type string is correct). Preview prices matched Alan's table, including a null 20' rendered as an em dash and the pull-forward copy at $1,101 / $2,100 / $2,200. | PASS |
| Browser | Saved query and view across a page boundary | | Query `Fixture Line` and view `By carrier` survived a trip to Preferences and back. The fixture is one page (page size 20), so the browser did not cross a page. The continued-header assertion is `test/r1-05-grouping.test.js:58`. | PASS |
| Browser | Data delete, restore, and undo | | Deleted 1 of 5. History showed the delete. Undo confirm: `Undo this delete of 1 rates. This applies to Kings.` Notice `Undid 1 rates at Kings.` History added a restore row. Matching returned to 5. | PASS |
| Browser | Pull-forward wizard | | Source 2026-03-02–2026-03-20, target 2026-12-01–2026-12-19, keep existing, copy 1, replace 0. Success `Copied 1 rates, replaced 0, at Kings.` | PASS |
| Browser | Import `test/fixtures/imports/rates.xlsx` | | The file input could not be set (`DOM.setFileInputFiles` is denied in this browser). The same upload, sheet, validate, and commit routes the screen calls were used after setting company context to Kings. Validate accepted 5, rejected 0. Commit 200, 5 rows. The Data screen then showed Fixture Line rows and an import history entry for `rates.xlsx`. | PASS |

## Success measures

| Measure | Met? | Evidence |
| --- | --- | --- |
| Apply a saved query or view in no more than two actions from Rates | Yes | Applying is one action: change the saved-query select (`public/js/rates/queries.js`, the change listener applies immediately). Saving a new query was two actions: type the name, press Save. The view select works the same way. |
| Complete company or user onboarding in one guided flow without database or CLI intervention | Yes for the wizards | Company wizard and user wizard both finished in the browser and showed the handoff text. The SteveF password on the temp server was set with `scripts/set-password.js` before that server started, because a brand-new foundation user has no hash. That is dev bootstrap, not the onboarding flow. The production-shaped copy cannot be signed into at all after startup (R114-3), so this measure is not met for that database. |
| Preview a customer's prices without logging in as them; saving a margin updates the next preview and the customer | Yes on the fresh server | SteveF previewed Blackwater without being Alan. Alan's later table matched those prices. `test/r1-07-customer-access.test.js:131` is the automated match, including a saved non-zero margin ($1,125). This session's browser preview was the existing zero margin; a margin edit was not repeated in the browser because the automated test already saves and re-reads. |
| Every committed import or data operation reports counts and has a history entry | Yes in the browser session | Import: 5 completed, history row. Delete: 1, history row. Undo: history type restore. Pull-forward: `Copied 1 rates, replaced 0`. |
| No company-admin operation exposes or changes another company's users or source data | Yes in tests | `test/r1-02-roles.test.js:287` and `test/r1-06-users.test.js:89`. Not re-run as a second company admin in the browser. |
| No partial writes survive a failed onboarding, import, pull-forward, delete, or undo | Yes in tests | Onboarding: `test/r1-06-onboarding.test.js:140`. Import: `test/r1-11a-imports.test.js:407`. Delete: `test/r1-08-data-ops.test.js` mid-commit rollback at line 258. Undo: `test/r1-09-pull-forward.test.js` line 244 leaves data unchanged. |
| Every external read in the coverage table has a working MCP equivalent | Yes, with the sailing caveat | Inspector called all six tools. Sailing list was empty because no sailing was imported. Sailing get-one returned not-found. Parity assertions: `test/r1-12-parity.test.js:157` and the predictive block at `:233`. Revoke stopped the next call. |

The two release blockers mean the success measure "onboarding without CLI" and the migration preservation measure are not met for the production-shaped database, even though the fresh-database wizards work.

## Local verification

`npm ci` (11 packages, 0 vulnerabilities), `npm run check`, and `npm test` on Node v26.9.0. Exit 0.

| | |
| --- | ---: |
| tests | 204 |
| pass | 201 |
| fail | 0 |
| todo | 3 |
| suites | 51 |

The 3 todos are R114-1, R114-2, and R114-3 in `test/r1-14-prod-shape.test.js`. They fail their assertions and do not fail the process. No existing test was edited, skipped, or deleted. `SQLITE_DB_PATH` for this run pointed at an unused temp file.

## What this pass did not do

- No product code changes and no edits to existing tests.
- No write to `data/rateninja.db`, the original backups, or production.
- No load test.
- P2 bulk price adjustment and duplicate handling were not exercised.
- PDF import was not exercised (D-018).
