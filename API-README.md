# Rate Ninja API
The browser talks only to the same-origin endpoints below. Airtable's API is an implementation detail of `server.js`; never send an Airtable personal access token to a browser or commit one to this repository.

## Authentication

`POST /api/auth/login` accepts a JSON body with `username` and `password`. A successful response creates an HTTP-only `rate_ninja_session` cookie.

`POST /api/auth/logout` clears that cookie. `GET /api/session` returns the signed-in user's display name and administrator status.

## Data endpoints

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/rates` | Signed-in user | Returns every rate available to the session's RateView, with the server-calculated margin applied. |
| `GET /api/sailings` | Signed-in user | Returns sailings for `carrier`, `originPort`, and `after` query parameters. |
| `GET /api/admin/companies` | Administrator | Returns editable companies in the administrator's RateView, excluding their own company. |
| `PATCH /api/admin/companies/:recordId` | Administrator | Updates `marginPercent` and `marginNumber` for a company in that same scope. |

All endpoints return JSON. Authentication and authorization are enforced by the server, not by browser storage or client-supplied role fields.

## Public demo API (v1)

The read-only demo API is designed for server-to-server calls, Postman, or curl. It returns **base rates** only—never a signed-in customer's margin-adjusted prices—and requires the separate `RATE_NINJA_API_KEY` secret.

Send that key in the `X-API-Key` header. The demo has an in-memory limit of 60 requests per minute per running server instance, so it is suitable for demonstrations rather than a production integration.

| Endpoint | Query parameters | Purpose |
| --- | --- | --- |
| `GET /api/v1` | — | Returns version and endpoint metadata. |
| `GET /api/v1/rates` | `carrier`, `originPort`, `destinationPort`, `page`, `pageSize` | Searches rates. Text filters are case-insensitive; `pageSize` is capped at 100. |
| `GET /api/v1/sailings` | `carrier`, `originPort`, `after` | Returns matching sailings; all three query parameters are required. |

Example:

```bash
curl "http://localhost:3000/api/v1/rates?carrier=MSC&pageSize=25" \
  -H "X-API-Key: your-demo-api-key"
```

The rate response uses `{ "data": [...], "meta": { ... } }`, where `meta` includes the total matching records and pagination details.

For a friendly local demo, open [`/api-testbed.html`](api-testbed.html) while the Rate Ninja server is running. It provides a small 3PL-styled console for these v1 endpoints without saving the API key.

## Airtable setup

The server expects the existing UserInfo, Rate Entry, CompanyReference, and Sailings tables. The UserInfo table currently supplies the user's RateView, CompanyID, and AdminScreen values. Keep the Airtable PAT and public demo API key in `.env` (or your deployment platform's secret store) with the narrowest Airtable scopes possible.
