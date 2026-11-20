# Admin CLI and admin reference API

System admins can read the six D-030 reference lookups (and a companies list) across every Contract Owner without a browser session or a short-lived partner OAuth token. Access is a dedicated admin API key, not the public demo key and not a partner bearer token.

## Admin API key

| Item | Value |
| --- | --- |
| Environment variable | `RATE_NINJA_ADMIN_API_KEY` |
| Request header | `X-Admin-API-Key` |
| Lifetime | Non-expiring; rotate by changing the env value |

Generate a key (32+ characters):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set it:

1. **Local:** put `RATE_NINJA_ADMIN_API_KEY=…` in `.env` (never commit the real value).
2. **Render:** set `RATE_NINJA_ADMIN_API_KEY` in the service dashboard (`render.yaml` declares the key with `sync: false`).

Until a qualifying key is configured, every admin reference route answers `503` with `{"error":"admin_api_disabled"}` and returns no data. The key must be at least 32 characters and must not equal `RATE_NINJA_API_KEY`.

This key is admin-only. Do not share it with partners. It does not grant access to the demo API, partner API, browser session routes, or `/mcp`.

## Routes

Base path: `/api/admin/v1/reference/`

| Path | Notes |
| --- | --- |
| `rate-date-ranges` | Same shape as the partner route |
| `origin-ports` | Distinct `{ value, code, name }` |
| `destination-ports` | Distinct `{ value, code, name }` |
| `contract-owners` | Distinct on `(value, ownerCompanyName)` |
| `sailing-date-ranges` | Owner companies only |
| `predictive-date-ranges` | Owner companies only |
| `companies` | `{ id, name, companyType }` for every company |

Optional query `company=<company row id>` scopes a read to that company's partner view (owner or customer). Without `company`, owner views from every Contract Owner are combined. Unknown ids return `404`; customer companies on sailing/predictive ranges return `403 owner_only`.

## CLI

```bash
npm run admin-cli
# or
node scripts/rateninja-admin.js
```

Config (from the environment or a `.env` in the current directory):

- `RATE_NINJA_ADMIN_API_KEY` (required for options 1–9, 11 and 12)
- `RATE_NINJA_BASE_URL` (optional; default `https://rate-ninja.onrender.com`)
- `CLOUDBBS_TOKEN` (required for option 9 / `post-cloudbbs`)
- `CLOUDBBS_URL` (optional; default `https://cloudbbs.ai`)
- `CLOUDBBS_PROJECT` (optional; default `rn`)
- `RATE_NINJA_BUYER_API_KEY` (required for option 10 / `client-agent`)
- `CLOUDBBS_AGENT_TOKEN` (required for options 10 and 12, and for option 11 when any queued agent allows alternatives; never falls back to `CLOUDBBS_TOKEN`)
- `CLOUDBBS_SERVER_TOKEN` (Render service only, required for agent booking creation). Issue a dedicated CloudBBS agent token without the announcement flag. The server uses `CLOUDBBS_URL` and `CLOUDBBS_PROJECT` with the defaults above. Configure the token before deploying the booking gate.
- `CLOUDBBS_AGENT_NAME` (optional; default `rateninja-client-agent`)
- `ANTHROPIC_API_KEY` (required for options 10 and 12)
- `CLIENT_AGENT_MODEL` (optional; default `claude-sonnet-5-5`)

The CLI never reads or sends `RATE_NINJA_API_KEY`. It never prints `RATE_NINJA_ADMIN_API_KEY`, `RATE_NINJA_BUYER_API_KEY`, `CLOUDBBS_TOKEN`, `CLOUDBBS_AGENT_TOKEN`, or `ANTHROPIC_API_KEY`.

### Interactive menu

With no arguments, the CLI prints a numbered menu of the six reads plus `companies`, then `8. quit`, then `9. Post this information to the CloudBBS`, then `10. Run client agent`, `11. Preview managed agent prompts`, `12. Run managed agents`, and `13. Queue sample managed agents`. Items 1–7 prompt for optional filters, print a table, and return to the menu. Quit stays 8.

### One-shot commands

```bash
node scripts/rateninja-admin.js list
node scripts/rateninja-admin.js origin-ports
node scripts/rateninja-admin.js rate-date-ranges --company <id> --carrier MSC --page 1 --page-size 50
node scripts/rateninja-admin.js companies --json
node scripts/rateninja-admin.js post-cloudbbs --yes
node scripts/rateninja-admin.js client-agent --yes
node scripts/rateninja-admin.js managed-agent-prompts --json
node scripts/rateninja-admin.js managed-agents-run --yes
node scripts/rateninja-admin.js managed-agents-samples --yes --user <user-id>
```

Commands: `rate-date-ranges`, `origin-ports`, `destination-ports`, `contract-owners`, `sailing-date-ranges`, `predictive-date-ranges`, `companies`, `post-cloudbbs`, `client-agent`, `managed-agent-prompts`, `managed-agents-run`, `managed-agents-samples`. Shared flags: `--company`, `--carrier`, `--origin-port`, `--destination-port`, `--page`, `--page-size`, `--json` (only where that command accepts the filter). `post-cloudbbs` requires `--yes`. `client-agent` posts only with `--yes` (without it, steps 1–6 still run). `managed-agents-samples` writes only with `--yes` or a menu `y`.

### Run client agent

Option 10 / `client-agent` signs in as the buyer (`X-Buyer-API-Key` / `RATE_NINJA_BUYER_API_KEY`), reads the CloudBBS `rn` announcement in full over MCP with `CLOUDBBS_AGENT_TOKEN`, picks up to 25 distinct origin/destination lanes from `reads.rateDateRanges` (all if fewer), queries buyer rates and sailings, and asks Claude for a good/fair/poor verdict per lane.

It also reads full `Client agent searches` note threads and their replies. Poor lanes from this run come first, followed by known lanes marked poor in notes from the last 7 days, newest first, deduplicated and capped at 10. Note-derived lanes already answered with an `Alternative check:` reply are skipped. Claude picks up to three nearby destinations per lane from that origin's known destinations; note prose and prices never reach Claude. Invalid choices are dropped; an unparsable alternatives reply skips the pass with a message.

Alternatives and note-derived poor lanes are queried with the current buyer's key. A better alternative has at least one rate and a lower lowest price on 40D, falling back to 20D and then 40HC when a type is missing on either side. Equal prices or no comparable type do not qualify. The client sends at most 60 partner requests in any 60-second span and retries a 429 once after waiting a full window; a second 429 fails the step.

The display includes lane results, alternatives (source, prices, next sailing from origin, better yes/no), booking code and urgent/pinned titles. The own summary includes an `Alternatives` section with an `Alternative check:` line for each of this run's poor lanes in the planned alternatives pass. Own poor lanes beyond the ten-lane cap or in a skipped pass get `Not checked: <origin> → <destination>` without an answered marker. Better note-derived alternatives get one reply per source thread; nothing better produces no reply there. The menu's `[y/N]` confirmation and one-shot `--yes` gate cover all writes. Each write has a distinct `client-agent-<runAt>-<n>` idempotency key.

Weekly thread rule: reply to this agent's newest root whose title starts with `Client agent searches` when under 7 days old; otherwise open `Client agent searches — week of <YYYY-MM-DD>` (UTC). Failures before posting write nothing. Board prose is never sent to Claude or copied into posts.

### Preview managed agent prompts

Option 11 / `managed-agent-prompts [--json]` prints one prompt per queued agent in queue order. Each prompt contains the agent's company, creator, search, settings, customer-priced matches and up to five sailings. When alternatives are enabled, it reads the CloudBBS announcement and includes other known destinations for the origin. When booking is enabled, it shows a POST example for the lowest-priced bookable match inside the range, using the earliest expiration to break ties. Add the current `bookingCode` to the preview request body before sending it. The example uses `<RATE_NINJA_ADMIN_API_KEY>` and the booking uses the saved container type and slot count.

The preview sends only GET requests to RateNinja. CloudBBS reads use MCP over HTTP POST. The preview leaves agent and booking data unchanged and records an audit event for each successful admin GET. It prints prompts for inspection and makes no AI calls. With `--json`, output is an array of prompt strings.

All routes below require `X-Admin-API-Key`. The base path is `/api/admin/v1/managed-agents`.

| Method and suffix | Result |
| --- | --- |
| `GET ?status=queued` | `{ agents }` across all companies, oldest first. Also accepts `running`, `completed`, `failed` and `cancelled`. |
| `GET /{id}/matches` | `{ destinationPort, matches, sailings }` using the agent company's view. `?destinationPort=…` is available when the agent allows alternatives. |
| `POST /{id}/booking-requests` | `201 { booking }` from a JSON body containing `rateId` and `bookingCode` from the current CloudBBS announcement. A queued or running agent with booking enabled can create one request as its active creator, within its saved price range. Code errors are `403 invalid_booking_code` and `503 booking_code_unavailable`. |
| `POST /{id}/start` | `200 { agent }` moves a queued agent to running and sets its start time. An absent agent returns `404`. Any other status returns `409 not_queued`. |
| `POST /{id}/finish` | `200 { agent }` from `{ status, resultSummary }`. The status is `completed` or `failed` and the plain-text summary must contain 1–1000 characters after trimming. An agent that is no longer running returns `409 not_running`. |
| `GET /customers` | `{ customers }` — active users in Freight Forwarder/Customer companies. Each row is `id`, `username`, `displayName`, `companyId`, `companyName`. Contract-owner users and disabled users are omitted. The response has no password hash, email, or token. |
| `GET /samples?userId=` | Preview of the three sample agents for that user (`seed` plus lane, date, container, booking, and price ceiling). Optional `seed` repeats a previous draw. Nothing is written. |
| `POST /samples` | `201` from `{ userId, seed }`. Builds that user's three agents again from `seed` and creates them through the same path as `/agents`. `422` when the user is disabled, the company cannot request bookings, or no lane has a matching customer price. `404` when the user does not exist. A failure creates none of the three. |

### Queue sample managed agents

Option 13 / `managed-agents-samples` queues three agents for each chosen customer user: a lowball with booking on (ceiling is half the lowest matching customer price, rounded down, alternatives off), a regular agent with booking on (ceiling is 125% of the highest matching customer price, rounded up), and one with booking off. Lane, container, sailing date, and slots (1–3) come from that user's own search options. Ceilings use the customer prices the runner matches, not the contract base price.

The menu lists active customer users and pre-selects a user when the display name or username, lower-cased with spaces removed, is alan, bob, or testbuyer, or when the first word of the display name is one of those. Comma-separated numbers toggle rows. An empty line accepts the list. The CLI prints the preview and asks `[y/N]` before it POSTs. One-shot mode skips the picker. Repeat `--user <id>` to choose users. `--yes` is required to write; without it the command prints the preview and makes no POST. `--json` prints the preview or the created ids as JSON. A user who cannot be queued is reported on their own line and the other users still proceed. The admin key is not printed.

### Run managed agents

Option 12 / `managed-agents-run [--yes]` lists the queue and agents already running. It asks once for `y` before starting the queue. Pass `--yes` to skip the prompt. The runner leaves agents it found already running for the operator to review.

Claude reviews customer-priced matches and sailings. When permitted, Claude picks up to three alternative destinations from the `rn` announcement. A booking request uses the creator and saved slot count. The CLI reads the booking code once per run and includes it only in booking requests for fetched rates marked bookable and in the agent's price range. If the CLI cannot read the code, booking agents finish as completed with `booking code unavailable` in the summary and make no booking call. The runner finishes agents individually and prints their outcomes and booking IDs. Customers can see their results and open booking requests from `/agents`.

The CLI paces admin API calls and waits one quota window before retrying a 429 once. After a confirmed run with queued work, it posts a single count and error summary to CloudBBS project `rn`. The note excludes customer details. An unconfirmed finish appears in the CLI output for operator review. A failed run or run-note post returns a nonzero exit code.

System admins can start this same run from `/agents`. The **Run queued agents** button asks for confirmation (queued count and the next 00:17 UTC CloudBBS post), then starts the runner in the web process and shows the latest run on the page. The web service needs `ANTHROPIC_API_KEY` and `CLOUDBBS_AGENT_TOKEN` in the dashboard (`sync: false`), next to `RATE_NINJA_ADMIN_API_KEY`. The button stays off when either secret is missing, nothing is queued, a run is already in progress, or the clock is between 00:15 and 00:19 UTC.

### Post to CloudBBS

Option 9 / `post-cloudbbs` fetches the six D-030 reference reads (no company filter, every page) and replaces the CloudBBS project announcement (`PUT …/api/v1/projects/{project}/announcement`). The companies list is not included. Title is `RateNinja reference data`; the body is Markdown with schema `rateninja.reference.v1`. After the `Generated …` line the body includes `Today's Booking Code: <code>` (a fresh 9-character `A–Z0–9` code each run); the JSON block carries the same value as top-level `"bookingCode"` next to `generatedAt` (`schema`, `generatedAt`, `bookingCode`, `source`, `reads`). The code is public on https://cloudbbs.ai/supa/rn and is not a secret. Bodies over 262144 UTF-8 bytes are refused without posting. The menu confirms with `[y/N]` before the PUT; the one-shot form requires `--yes`. A failed read, a body over the cap, or a CloudBBS error exits non-zero and leaves the previous announcement in place.

### Daily post on Render

Render cron service `rate-ninja-cloudbbs-post` runs `node scripts/rateninja-admin.js post-cloudbbs --yes` every day at 00:17 UTC (`17 0 * * *`). The service needs `RATE_NINJA_ADMIN_API_KEY` and `CLOUDBBS_TOKEN`, both set in the dashboard (`sync: false`; the Blueprint stores no values). Use Trigger run for an on-demand post. Each successful post rotates the booking code, including a manual option 9 or a Trigger run. Option 12 reads that code once per run, so do not let an option 12 run span 00:17 UTC.
