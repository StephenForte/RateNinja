# Managed Agent Swarm foundation

Session API for the premium flag, a company's CloudBBS project, and saved swarm definitions.
There is no swarm tab, run, or call to CloudBBS in this layer. The credential is stored and not tested.

Company identity is `companies.id` on the signed-in user (`actor.company.id`). `users.company_id` is not used.

## Access

`GET /api/swarm/access` is open to any signed-in user. The body is `{ "enabled": true }` or `{ "enabled": false }`.
A user whose company is not a customer, or whose company has no enabled settings row, gets `false`.

These five routes require a signed-in user of a customer company with the flag on.
Otherwise they return 403 `{ "error", "code": "swarm_not_enabled" }`:

- `GET /api/swarms`
- `POST /api/swarms`
- `GET /api/swarms/{id}`
- `PUT /api/swarms/{id}`
- `DELETE /api/swarms/{id}`

The list is company-wide. `canEdit` is true for the creator and for a company admin of that company.
Anyone else in the company can read. `PUT` and `DELETE` by another member return 403.
A swarm that belongs to another company returns the same 404 body as an id that does not exist.

Unsafe methods use the same CSRF check as other session writes (`X-CSRF-Token`).

## Swarm body

`POST` and `PUT` take `{ name, instructions, totalSpendCap, totalSlotsCap, lanes }`.

- `name`: 1 to 100 characters after trim. The stored name is trimmed.
- `instructions`: a string of 0 to 20,000 characters. It is stored and returned unchanged, as JSON text, including HTML.
- `lanes`: 1 to 25 objects. Each lane uses the managed-agent lane rules (visible lane, sailing date on or after today and inside a rate window, container type, booking fields, `acceptMaxSlots`) plus `priority` (`high`, `normal`, or `low`) and `dateFlexDays` (a whole number from 0 to 14). Omitted priority is `normal`. Omitted flex is 0. `savedQueryId` is not accepted.
- When any lane has `allowBookingRequest: true`, `totalSpendCap` (finite and greater than 0) and `totalSlotsCap` (a whole number from 1 to 10,000) are both required. Otherwise each may be null.
- A lane error is 400. The message is the managed-agent message for that row, and the body includes `position`.

`POST` creates the swarm and its lanes in one transaction. `PUT` replaces the swarm fields and all lanes in one transaction. An invalid lane leaves the previous swarm and lanes unchanged. `DELETE` removes the swarm and its lanes.

Responses carry `canEdit`. Audit rows for create, update, and delete store ids only (`swarm_created`, `swarm_updated`, `swarm_deleted`). They do not store instructions.

## System admin settings

Both routes require a signed-in system admin. Anyone else receives 403.

`GET /api/admin/swarm/companies` returns `{ companies: [...] }` for every customer-type company, including companies with no settings row. Each item is `{ companyId, name, enabled, bbsProject, hasBbsToken, updatedAt }`.

`PUT /api/admin/swarm/companies/{companyId}` takes `{ enabled, bbsProject, bbsToken? }`.

- `bbsProject` is null, or 1 to 64 characters of `[a-z0-9._-]` after trim.
- Omit `bbsToken` to keep the stored credential. A non-empty string replaces it. `null` clears it.
- `enabled: true` is saved only when the company is a customer and, after this write, it has a project and a credential that decrypts. Otherwise the response is 422 `swarm_settings_incomplete` and nothing is saved.
- A known company that is not a customer is 422 `customer_only`. An unknown company is 404.

The credential is encrypted at rest with AES-256-GCM (12-byte IV, 16-byte tag). The key is SHA-256 of `swarm-bbs:` plus `SESSION_SECRET`. No route, audit row, log line, or error returns the credential or its ciphertext. `hasBbsToken` is false when the row has no credential or the current secret cannot decrypt it. A later reader (`readBbsCredentials`) returns null in those cases, and also when the company is disabled or the row is missing.

A successful settings write audits `swarm_settings_updated` with `companyId`, `enabled`, `bbsProject`, and `tokenChanged` (true or false).

## Using the tab

Signed-in users get a third tab, Managed Agent Swarm (Premium), at `/swarm`. A direct visit and a refresh both open that tab, and the tab is marked current.

What the page shows comes from the signed-in user's permissions and `GET /api/swarm/access`, not from anything stored in the browser.

- A system admin sees one row per customer company from `GET /api/admin/swarm/companies`. Each row has the company name, an enabled switch, the CloudBBS project, a token field, the last update, and Save. The token field is a password input and is empty on load. It shows "Token set" or "No token" from `hasBbsToken`. Save calls `PUT /api/admin/swarm/companies/{companyId}`. Leaving the token blank sends no `bbsToken`, so the stored credential stays. Clear token sends `bbsToken: null`. A 400 or 422 message is shown next to that row. The token value is not written back onto the page after a save.
- A customer whose company is enabled sees the company's saved swarms and New swarm. The wizard has five steps: instructions (a name, text, or a `.md` or `.txt` file read in the browser), global rules (both caps), lanes (1 to 25, from `GET /api/managed-agents/options`, typed or uploaded from a CSV file), policy (per lane, with Apply to selected), and a read-only review. Save calls `POST /api/swarms` or `PUT /api/swarms/{id}`.
- Everyone else sees "Premium feature. Contact Kings to enable Managed Agent Swarm." and no form.

Names, instructions, and server messages are shown as text. The instructions are not rendered as Markdown or HTML.

On the lanes step, the toolbar shows how many of the 25 lanes are in use. Add lane is available above and below the list. New lanes start with the rate type, origin port and container type from the preceding lane. A single available destination is selected automatically and the sailing date starts at the first valid window.

At 1100 pixels and wider, each lane fits in one row on the lanes and policy steps. The policy toolbar shows how many lanes are selected. Set the Policy to copy, select individual lanes or use Select all, then choose Apply to selected.

On the lanes step, Upload CSV reads a `.csv` file in the browser and Download template builds one from the lanes currently on offer. The file has one header row and then one lane per row. Header names match without regard to case or surrounding spaces, in any order. Required columns are Rate Type, Origin Port, Destination Port, Sailing Date (`YYYY-MM-DD`) and Container Type. Optional columns are Priority (`high`, `normal` or `low`; blank is normal), Allow Alternatives, Date Flex Days (a whole number from 0 to 14; blank is 0), Allow Booking, Min Price, Max Price, Slots and AI Slot Selection. Yes/no cells accept `yes`, `no`, `y`, `n`, `true` or `false` in any case; a blank is no. Prices and slots are plain numbers, without a dollar sign, a thousands separator or an exponent. Quoted fields may contain commas and line breaks, and a leading byte-order mark is ignored. A row whose cells are all blank is skipped.

The file must end in `.csv`, be at most 100,000 bytes, and contain 1 to 25 lane rows. A missing required header, an unknown or repeated header, a file that cannot be read, or a file with no lane rows is refused. One problem anywhere refuses the whole file and leaves the lanes, the step and the inputs as they were. The lanes step lists the first 10 problems with their file row numbers (the header is row 1) and then a count of the rest. When the wizard already has lanes, replacing them asks for confirmation first. A successful upload opens the policy step. Each lane there shows the rate type, origin, destination, sailing date and container type alongside its policy fields on wide screens and above them on narrower screens.

The template is the header row in the column order above, plus one example row for the first lane that has a current rate window. When none does, the template is the header only. Uploading that example without edits loads that lane.

Review shows the swarm name, both caps and the lane count together, with None for a missing cap. Instructions keep their line breaks and wrap across the review panel. The Lanes table shows each lane's route, sailing date, container and policy in entry order. Min and Max display whole US dollars. Min, Max, Slots and AI slots are blank for lanes with booking off. On narrow screens, scroll the table sideways to see its remaining columns.

## Runs

- `POST /api/swarms/{id}/runs` returns 202 with `{ run }`. Any user of an enabled customer
  company can start a run. If a lane can book, the caller must be able to request bookings.
  A second active run in that company returns 409 `run_active`. Editing or deleting a swarm
  during its run also returns 409 `run_active`. Missing service credentials return 409
  `swarm_not_ready` with a list of missing requirements. Disabled access returns 403
  `swarm_not_enabled`.
- `GET /api/swarm-runs` returns `{ runs }` with up to 50 of the company's runs, newest first.
  Each run includes `laneCount`. `GET /api/swarm-runs/{id}` returns `{ run }` with its agents
  in start order and `lanes`: one entry per snapshot lane, in position order. A lane entry
  has exactly `position`, `rateType`, `originPort`, `destinationPort`, `sailingDate`,
  `containerType`, `priority` and `allowBookingRequest`. Price limits, requested slots and
  the customer's instructions stay in the stored snapshot and are not returned. Company runs
  stay in history after deletion of their saved swarm. Cross-company IDs return 404.
- `POST /api/swarm-runs/{id}/cancel` returns 202 with `{ run }` and requests cancellation
  between steps. An ended run returns 409 `not_running`. Both POST routes require the session
  CSRF token.
- Run states are `running`, `completed`, `failed`, `cancelled` and `interrupted`. Rates and
  booking permissions are checked live against the saved run policy. Existing booking
  requests remain pending with Kings after cancellation, error or restart.
- The service posts the snapshot, notes and reports in one thread in the configured private
  CloudBBS project. Large entries use numbered parts. A CloudBBS failure ends the run with
  `failureReason: "cloudbbs"`. SQLite retains the run and any requests made to that point.
- Claude failures use `claude_http_<status>` for a terminal HTTP error with a readable
  response, `claude` for network errors or unreadable responses, and `claude_tool_use`
  for invalid tool call IDs or consecutive replies without a tool call.
- Provisional limits are 40 master turns, 6 turns per sub-agent, 15 minutes per run, five
  concurrent searches and one booking agent at a time.

## Running a swarm

An enabled customer company sees Run on every saved swarm. Run asks for confirmation, naming the swarm and saying the run may request bookings inside its caps, then `POST /api/swarms/{id}/runs`. A 202 opens that run. Step 5 of the wizard has Save and run beside Save. Save and run saves, then starts, with no second confirmation. If the start is refused, the swarm stays in the list and the message is shown. `run_active` also offers the running run. `swarm_not_ready` shows each missing requirement.

The page has two sections, Swarms and then Runs. The swarm table shows instructions on one line, cut with an ellipsis, with the full text on the cell title. Runs lists `GET /api/swarm-runs`: swarm, a status badge, started (local date and time, stored instant on the title), duration, lane count, spend and slots against the caps, and Open. A null cap reads None. Duration is finished minus started, or time so far while the run is still running. Opening a run shows its status, times, duration, summary, failure reason, spend and slots, and master turns. When the run includes `lanes`, Lane results lists every lane in position order above Agent activity. Search, price, booking and the reports use that lane's latest attempt for each role. A run with no `lanes` array shows Agent activity only. Each agent still appears in the order the API returned. Cancel is shown only while that run is running and cancellation is not yet requested. It posts `POST /api/swarm-runs/{id}/cancel` and shows the returned run. Both tables sit in a sideways-scrolling wrapper.

Each run fact keeps its label with its value. Summary and Failure reason each span the full facts panel. Summaries, reports and failure reasons are shown as text. The only link is `/profile/booking-requests`. Customers do not see token counts. While a shown run is running, the page re-reads it every 2 seconds, one request at a time, and stops when it is no longer running, when the user leaves the page, or on 401 or 403.

## Admin view of runs

Open **Admin → Swarm runs** and choose a customer. Contract owner admins can see customers with
active links to their company. Revoking a link hides the customer's run history. System admins
can see every customer with runs and can open the page without selecting a company.

The read-only page shows the latest 50 runs, their recorded customer prices and the token counts
for each run. Times are the viewer's local date and time, with the stored instant on the title.
Open a run to see its summary, lane results and agent reports. The lane entries are the same
eight fields as the customer read: no price limit and no instructions. Views with a running run refresh
every two seconds while visible. The session endpoints are:

- `GET /api/admin/swarm-runs/companies` lists visible customers with run counts and status.
- `GET /api/admin/swarm-runs?companyId=X` lists that customer's recent runs, including `laneCount`.
- `GET /api/admin/swarm-runs/{id}` opens a run with its agents and the same `lanes` fields as the customer read.

Hidden and unknown customer or run IDs return the same 404. Run responses expose the saved swarm
name and caps and omit its instructions and CloudBBS settings.
