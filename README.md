# Rate Ninja

Rate Ninja is a small web application for browsing ocean freight rates, sailing schedules, and company-specific margins. Data lives in a local SQLite database; the Node server never exposes database credentials to the browser.

## Run locally

1. Use Node.js 22 or later.
2. Copy `.env.example` to `.env` and set `SESSION_SECRET` (and `RATE_NINJA_API_KEY` if you want the public demo API).
3. Ensure a SQLite database exists at `data/rateninja.db` (or set `SQLITE_DB_PATH`). To import from Airtable once, set the Airtable variables in `.env` and run `npm run migrate`.
4. Start the app:

   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000).

Install dependencies once (`npm install`). Password hashing uses `@node-rs/argon2`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | Signs HTTP-only session cookies |
| `OAUTH_SIGNING_SECRET` | No | Signs partner access tokens. Falls back to `SESSION_SECRET` |
| `PARTNER_OAUTH_ENABLED` | No | `false` on Render until security gates are opened. See `docs/partner-integration.md` |
| `RATE_NINJA_API_KEY` | For `/api/v1/*` | Public demo API key (`X-API-Key`). Does not grant partner access |
| `SQLITE_DB_PATH` | No | Defaults to `data/rateninja.db` |
| `RESEND_API_KEY` | For password reset mail | Resend API key. Never commit it |
| `RESEND_FROM` | For password reset mail | From address Resend is allowed to send as |

Airtable env vars are only needed for the one-time `npm run migrate` importer.

## Features

- Signed-in rate browsing with company margin math and RateView isolation
- Predictive rates mode (signed-in) and public predictive-pricing stub
- Admin margin editing and pull-forward tools for rates/sailings
- Read-only public demo API at `/api/v1/*`

## Security note

Passwords are stored as Argon2id hashes. Existing plaintext passwords are not migrated. An administrator (SteveF) can still set a password from the admin screen or with `node scripts/set-password.js SteveF 'a-long-password'`. Sign-in is at `/login`. Forgot-password sends a single-use link through Resend when `RESEND_API_KEY` and `RESEND_FROM` are set. Two-factor authentication is optional and is requested only after a user enrolls.

On startup the server adds missing SQLite columns and tables to the existing database file. It does not delete or replace that file.

Partner OAuth, the partner API, and MCP are documented in `docs/partner-integration.md`. Leave `PARTNER_OAUTH_ENABLED` false in production until that document's gates are accepted. The host stays this Render service. `rateninja.co` can be attached later.

## Checks

```bash
npm run check
npm test
```

Tests use Node's built-in test runner (`node:test`) with no extra dependencies. Store tests run against a temporary SQLite file, not `data/rateninja.db`.

## Render deployment

The included `render.yaml` creates a Render web service with a persistent disk at `/var/data` and `SQLITE_DB_PATH=/var/data/rateninja.db`. Supply `RATE_NINJA_API_KEY` when prompted; Render generates `SESSION_SECRET`. Copy or migrate the SQLite file onto the disk after the first deploy so the service has data.
