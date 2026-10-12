# Rate Ninja Round 1 Enhancements PRD

Date: October 12, 2026

Status: Draft for product review

Rate Ninja will make recurring rate searches easier and give each company a clear administration workspace. This release adds personal saved queries and display views, dedicated Profile and Admin pages, company and user onboarding, live customer pricing previews, imports with Claude-assisted mapping, clearer tools for maintaining rates and sailings, and MCP coverage matching the external read API.

## Product decisions

The following decisions are confirmed:

- Customer snapshots are live previews of customer pricing. This release does not introduce route, carrier, or contract restrictions for individual customers.
- Contract-owner and freight-forwarder/customer companies can each have company admins. Both manage their own users; only contract-owner admins manage source data, customer authorizations, and margins.
- Imports support rates and sailings, with rates as the primary workflow. File formats await the final clarification noted below.
- Saved queries and saved views are personal.
- Admins onboard users with temporary passwords.
- MCP must cover the same read capabilities as the external API. Extend the existing MCP endpoint rather than create a second server.
- Data-management improvements include individual editing, flexible selection, pull-forward, deletion, and undo/restore. Bulk price adjustment and duplicate handling are P2 enhancements.

Implementation defaults proposed in this PRD include mandatory password replacement on first login, two grouping levels, three sort rules, and a 30-day restore window. These can be adjusted during product review without changing the confirmed scope.

## Current product and gaps

The active application is the root Node server and HTML/CSS/JavaScript frontend backed by SQLite. The nested `RateNinja/` directory contains an older static application and is not the implementation target.

| Area | Current implementation | Required change |
| --- | --- | --- |
| Rate browsing | Search, four filters, one sort rule, pagination, and predictive mode | Personal query persistence, configurable columns, multiple sorts, and grouping |
| Navigation | Admin and security sections are hidden/shown inside `index.html` | Dedicated addressable Profile and Admin pages; correct the overlapping hamburger menu |
| Passwords | Argon2id hashes, admin password setting, emailed forgotten-password resets, optional 2FA | Signed-in password change, temporary-password lifecycle, and Profile access |
| Roles | `admin_screen` identifies an admin; company type identifies a contract owner | Explicit system-admin and company-admin permissions |
| User management | Admins can list users, update emails/passwords, deactivate accounts, and clear 2FA | Enforce company scope and add onboarding and role management |
| Customer pricing | Owner/customer margin records both link access and set pricing | Explicit authorization state, revoke action, and live preview using the same pricing logic |
| Data operations | Owner-scoped pull-forward with optional target replacement | Searchable workspace, separate tasks, preview, editing, recoverable deletion, and operation history |
| Imports | One-time Airtable migration script | Company-admin upload and mapping workflow for rates and sailings |
| API instructions | Existing HTML docs plus API and partner Markdown docs | Admin entry point and documentation aligned with current access rules |
| MCP | Existing OAuth-protected `/mcp` tools for profile, rate list/detail, and sailing list/detail | Explicit external API parity, including predictive pricing, with consistent company isolation |

Evidence anchors: `server.js` admin handlers; `script.js` navigation, filters, and administration rendering; `lib/db.js` schema; `lib/store.js` user listing and margins; `lib/visibility.js` rate access; `lib/password-reset.js` existing reset flow; `lib/foundation.js` startup seeding. The supplied screenshots establish the menu overlap and the desired grouping, sorting, and hidden-field controls.

The user-list and user-mutation handlers currently require only general admin status. Their cross-company access must be closed before company-admin onboarding ships. Startup seeding also reapplies company assignments and admin flags to named users; normal startup must preserve administratively changed accounts.

## Goals and priorities

P1 is the main release. P2 is a follow-up and does not block P1.

| Priority | Capability | Outcome |
| --- | --- | --- |
| P1 | Roles and company isolation | Company admins operate only within their company |
| P1 | Profile, Admin, and navigation | Account and administrative tasks have predictable destinations |
| P1 | Saved queries and views | Users repeat searches and restore their preferred table layout |
| P1 | Company and user onboarding | Admins create valid accounts through guided steps |
| P1 | Customer access and live preview | Contract owners verify the pricing their customers receive |
| P1 | Imports | Admins confirm mappings and validated data before committing |
| P1 | Data management | Editing, pull-forward, delete, and restore are separate clear workflows |
| P1 | API documentation | Company admins can find applicable integration instructions |
| P1 | MCP and API parity | AI clients can query the same authorized rates, sailings, and predictive pricing as API clients |
| P2 | Bulk price adjustment | Admins preview and apply price changes to selected rates |
| P2 | Duplicate handling | Admins identify and resolve duplicate import or existing records |

## Roles and permissions

| Action | Member | Customer company admin | Contract-owner company admin | System admin |
| --- | --- | --- | --- | --- |
| Browse authorized rates and sailings | Yes | Yes | Yes | In selected company context |
| Manage own Profile, queries, and views | Yes | Yes | Yes | Yes |
| Manage company users and company-admin roles | No | Own company | Own company | Any selected company |
| Create a company and its initial admin | No | No | No | Yes |
| Manage customer access, margins, and live previews | No | No | Own company's customers | In selected owner context |
| Import and maintain source rates and sailings | No | No | Own company | In selected owner context |
| Assign system-admin privilege | No | No | No | Explicit system administration only |

System-admin status must be independent of company type and company-admin status. Provision SteveF as the initial system admin through a controlled migration; do not infer system-admin access from a username on each request. Preserve existing company associations and rate ownership.

All permissions are enforced server-side on reads, writes, previews, and operation history. Personal saved objects are accessible only to their owner, including when a system admin manages that user's account. Company admins cannot edit users from customer companies merely because those companies receive their rates.

Role changes take effect on the next request and invalidate affected sessions or access credentials where necessary. Prevent an admin from deactivating their own account, removing the last active company admin, or removing the last active system admin.

## P1 functional requirements

### FR 1 Dedicated pages and navigation

Provide addressable Rates, Profile, and Admin pages. The implementation may reuse the current frontend rather than introduce a framework, but refresh, direct links, and browser Back/Forward must work. Unauthorized direct access receives a clear access-denied state.

Profile contains account details, password change, optional 2FA, saved queries, and saved views. Admin has role-appropriate sections for users, customer pricing, data management, imports, and API instructions. System admins additionally see company onboarding and a persistent selected-company indicator.

Acceptance criteria:

- The menu displays above search controls and tables at desktop and mobile widths, including the supplied screenshot layout.
- Menu items match the user's permissions; all signed-in users can open Profile.
- Keyboard navigation, Escape to close, outside-click dismissal, visible focus, and expanded/collapsed announcements work.
- Moving between Rates, Profile, and Admin preserves the current search and view within the session.
- A system admin cannot submit a company operation without an explicit company context; the confirmation repeats that company name.

### FR 2 Personal saved queries

A saved query is a named set of search criteria, such as Shanghai to Long Beach. It stores search text and selected carrier, origin, destination, and contract-owner filters. It excludes all dates, predictive departure dates, and pagination position.

Acceptance criteria:

- Users create, apply, rename, update, and delete queries from Rates and manage them from Profile.
- Applying a query replaces the applicable search criteria, starts at page one, and preserves the current display view.
- Applying a query does not restore a historical date or turn predictive mode on. If predictive mode is already active, the current valid date remains in effect.
- Queries persist in SQLite across logout, devices, and redeploys on the persistent disk.
- An unavailable filter value produces an explicit warning and empty/unavailable state; it never silently broadens the query.
- Changing a query never expands the user's authorized data.

### FR 3 Personal saved display views

A saved view controls how results are presented: visible columns, column order, grouping, sorting, and page size. Search criteria belong to saved queries so users can combine any query with any view.

Proposed initial limits: two ordered grouping fields and three ordered sort rules. Grouping applies across the full authorized, filtered result set before pagination. Group headers show matching row counts, support collapse/expand, and repeat context when a group spans pages. Collapsing a group changes presentation without changing the matched-record count.

Acceptance criteria:

- Users create, apply, rename, update, and delete named views from Rates and Profile.
- Users hide/show and reorder displayed data columns, add/remove grouping fields, and set sort precedence and direction.
- Users set one default view. It loads on the next visit; deleting it restores the standard view.
- Grouping and sorting are deterministic, including missing values and tie cases.
- Views work in normal and predictive mode; predictive indicators remain visible regardless of hidden columns.
- Controls summarize the active state, such as hidden fields, grouped fields, and sort rules, following the supplied Airtable reference.
- View field identifiers are validated against a server-side allowlist. Schema changes remove obsolete fields safely and tell the user when a saved view needs attention.
- Settings persist per user and are never shared with other users or companies.

### FR 4 Profile and password lifecycle

Add signed-in password change using the current password and confirmation of the new password. Retain the existing minimum of 12 characters, Argon2id hashing, forgotten-password email flow, and optional 2FA.

Acceptance criteria:

- Every user can change their own password from Profile; invalid current passwords and mismatched confirmations produce inline errors.
- Changing a password invalidates existing sessions, pending login challenges, and obsolete reset links. The user then signs in with the new password.
- Forgotten-password resets remain single-use and expiring, and avoid revealing whether an account exists.
- A temporary password requires replacement before access to rates, admin functions, or partner authorization. The restricted session can only complete password replacement or sign out.
- Admin password replacement follows the same temporary-password flow for the target user.
- Passwords and reset tokens never appear in logs, audit details, or persisted onboarding drafts.
- Optional 2FA enrollment, recovery, and disabling remain available from Profile.

### FR 5 System admin company onboarding

Use a wizard: company details → company type → initial admin → review → create. Types are the existing Contract Owner and Freight Forwarder/Customer values.

Acceptance criteria:

- Collect company name, company type, and the initial admin's display name, email, login name, and temporary password. Default login name to email while preserving existing username-based accounts.
- Validate identifiers and duplicate login names case-insensitively. Warn on a matching company name before creation.
- Show the company type and initial role in the final review.
- Create the company and initial company admin in one transaction. Failure creates neither; repeated submission does not create duplicates.
- New customers have no owner access until explicitly authorized. New contract owners start with no source data.
- Return a success summary and a clear handoff instruction for the temporary credential. Do not email a plaintext password automatically.
- Startup and subsequent migrations preserve company names, membership, and roles created or edited through administration.

### FR 6 Company user onboarding and management

Both company-admin types use a wizard: user details → member/admin role and temporary password → review → create. Membership comes from the authorized company context rather than an arbitrary browser-supplied company identifier.

Acceptance criteria:

- Show company users with display name, login name, email, role, active/inactive status, and 2FA enrollment status. Never expose password hashes or secrets.
- Add a user, edit name/email, change member/company-admin role, reset a temporary password, and deactivate/reactivate a user.
- Clearing 2FA remains an explicit recovery action with confirmation and an audit event.
- Deactivation blocks new logins and invalidates existing sessions, challenges, reset links, and partner grants/tokens as applicable. Reactivation does not revive revoked credentials.
- Cross-company listing and mutation attempts fail, including password and 2FA endpoints.
- System-admin assignment is absent from company-admin forms and rejected if submitted directly.
- The wizard preserves nonsecret inputs after validation errors and reports duplicate accounts without partial creation.

### FR 7 Customer authorization and live pricing preview

Contract-owner admins see customers authorized for their company's rates, with status and the owner's percentage and fixed-dollar margins. Provide explicit authorize and revoke actions rather than treating every margin save as an authorization action.

A live preview runs the same visibility and pricing logic used by the selected customer, limited to the administering owner's rates. It does not impersonate a customer login and cannot reveal rates belonging to other owners.

Acceptance criteria:

- Admins authorize an existing customer, revoke authorization, and edit that owner/customer margin independently.
- Use a dedicated existing-customer lookup with only the identifying information required to authorize access; it does not expose another company's users or unrelated configuration.
- A zero-margin authorized customer is distinct from an unauthorized customer. Preserve current links and margins during migration.
- Preview supports search and route/carrier filters and reports sample rates, base amounts, applied margins, customer prices, and the last refresh time.
- Unsaved margin changes can be previewed and are labeled as proposed. Saving requires an explicit action and refreshes the live preview.
- Example: a $1,000 base rate with 10% plus $25 produces $1,125. Preview and customer browsing use the same whole-dollar rounding.
- Revocation takes effect on the customer's next data request. A saved query or view cannot retain access to revoked data.
- No stored historical snapshot or new customer-specific route restrictions are introduced.

### FR 8 Imports with Claude assisted mapping

Workflow: choose Rates or Sailings → upload and select source sheet where applicable → inspect source → confirm proposed mappings → validate rows → review → commit. Rates is the default dataset, and sample templates are available for both datasets.

File-format scope is pending clarification: CSV and Excel, or CSV, Excel, and PDF. The shared workflow and requirements below apply to every selected format.

Claude proposes source-to-target column mappings. Users must review and confirm them. Parsing, type conversion, validation, and database writes remain deterministic; the model never independently commits data or invents missing prices, dates, or ports.

Acceptance criteria:

- Only contract-owner company admins and system admins in an owner context can import. Ownership is assigned by the server; mappings cannot override company identifiers, roles, or authorization fields.
- The model receives only the selected file's headers and a bounded representative sample needed for mapping. Show that this sample will be sent to Claude before requesting suggestions; manual mapping remains available without that transmission.
- Each suggested mapping includes a brief explanation and uncertainty indicator. Required unmapped fields block progression.
- Dates, decimal formats, blank values, container sizes, and text fields have explicit conversion controls. Ambiguous dates require a user choice.
- Rate validation requires origin, destination, carrier, a valid effective/expiration range, and at least one finite nonnegative container price. Missing prices remain blank rather than becoming invented zero prices.
- Sailing validation requires carrier, departure port, and departure date; arrival, when supplied, cannot precede departure. Document which other fields are optional in the template.
- Rates use USD under the current product model. Non-USD input is rejected or requires the user to correct the source; no exchange-rate conversion occurs.
- Preview reports accepted/rejected row counts and row-level errors. Users can fix mappings or explicitly exclude invalid rows before committing the remaining valid rows.
- Commit writes the approved rows atomically, produces an operation summary, and is safe against repeated submission. P1 imports append rows; merging or replacement is not inferred automatically.
- If Claude is unavailable, times out, or returns invalid suggestions, users can finish with manual mapping.
- File, row, sample, and request limits are configurable and shown before upload. A discovery spike establishes initial limits and parser dependencies using representative files.
- Secrets remain server-side. Temporary uploads and mapping samples have a short, documented retention period; activity history retains metadata and outcomes without raw file contents or model samples.

P1 identifies repeated submission of the same import operation, but does not promise business-level duplicate detection. Before commit, explain that imported rows will be added and may duplicate existing rates or sailings.

### FR 9 Flexible data management

Replace the combined instruction form with a searchable Rates/Sailings workspace and distinct Edit, Pull Forward, Delete, Restore, and History actions. Every action shows its dataset, selected company, affected records, and outcome. Users choose explicit rows or all matching results, with a clear distinction from the current page.

Acceptance criteria:

- Filter by relevant route/carrier/date fields; show matching counts and selection counts before acting.
- Edit an individual rate or sailing with the same validations used for imports. Source ownership cannot be edited.
- Pull-forward guides users through source selection, target start date, conflict choice, preview, and confirmation. Derive the target end date from the selected source range; show it before commit.
- Preserve existing pull-forward date rules: equal source/target durations, target after the source, and target ending within 90 days of today. Shift dates using UTC day arithmetic and preserve sailing time components.
- Default pull-forward to keeping target rows. Replacing target rows requires a distinct explicit choice, affected-row preview, and confirmation. Do not describe it as automatic deduplication.
- Retain the existing optional price increase during pull-forward. Standalone bulk price adjustment is P2.
- Delete previews the exact selection and impact. Deleted source records disappear from customer browsing, predictive selection, and applicable API results.
- Deleted records can be restored for a proposed 30-day window. Restore preserves company ownership and reports conflicts instead of silently overwriting current data.
- Edits and pull-forward operations capture prior state or operation membership so admins can undo an operation during the same proposed window. Import history supports undoing the rows created by an import.
- Undo refuses to overwrite records subsequently changed by another operation and shows the affected conflicts. A rejected undo leaves data unchanged.
- A preview becomes invalid when relevant data changes. Require a fresh preview rather than executing against a stale selection.
- Writes and their operation history are transactional. Empty selections, double submissions, and failures cannot cause partial deletion or repeated copying.
- Show operation type, actor, timestamp, company, affected count, and status in company-scoped history. Refresh Rates after a successful operation.

### FR 10 API and MCP instructions

Add API and MCP Instructions to Admin for both company types. Explain which integrations are available for the company's role and link to the existing testbed where useful.

Acceptance criteria:

- Update the HTML documentation to match owner/customer access and margin behavior; remove obsolete RateView descriptions where they misstate current access.
- Distinguish same-origin session APIs, the shared demo API key, and owner-authorized partner OAuth/MCP. Do not present the demo key as a company's private integration credential.
- Explain that customer accounts cannot authorize the existing owner partner API and that partner functionality remains subject to its existing deployment gate.
- Examples use placeholders and never reveal real API keys, passwords, or client secrets.
- Keep `API-README.md`, `api-docs.html`, and partner documentation consistent with the implemented endpoints and permissions.
- Include the MCP endpoint, OAuth connection steps, supported tools and scopes, sample rate/sailing/predictive queries, and how to revoke access. Clearly distinguish base contract prices from customer-margin prices and predictive estimates.

### FR 11 MCP coverage matching the external API

Extend the existing `/mcp` endpoint in the Rate Ninja service to cover the external read API's product capabilities. Existing tools already provide profile, rate list/detail, and sailing list/detail. Add predictive pricing and make parity an explicit release requirement.

The parity boundary is the external rate-data API, including its public-demo capabilities and owner-authorized partner equivalents. Browser administration, onboarding, password changes, imports, deletion, and other mutations are not exposed as MCP tools in this release. MCP remains owner-authorized through OAuth; matching demo functionality does not grant access to the demo API's broader dataset.

| Capability | API counterpart | MCP tool | Status |
| --- | --- | --- | --- |
| Current subject and company | `/oauth/userinfo` | `rateninja_get_my_profile` | Existing; retain |
| Rate search and pagination | `/api/partner/v1/me/rates`; demo `/api/v1/rates` | `rateninja_list_my_rates` | Existing; verify parity |
| One authorized rate | `/api/partner/v1/me/rates/{rateId}` | `rateninja_get_my_rate` | Existing; verify parity |
| Sailing search and pagination | `/api/partner/v1/me/sailings`; demo `/api/v1/sailings` | `rateninja_list_my_sailings` | Existing; verify parity |
| One authorized sailing | `/api/partner/v1/me/sailings/{sailingId}` | `rateninja_get_my_sailing` | Existing; verify parity |
| Predictive pricing | Demo `/api/v1/predictive-pricing`; new owner-scoped `/api/partner/v1/me/predictive-pricing` | `rateninja_get_my_predictive_pricing` | New partner endpoint and MCP tool |

Acceptance criteria:

- API handlers and MCP tools call shared services for query validation, visibility, pricing, pagination, and output mapping. Protocol wrappers may differ, but equivalent authorized requests return equivalent data and metadata.
- Rate tools support carrier, origin, destination, effective-date filtering, and pagination consistent with the partner API. Sailing tools support carrier, origin, departure-after filtering, and pagination. Document date formats, page defaults, and page-size limits consistently.
- Predictive pricing accepts carrier, origin port, and a departure-after date more than 90 days in the future, with pagination in both the new partner endpoint and MCP tool. Use the existing latest-rate selection and 5% per full 30-day-period formula on the authenticated owner's data only; do not persist predictions.
- Mark predictive outputs as estimates and return the input date, calculation basis, applicable owner, and pagination metadata. Keep base-contract pricing semantics consistent with the partner API; do not apply another customer's margin.
- Require existing OAuth scopes: `profile:read`, `rates:read`, and `sailings:read`, with `rates:read` also covering predictive pricing. Reject the demo API key on MCP and partner routes. Preserve the partner deployment gate.
- Company ownership is derived from verified authorization, never an arbitrary tool argument. Keep customer accounts excluded from owner partner authorization under the existing policy.
- Validate actual tool arguments against their declared schemas, including required fields, unexpected properties, types, date ranges, and pagination bounds. Do not rely on the client to enforce the schemas.
- Return consistent not-found, invalid-input, insufficient-scope, revoked-access, and rate-limit outcomes without revealing another company's records. Empty authorized searches return a successful empty list.
- Deactivation, password replacement, role changes, revoked grants, and deleted records affect MCP and API calls consistently. Temporary-password accounts cannot authorize MCP access.
- Record MCP data access in audit history with the same actor/client/company attribution as equivalent partner API reads; omit tokens and raw sensitive query payloads.
- Tool discovery clearly describes parameters and read-only behavior. Document which tools require each scope, and never grant a capability merely because its tool is discoverable.
- Verify initialization, discovery, and calls against the MCP transport/protocol version selected during implementation, using at least one supported real MCP client. Extend the existing implementation for interoperability rather than claiming compatibility from JSON-RPC responses alone.
- Maintain an API-to-tool coverage table in the integration docs. New external read capabilities require a matching MCP tool and parity tests in the same delivery increment, or an explicit documented product exception.

## P2 functional requirements

### FR 12 Bulk price adjustment

Provide a separate action for selected existing rates, with percentage and/or fixed-dollar adjustments and selected container sizes. Show before/after samples and counts, enforce nonnegative prices, preserve whole-dollar rounding, and apply atomically with history and undo. Customer margins remain independent of source price changes. The preview must state the order when combining percentage and fixed-dollar changes.

### FR 13 Duplicate handling

Define rate and sailing matching keys during a representative-data spike. Candidate rate keys include owner, carrier, route, inland destination, rate type, commodity, and effective/expiration dates. Candidate sailing keys include owner, carrier, departure port/date, vessel, and voyage; incomplete identifiers require review.

Show duplicates within an upload and against existing company data. Users choose keep existing, keep incoming, or keep both; ambiguous matches require review. Never merge across companies or silently discard differences. Existing-record cleanup uses the same preview, history, and restore mechanisms.

## Data and implementation requirements

Extend the current Node/SQLite application. Do not migrate frameworks or replace the production database for this release. New parser dependencies may be added if needed for the confirmed file formats; the old migration PRD's dependency restriction does not define this release.

Suggested additions:

- Separate system-admin privilege, company role, and `must_change_password` state on users. Add case-insensitive uniqueness constraints for login identifiers after reconciling any existing collisions.
- Personal saved-query and saved-view tables with user ownership, named configurations, timestamps, validated field identifiers, and configuration versions.
- Explicit customer authorization status independent of stored margins, preserving all existing owner/customer links as active during migration.
- Import-job and data-operation records with actor, owner company, lifecycle state, counts, submission identifiers, and bounded restore payloads.
- Deleted-record state or an equivalent archive; all normal, predictive, partner, and demo queries must exclude deleted rows consistently.
- Record versions or equivalent change detection to protect previews, edits, and undo from concurrent changes.

Extend existing server-side authorization, CSRF, password, audit, and visibility modules rather than duplicating their rules. In particular, extract/reuse one customer-pricing path for ordinary browsing and live previews. Normalize percentage input explicitly in the UI while preserving existing stored margin interpretation during migration.

Extend `lib/mcp.js` and the existing `/mcp` handler. Reuse partner visibility services and shared predictive calculations for API/MCP parity; preserve the existing OAuth metadata and grant lifecycle. MCP is an additional transport for authorized product reads, not a separate source of pricing or access rules.

Migrations must be additive, idempotent, and safe for the existing persistent SQLite disk. Bootstrap creates only missing foundation data and must not overwrite administrator changes on restart. Back up the database before migration and verify restoration against a copy.

System-admin company context is explicit and validated for each request. Company type alone never authorizes administration. Changing context cannot change another user's personal preferences.

## Delivery sequence

1. **Role and migration foundation:** establish system/company permissions, scope existing admin endpoints, correct startup seeding, and test migration against a database copy.
2. **Navigation and Profile:** dedicated pages, menu fix, password change, and temporary-password restrictions.
3. **Personal productivity:** saved queries, saved views, grouping, sorting, and columns.
4. **Onboarding and customer administration:** company/user wizards, authorization lifecycle, live pricing previews, and API instructions.
5. **Data workspace:** selection, individual edit, pull-forward previews, deletion, restore, and operation history.
6. **Imports:** parser/limits discovery, manual mapping, Claude suggestions, validation, commit, and import undo.
7. **API and MCP parity:** shared predictive service, owner-scoped predictive endpoint and tool, documentation, parity tests, and a real-client interoperability check.
8. **P2:** standalone bulk price adjustments and duplicate resolution.

Each increment must preserve normal/predictive browsing, optional 2FA, existing margins, and the current partner deployment gate. P1 ships only after the integrated acceptance checks pass.

## Validation and release acceptance

- Role tests cover member, both company-admin types, and system admin. Attempts to read or mutate another company's users, records, previews, or history are denied.
- Temporary-password sessions cannot call normal data/admin or OAuth endpoints. Password changes and deactivation revoke the applicable access paths.
- Saved preferences survive relogin and remain private. Queries contain no dates. Grouping and sorting remain correct across page boundaries and predictive mode.
- Live preview matches the customer's ordinary rate response for the same owner and filters, including zero margins and rounding. Preview excludes other owners.
- Representative import fixtures cover rates and sailings, missing prices, ambiguous dates, invalid amounts, partial rejection, Claude failure, repeated submission, and rollback.
- Data-operation tests cover ownership, stale previews, failed commits, restoration, concurrent edits, and undo conflicts. Deleted rows are excluded from every data-serving path.
- Migration tests prove existing users, ownership, margins, password hashes, and partner configuration survive migration and restart.
- Browser checks cover direct links, Back/Forward, keyboard use, mobile navigation, onboarding, and the menu-overlap screenshot regression.
- API/MCP parity tests compare profile, rate list/detail, sailing list/detail, and predictive results for equivalent owner requests, filters, and pagination. Cover malformed tool arguments, missing scopes, other-company IDs, revoked grants, deactivation, deleted rows, invalid predictive dates, and zero-result queries.
- A supported real MCP client completes OAuth, discovers tools, queries rates and sailings, and requests predictive pricing. Verify that revoked authorization stops subsequent calls.
- Run `npm run check` and `npm test` during implementation; expand the existing suite for these behaviors using temporary databases.

## Success measures

These are proposed product targets to validate during acceptance testing:

- Apply a saved query or view in no more than two actions from Rates.
- Complete company or user onboarding in one guided flow without database or CLI intervention.
- Preview a customer's current prices without logging in as that customer; saving a margin updates the next preview and customer request.
- Every committed import or data operation reports affected counts and has a visible history entry.
- No company-admin operation exposes or changes another company's users or source data.
- No partial writes survive a failed onboarding, import, pull-forward, delete, or undo operation.
- Every external read capability in the coverage table has a working MCP equivalent with passing data-parity and authorization checks.

## Exclusions and remaining decision

Shared/company saved views, historical customer snapshots, customer-specific route restrictions, automatic scheduled imports, currency conversion, a new customer partner API, MCP administration/write tools, and a frontend framework rewrite are outside this release.

Remaining product decision: confirm import formats. Parser selection, representative-file limits, and final duplicate matching keys are implementation discovery items; the P2 items do not block P1.
