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

- `RATE_NINJA_ADMIN_API_KEY` (required for options 1–9 / reference reads and `post-cloudbbs`)
- `RATE_NINJA_BASE_URL` (optional; default `https://rate-ninja.onrender.com`)
- `CLOUDBBS_TOKEN` (required for option 9 / `post-cloudbbs`)
- `CLOUDBBS_URL` (optional; default `https://cloudbbs.ai`)
- `CLOUDBBS_PROJECT` (optional; default `rn`)
- `RATE_NINJA_BUYER_API_KEY` (required for option 10 / `client-agent`)
- `CLOUDBBS_AGENT_TOKEN` (required for option 10 / `client-agent`; never falls back to `CLOUDBBS_TOKEN`)
- `CLOUDBBS_AGENT_NAME` (optional; default `rateninja-client-agent`)
- `ANTHROPIC_API_KEY` (required for option 10 / `client-agent`)
- `CLIENT_AGENT_MODEL` (optional; default `claude-sonnet-5-5`)

The CLI never reads or sends `RATE_NINJA_API_KEY`. It never prints `RATE_NINJA_ADMIN_API_KEY`, `RATE_NINJA_BUYER_API_KEY`, `CLOUDBBS_TOKEN`, `CLOUDBBS_AGENT_TOKEN`, or `ANTHROPIC_API_KEY`.

### Interactive menu

With no arguments, the CLI prints a numbered menu of the six reads plus `companies`, then `8. quit`, then `9. Post this information to the CloudBBS`, then `10. Run client agent`. Items 1–7 prompt for optional filters, print a table, and return to the menu. Quit stays 8.

### One-shot commands

```bash
node scripts/rateninja-admin.js list
node scripts/rateninja-admin.js origin-ports
node scripts/rateninja-admin.js rate-date-ranges --company <id> --carrier MSC --page 1 --page-size 50
node scripts/rateninja-admin.js companies --json
node scripts/rateninja-admin.js post-cloudbbs --yes
node scripts/rateninja-admin.js client-agent --yes
```

Commands: `rate-date-ranges`, `origin-ports`, `destination-ports`, `contract-owners`, `sailing-date-ranges`, `predictive-date-ranges`, `companies`, `post-cloudbbs`, `client-agent`. Shared flags: `--company`, `--carrier`, `--origin-port`, `--destination-port`, `--page`, `--page-size`, `--json` (only where that command accepts the filter). `post-cloudbbs` requires `--yes`. `client-agent` posts only with `--yes` (without it, steps 1–6 still run).

### Run client agent

Option 10 / `client-agent` signs in as the test buyer (`X-Buyer-API-Key` / `RATE_NINJA_BUYER_API_KEY`), reads the CloudBBS `rn` announcement over MCP with `CLOUDBBS_AGENT_TOKEN` (full body via continuations), picks up to 10 distinct origin/destination lanes from `reads.rateDateRanges`, queries buyer available-rates and sailings per lane, asks Claude for a strict-JSON good/fair/poor verdict per lane, displays a table (plus booking code and urgent/pinned thread titles), then optionally posts a Markdown summary. Weekly thread rule: reply to this agent's newest root whose title starts with `Client agent searches` when that root is under 7 days old; otherwise open `Client agent searches — week of <YYYY-MM-DD>` (UTC). Board prose is never sent to Claude; the posted body is built from structured lane results and validated verdicts only. Failures in steps 1–5 post nothing. The menu confirms with `[y/N]`; the one-shot form needs `--yes` to post.

### Post to CloudBBS

Option 9 / `post-cloudbbs` fetches the six D-030 reference reads (no company filter, every page) and replaces the CloudBBS project announcement (`PUT …/api/v1/projects/{project}/announcement`). The companies list is not included. Title is `RateNinja reference data`; the body is Markdown with schema `rateninja.reference.v1`. After the `Generated …` line the body includes `Today's Booking Code: <code>` (a fresh 9-character `A–Z0–9` code each run); the JSON block carries the same value as top-level `"bookingCode"` next to `generatedAt` (`schema`, `generatedAt`, `bookingCode`, `source`, `reads`). The code is public on https://cloudbbs.ai/supa/rn and is not a secret. Bodies over 262144 UTF-8 bytes are refused without posting. The menu confirms with `[y/N]` before the PUT; the one-shot form requires `--yes`.
