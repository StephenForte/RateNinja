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

- `RATE_NINJA_ADMIN_API_KEY` (required)
- `RATE_NINJA_BASE_URL` (optional; default `https://rate-ninja.onrender.com`)

The CLI never reads or sends `RATE_NINJA_API_KEY`.

### Interactive menu

With no arguments, the CLI prints a numbered menu of the six reads plus `companies` and quit, prompts for optional filters, prints a table, and returns to the menu.

### One-shot commands

```bash
node scripts/rateninja-admin.js list
node scripts/rateninja-admin.js origin-ports
node scripts/rateninja-admin.js rate-date-ranges --company <id> --carrier MSC --page 1 --page-size 50
node scripts/rateninja-admin.js companies --json
```

Commands: `rate-date-ranges`, `origin-ports`, `destination-ports`, `contract-owners`, `sailing-date-ranges`, `predictive-date-ranges`, `companies`. Shared flags: `--company`, `--carrier`, `--origin-port`, `--destination-port`, `--page`, `--page-size`, `--json` (only where that command accepts the filter).
