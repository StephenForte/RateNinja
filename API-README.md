# Rate Ninja API

The browser talks only to the same-origin endpoints below. Rate and sailing data are read from SQLite on the server. Do not expose the database file, session secret, or demo key to the browser.

There are three ways to read rates. The partner guide, `docs/partner-integration.md`, is the full OAuth and MCP reference. The samples there and the samples below use placeholders. They are not a company's private credentials.

| Access | Credential | What you get |
| --- | --- | --- |
| Same-origin session | HTTP-only cookie `rate_ninja_session` | Contract owners see their own base contract prices. Customers see each active linked owner's rates with that customer's margin |
| Demo API | Shared `X-API-Key` (`RATE_NINJA_API_KEY`) | Base contract prices for the demo database. This key is not a partner token and not a company's private key |
| Partner API and MCP | OAuth bearer token | The approving contract owner's base contract prices. Predictive results are estimates of that base price |

A customer account cannot authorize the partner API or MCP. Partner OAuth, the partner routes, and `POST /mcp` run only when `PARTNER_OAUTH_ENABLED` allows them: `true` is on, `false` is off, and unset is on unless `NODE_ENV` is `production`. On 2026-10-13 the operator confirmed that production is running with the gate open.

`rate20D` is number or null (no price on file). `rate40D` is number or null (no price on file). `rate40HC` is number or null (no price on file). Each present price is a whole dollar. A stored 0 stays 0. A missing base stays null on a predictive estimate.

```json
{ "rate20D": 1000, "rate40D": null, "rate40HC": null }
```

## Authentication

`POST /api/auth/login` accepts JSON `username` and `password`. Success sets `rate_ninja_session` and returns `csrfToken` plus the public user (`username`, `companyName`, `companyType`, `permissions`, `companyContext`). Send `X-CSRF-Token` on later state-changing requests.

`POST /api/auth/logout` clears the cookie. `GET /api/session` returns the same public user and a fresh `csrfToken`.

Passwords are Argon2id hashes. Accounts without a hash cannot sign in until an administrator sets one.

Company type `Contract Owner` is a contract owner. Company type `Freight Forwarder/Customer` is a customer. Prices are not chosen by a client-supplied role.

## Session data

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/rates` | Signed-in user | Owners: own base rates. Customers: active linked owners, with that margin. Body `{ "rates": [...] }`. |
| `GET /api/rates/predictive?after=` | Signed-in user | Latest rate per route, then 5% per full 30-day period. `after` is `YYYY-MM-DD` and must be more than 90 UTC days ahead. Customers then get their margin. Rows are marked `predictive: true` and are not stored. |
| `GET /api/sailings?carrier=&originPort=&after=` | Signed-in user | All three query parameters are required. Match is case-insensitive exact, on the rows that account can see. The 400 text says "effective date"; the parameter name is `after`. |
| `GET /api/admin/customers` | Contract-owner administrator | Current customer list for this owner. |
| `PATCH /api/admin/customers/{id}/margins` | Contract-owner administrator | Sets this owner's margin for that customer. Requires `X-CSRF-Token`. |
| `GET /api/admin/companies` | Contract-owner administrator | Older list of customer companies and margin fields. Not a view filter. |
| `PATCH /api/admin/companies/{recordId}` | Contract-owner administrator | Older margin update for a customer already linked to this owner. Requires `X-CSRF-Token`. |
| `POST /api/admin/pull-forward/rates` | Contract-owner administrator | Copies a source date range of this owner's rates into a later target range. |
| `POST /api/admin/pull-forward/sailings` | Contract-owner administrator | Same pull-forward behavior for sailings. |

A system administrator uses these company routes only after selecting a contract-owner company. The server checks the session. It does not trust a role field in the body.

## Public demo API (v1)

`GET /api/v1` returns the name, version, and the three data paths. It does not check the demo key.

The three data routes require `X-API-Key`. A missing `RATE_NINJA_API_KEY` on the server is HTTP 500. A wrong key is HTTP 401 `A valid X-API-Key header is required.` The limit is 60 requests per 60-second window for the whole process. Over the limit: HTTP 429.

| Endpoint | Query parameters | Purpose |
| --- | --- | --- |
| `GET /api/v1/rates` | Optional `carrier`, `originPort`, `destinationPort`, `page`, `pageSize` | Case-insensitive substring filters. `page` defaults to 1 (ceiling 10000). `pageSize` defaults to 50 (ceiling 100). Base prices only. |
| `GET /api/v1/sailings` | Required `carrier`, `originPort`, `after` | Case-sensitive exact carrier and departure port. `departure` is greater than `after`. No pagination. |
| `GET /api/v1/predictive-pricing` | Required `carrier`, `originPort`, `after` | Case-sensitive exact carrier and origin. More than 90 days ahead. Latest rate per route, then 5% per full 30-day period, base price only. No pagination. Not stored. |

Missing `carrier`, `originPort`, or `after` on demo sailings or demo predictive pricing is HTTP 400 `Carrier, originPort, and after query parameters are required.`

For a local demo, open `/api-testbed.html` while the server is running. The testbed calls these v1 routes. It does not store a company credential.

## Partner API and MCP

Contract owners authorize a registered OAuth client with PKCE S256. `POST /mcp` and `/api/partner/v1/me/*` then return that owner's base rates, sailings, and predictive estimates. Customer accounts cannot authorize a partner. The demo key is not accepted on these routes.

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Predictive pricing uses `rates:read`. Revoke from Connected apps (`DELETE /oauth/consents/{clientId}`) or `POST /oauth/revoke`.

Partner list defaults match the demo rate list: page 1, page size 50, ceilings 10000 and 100. Partner text filters are case-insensitive exact matches, not substrings. See `docs/partner-integration.md` for every tool, the coverage table, and the OAuth steps.

| Capability | API | MCP tool | Scope |
| --- | --- | --- | --- |
| Current subject and company | `GET /oauth/userinfo` | `rateninja_get_my_profile` | `profile:read` |
| Rate search and pagination | `GET /api/partner/v1/me/rates` | `rateninja_list_my_rates` | `rates:read` |
| One authorized rate | `GET /api/partner/v1/me/rates/{rateId}` | `rateninja_get_my_rate` | `rates:read` |
| Sailing search and pagination | `GET /api/partner/v1/me/sailings` | `rateninja_list_my_sailings` | `sailings:read` |
| One authorized sailing | `GET /api/partner/v1/me/sailings/{sailingId}` | `rateninja_get_my_sailing` | `sailings:read` |
| Predictive pricing | `GET /api/partner/v1/me/predictive-pricing` | `rateninja_get_my_predictive_pricing` | `rates:read` |

Supported MCP protocol versions are `2025-11-25` and `2025-03-26`. `2025-11-25` is the default.

## Samples

Same placeholders as the partner guide. `after=2027-06-15` must be more than 90 UTC days ahead of the day you run it.

```example
# readme: demo rates
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/rates?carrier=MSC&originPort=Shanghai&destinationPort=Los%20Angeles&page=1&pageSize=25'
```

```example
# readme: demo sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01'
```

```example
# readme: demo predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/predictive-pricing?carrier=MSC&originPort=Shanghai&after=2027-06-15'
```

```example
# readme: session rates
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/rates'
```

```example
# readme: session predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/rates/predictive?after=2027-06-15'
```

```example
# readme: session sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01'
```

```example
# readme: partner rates
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/rates?carrier=MSC&originPort=Shanghai&destinationPort=Los%20Angeles&effectiveDate=2026-06-01&page=1&pageSize=25'
```

```example
# readme: partner rate
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/rates/docs-rate-1'
```

```example
# readme: partner sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01&page=1&pageSize=25'
```

```example
# readme: partner sailing
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/sailings/docs-sail-1'
```

```example
# readme: partner predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/predictive-pricing?after=2027-06-15&carrier=MSC&originPort=Shanghai&page=1&pageSize=25'
```

```example
# readme: mcp predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"rateninja_get_my_predictive_pricing","arguments":{"after":"2027-06-15","carrier":"MSC","originPort":"Shanghai","page":1,"pageSize":25}}}' \
  'http://127.0.0.1:3000/mcp'
```

## Data store

SQLite tables are created on server start if missing. A user belongs to one company. Margins are stored per contract-owner and customer company. Default path is `data/rateninja.db`, overridable with `SQLITE_DB_PATH`.
