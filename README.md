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

The app uses only Node's built-in modules, so `npm install` is not required.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | Signs HTTP-only session cookies |
| `RATE_NINJA_API_KEY` | For `/api/v1/*` | Public demo API key (`X-API-Key`) |
| `SQLITE_DB_PATH` | No | Defaults to `data/rateninja.db` |

Airtable env vars are only needed for the one-time `npm run migrate` importer.

## Features

- Signed-in rate browsing with company margin math and RateView isolation
- Predictive rates mode (signed-in) and public predictive-pricing stub
- Admin margin editing and pull-forward tools for rates/sailings
- Read-only public demo API at `/api/v1/*`

## Security note

User passwords in SQLite are still stored as plain text. Moving authentication to a provider that stores password hashes is the recommended next step.

## Checks

```bash
npm run check
```

## Render deployment

The included `render.yaml` creates a Render web service with a persistent disk at `/var/data` and `SQLITE_DB_PATH=/var/data/rateninja.db`. Supply `RATE_NINJA_API_KEY` when prompted; Render generates `SESSION_SECRET`. Copy or migrate the SQLite file onto the disk after the first deploy so the service has data.
