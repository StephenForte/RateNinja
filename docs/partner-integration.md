# Rate Ninja partner integration

Three ways to read rates. They are not interchangeable.

| Access | Who | Credential | Prices |
| --- | --- | --- | --- |
| Same-origin session | The signed-in user | HTTP-only cookie `rate_ninja_session` | Contract owner: base contract price. Customer: that customer's active margin on the linked owner's base |
| Demo API | Anyone who has the shared demo key | `X-API-Key` | Base contract price for the whole demo database. Not a company's private credential |
| Partner API and MCP | A contract-owner user who approved a registered OAuth client | Bearer access token, audience `rn:partner-api` | That owner's base contract price. Predictive calls are estimates of that base price |

Customer accounts cannot approve the partner API or MCP. The demo key is rejected there: those routes read only a bearer access token.

## Deployment gate

`partnerOauthEnabled()` in `lib/config.js` is the only switch.

| `PARTNER_OAUTH_ENABLED` | Result |
| --- | --- |
| `true` | Partner OAuth, the partner API, and `POST /mcp` run |
| `false` | They are refused |
| Unset | On, unless `NODE_ENV` is `production`, in which case they are off |

When the gate is closed:

- `GET` or `POST /oauth/authorize` returns 403 HTML: "Partner sign-in is turned off until the production security gates are opened."
- `POST /oauth/token` returns 403 `partner_oauth_disabled`.
- Partner routes and `GET /oauth/userinfo` return 403 `partner_oauth_disabled`.
- `POST /mcp` returns 403 with JSON-RPC error code `-32001` and message `partner_oauth_disabled`.

`GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` still return metadata. They do not check the gate.

On 2026-10-13 the operator confirmed that production is running with this gate open. `render.yaml` sets `PARTNER_OAUTH_ENABLED` to `true`, because a blueprint sync overwrites the dashboard. The code still refuses production when the variable is unset or `false`. This guide has no production key, client secret, or password.

## Customer accounts

Company type `Contract Owner` can approve a client. Company type `Freight Forwarder/Customer` cannot. On authorize, a signed-in customer is sent back to the redirect URI with `error=access_denied` and `error_description=only_contract_owner`. Token exchange and refresh also reject a user who is not a contract owner.

`GET /oauth/consents` and `DELETE /oauth/consents/{clientId}` return 403 `Only contract-owner accounts have partner grants.` for anyone else.

An account that still has to change a temporary password gets 403 HTML and no grant. Change the password, then try again.

## Prices

Base contract price is the stored container amount, rounded to a whole dollar, with no customer margin. `rate20D` is number or null (no price on file). `rate40D` is number or null (no price on file). `rate40HC` is number or null (no price on file). A stored 0 stays 0. A missing container price is null, on a stored rate and on a predictive estimate.

```json
{ "rate20D": 1000, "rate40D": null, "rate40HC": null }
```

Partner rate and sailing payloads set `source` to `base_contract`. `currency` and `updatedAt` are `null` because those columns are not stored. `allocationEvidence` is false and `capacityQuantity` is `null`. The list `notice` is: "Rate and sailing records are not evidence of allocatable or transferable capacity."

Customer margin price is the session browsing price for a customer. `customerPrice` applies the active link's margin: a stored `margin_percent` greater than 1 is a whole percent, and a stored value of 1 or less is a fraction (so 1 means 100%). It then adds `margin_number` and rounds to a whole dollar. Only an active link is visible. Partner, MCP, and demo responses do not apply this margin.

Predictive estimate is not a saved price. The shared rule is: the `after` date must be more than 90 UTC days ahead, or the error is `Departing after must be more than 90 days in the future.` The period count is `floor(daysUntil / 30)`. A container price on file becomes `round(base * (1 + periods * 0.05))`. A missing base stays null. The latest rate for that route is used (latest expiration date; the route key is carrier, origin, destination, and arrival). Nothing is written to the database.

Owner-scoped predictive calls (partner and MCP) follow that formula on the token's owner only. Optional `carrier` and `originPort` are case-insensitive exact matches, the same match as partner rates. Output is base contract pricing marked `estimate: true`. `meta` includes `after`, `basis.formula` (`5_percent_per_full_30_day_period`), `basis.fullThirtyDayPeriods`, `basis.selection` (`latest_expiration_per_route`), `owner.companyId`, `owner.companyName`, and the usual list fields. `owner.companyId` is the company row id. No customer margin is applied.

Session `GET /api/rates/predictive` uses the same formula and then, for a customer, the active margin. The JSON flag is `predictive: true`. `rateEffectiveDate` is the requested `after` date and `rateExpirationDate` is `N/A`.

Demo `GET /api/v1/predictive-pricing` uses the same formula on base amounts only. It requires `carrier`, `originPort`, and `after`. Carrier and origin are case-sensitive exact matches. There is no pagination and no owner filter.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs browser session cookies. Required for sign-in |
| `OAUTH_SIGNING_SECRET` | Signs partner access tokens. Falls back to `SESSION_SECRET` |
| `PARTNER_OAUTH_ENABLED` | Gate described above |
| `RATE_NINJA_API_KEY` | Shared demo key for `/api/v1/rates`, `/api/v1/sailings`, and `/api/v1/predictive-pricing`. Not a partner credential |
| `SQLITE_DB_PATH` | SQLite file. Default is `data/rateninja.db` under the app directory |
| `HOST` | Default `0.0.0.0` |
| `PORT` | Default `3000`. Render provides this |
| `PUBLIC_ORIGIN` | Origin used for password-reset links. Default `https://rate-ninja.onrender.com` |
| `RESEND_API_KEY`, `RESEND_FROM` | Password-reset mail. Do not commit either value |

Local redirect URIs may be `http://localhost` or `http://127.0.0.1`, including a port. Every other redirect must be `https`. No user, password, or fragment is allowed.

Passwords are Argon2id. Reset links expire after 30 minutes, work once, and only a hash is stored. The reset response does not say whether the account exists.

## OAuth connection

A system administrator registers the client under Admin, OAuth clients. Confidential clients receive a secret once, at creation or rotation. Public clients have no secret and must not send one. The first seeded display name is Capacity Exchange; administrators can register more clients.

1. The client sends the user to `GET /oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and `code_challenge_method=S256`. `state` is required and at most 512 characters. Scopes are a space-separated subset of the client's allowed scopes.
2. If the user is not signed in, the server redirects to `/login` and then back. A contract owner sees the consent page. A customer is redirected to the client with `access_denied` / `only_contract_owner`.
3. Approve posts the same fields plus `decision=approve` and `csrf_token`. Deny posts `decision=deny`.
4. The redirect carries `code` and `state`. The code lives 60 seconds and works once.
5. `POST /oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and, for a confidential client, `client_secret` in the body. JSON or form body. The verifier is 43 to 128 characters from `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`.
6. The token response is `token_type` `Bearer`, `expires_in` 600, `access_token`, `refresh_token`, and `scope`.

Approving again for the same user and client revokes that client's previous grant. The samples below use a second registered client for the token request so that exchange does not revoke the token used by the later calls.

Refresh with `grant_type=refresh_token`. The refresh token lasts 30 days and rotates on use. Reuse of an old refresh token revokes that token family. The access token's audience is `rn:partner-api`. Revocation is checked on the next API or MCP call.

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Predictive pricing requires `rates:read`. A missing scope is 403 `insufficient_scope` on the partner API. On MCP it is HTTP 200 with `result.isError` true and `error` `insufficient_scope`.

`companyId` in userinfo and in the profile tool is the company row id from the token, not a separate business code. The tool cannot be given another company's id. Ownership comes from the token.

## Endpoints

- `GET` and `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `GET /oauth/userinfo` (scope `profile:read`)
- `GET /oauth/consents` and `DELETE /oauth/consents/{clientId}` (session, contract owner, CSRF on delete)
- `GET /api/partner/v1/me/rates` and `GET /api/partner/v1/me/rates/{rateId}` (`rates:read`)
- `GET /api/partner/v1/me/sailings` and `GET /api/partner/v1/me/sailings/{sailingId}` (`sailings:read`)
- `GET /api/partner/v1/me/predictive-pricing` (`rates:read`)
- `POST /mcp`. `GET /mcp` returns 405 `Method not allowed` and `Allow: POST`. This server does not open an event stream.
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp`
- `GET /api/health`

Partner ids in the path are letters, digits, `_`, and `-`.

Empty authorized rate or sailing lists are HTTP 200 with `data: []`. An unknown id on the partner API is HTTP 404 `not_found`. The same miss on MCP is HTTP 200, `result.isError` true, `error` `not_found`.

`GET /api/health` reports the database, session secret, and signing key, the hash algorithm, and `partnerOauthEnabled`. It does not return secret values.

## Rate limits

Demo data routes: 60 requests per 60-second window for the whole server process. Over the limit: HTTP 429 `Demo API rate limit exceeded. Try again in a minute.` `GET /api/v1` does not check the key and does not count against this limit.

Partner routes and `POST /mcp` share one window per client id plus user: 60 requests per 60 seconds. Partner HTTP 429 body is `rate_limited` / `Partner API rate limit exceeded. Try again in a minute.` MCP HTTP 429 is JSON-RPC code `-32001`, message `rate_limited`.

## Filters and pagination

Partner list routes and the MCP list tools take the same filters. `page` defaults to 1 and the ceiling is 10000. `pageSize` defaults to 50 and the ceiling is 100.

On the partner query string, a missing, blank, zero, negative, or non-integer page or page size falls back to the default. A value above the ceiling is lowered to the ceiling. A bad `effectiveDate` is HTTP 400 `effectiveDate must be YYYY-MM-DD.`

MCP checks the tool arguments before the tool runs. `page` outside 1..10000, `pageSize` outside 1..100, a missing required field, an unknown property, a wrong type, or a non-`YYYY-MM-DD` date is HTTP 200 with `result.isError` true and `error` `invalid_request`. The partner query string still coerces an out-of-range page or page size, which is the partner rate behavior.

| Call | Filters |
| --- | --- |
| Partner rates | Optional `carrier`, `originPort`, `destinationPort`: case-insensitive exact match. Optional `effectiveDate`: the rate's effective date is on or before that day and the expiration is blank or on or after that day |
| Partner sailings | Optional `carrier` and `originPort` (the departure port): case-insensitive exact match. Optional `after`: `departure` is greater than the given value |
| Partner predictive | Required `after` (`YYYY-MM-DD`, more than 90 days ahead). Optional `carrier` and `originPort`: case-insensitive exact match. Missing `after` is HTTP 400 `after query parameter is required.` |
| Demo rates | Optional `carrier`, `originPort`, `destinationPort`: case-insensitive substring. `page` and `pageSize` use the same default and ceiling as partner lists |
| Demo sailings | Required `carrier`, `originPort`, and `after`. Carrier and departure port are case-sensitive exact matches. `departure` is greater than `after`. No pagination. Missing any of the three is HTTP 400 `Carrier, originPort, and after query parameters are required.` |
| Demo predictive | Required `carrier`, `originPort`, and `after`. Carrier and origin are case-sensitive exact matches. Same 400 text if one is missing. No pagination |
| Session `GET /api/rates` | No query filters. Contract owners see their own rows at the base price. Customers see each active linked owner's rows with that margin. Body is `{ "rates": [...] }` |
| Session `GET /api/sailings` | Required `carrier`, `originPort`, and `after`. Case-insensitive exact match on the rows that account can see. The 400 text is `Carrier, origin port, and effective date are required.` The query parameter is still `after` |
| Session `GET /api/rates/predictive` | Required `after`. Same 90-day rule |

Demo rate objects use `notes1`, `rateType`, and no `source` field. Partner rate objects use `notes` and `source`. Session rate objects add `ownerCompanyName`.

## API-to-tool coverage

Equivalent authorized requests return the same data and metadata on the partner route and the MCP tool. Company ownership comes from the access token. The demo API key is not accepted on `/mcp` or any partner route.

| Capability | API | MCP tool | Scope |
| --- | --- | --- | --- |
| Current subject and company | `GET /oauth/userinfo` | `rateninja_get_my_profile` | `profile:read` |
| Rate search and pagination | `GET /api/partner/v1/me/rates` | `rateninja_list_my_rates` | `rates:read` |
| One authorized rate | `GET /api/partner/v1/me/rates/{rateId}` | `rateninja_get_my_rate` | `rates:read` |
| Sailing search and pagination | `GET /api/partner/v1/me/sailings` | `rateninja_list_my_sailings` | `sailings:read` |
| One authorized sailing | `GET /api/partner/v1/me/sailings/{sailingId}` | `rateninja_get_my_sailing` | `sailings:read` |
| Predictive pricing | `GET /api/partner/v1/me/predictive-pricing` | `rateninja_get_my_predictive_pricing` | `rates:read` |

The demo predictive route remains `GET /api/v1/predictive-pricing`. It is not owner-scoped and still requires `carrier`, `originPort`, and `after`. The partner and MCP predictive calls are limited to the token's contract owner.

An MCP `tools/call` is checked against the tool's `inputSchema` before the tool runs. MCP rate, sailing, and predictive reads write the same audit event as the matching partner read, with the same user and client, plus `detail.channel` of `mcp`. Profile follows `/oauth/userinfo` and does not write a data-read audit. Audit details do not include tokens or the query payload.

`tools/list` returns each tool's `name`, `description`, and `inputSchema`. It does not return the scope. A listed tool still requires its scope.

| Tool | Scope | Required | Optional |
| --- | --- | --- | --- |
| `rateninja_get_my_profile` | `profile:read` | none | none |
| `rateninja_list_my_rates` | `rates:read` | none | `carrier`, `originPort`, `destinationPort`, `effectiveDate`, `page`, `pageSize` |
| `rateninja_get_my_rate` | `rates:read` | `rateId` | none |
| `rateninja_list_my_sailings` | `sailings:read` | none | `carrier`, `originPort`, `after`, `page`, `pageSize` |
| `rateninja_get_my_sailing` | `sailings:read` | `sailingId` | none |
| `rateninja_get_my_predictive_pricing` | `rates:read` | `after` | `carrier`, `originPort`, `page`, `pageSize` |

Every tool rejects unknown properties. Dates are `YYYY-MM-DD`. The tools are read-only.

`initialize` echoes a requested `protocolVersion` when this server supports it. Otherwise it answers the latest supported version. The supported set exercised with MCP Inspector 2.10.1 and the tests is `2025-11-25` and `2025-03-26`. `2025-11-25` is the latest of those. Send it as `initialize` `params.protocolVersion`. If the `mcp-protocol-version` header is present and is not one of those two values, `POST /mcp` returns HTTP 400 `Unsupported protocol version` and does not accept the token yet.

`serverInfo.name` is `rateninja` and `serverInfo.version` is `1.0.0`. `capabilities.tools.listChanged` is false.

## Revoke

A contract owner can revoke from Connected apps (`/profile/connected-apps`), which calls `DELETE /oauth/consents/{clientId}` with header `X-CSRF-Token`. The client can also `POST /oauth/revoke` with `client_id`, the token, and, for a confidential client, `client_secret`. A known access token or refresh token revokes that grant and its refresh family. An unknown token still returns HTTP 200 and `{}` when the client authenticates. The next partner or MCP call with the revoked token is 401 `invalid_token`.

## Samples

The host below is a local server on port 3000. Replace the `YOUR_*` placeholders. Do not put a real key, secret, token, or password in this file. `docs-rate-1` and `docs-sail-1` are sample row ids. `after=2027-06-15` must be more than 90 UTC days ahead of the server's current day; the predictive samples assume that.

```example
# partner: discovery authorization-server
curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/.well-known/oauth-authorization-server'
```

```example
# partner: discovery protected-resource
curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/.well-known/oauth-protected-resource'
```

```example
# partner: health
curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/api/health'
```

```example
# partner: demo index
curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/api/v1'
```

```example
# partner: demo rates
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/rates?carrier=MSC&originPort=Shanghai&destinationPort=Los%20Angeles&page=1&pageSize=25'
```

```example
# partner: demo sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01'
```

```example
# partner: demo predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'X-API-Key: YOUR_DEMO_API_KEY' \
  'http://127.0.0.1:3000/api/v1/predictive-pricing?carrier=MSC&originPort=Shanghai&after=2027-06-15'
```

```example
# partner: login
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \
  'http://127.0.0.1:3000/api/auth/login'
```

```example
# partner: session rates
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/rates'
```

```example
# partner: session predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/rates/predictive?after=2027-06-15'
```

```example
# partner: session sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01'
```

```example
# partner: customer session rates
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_CUSTOMER_SESSION_COOKIE' \
  'http://127.0.0.1:3000/api/rates'
```

```example
# partner: authorize anonymous
curl -sS -o /dev/null -w '%{http_code}' \
  'http://127.0.0.1:3000/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&scope=profile%3Aread%20rates%3Aread%20sailings%3Aread&state=example-state&code_challenge=docs-challenge&code_challenge_method=S256'
```

```example
# partner: authorize customer
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_CUSTOMER_SESSION_COOKIE' \
  'http://127.0.0.1:3000/oauth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&scope=profile%3Aread%20rates%3Aread%20sailings%3Aread&state=example-state&code_challenge=docs-challenge&code_challenge_method=S256'
```

```example
# partner: token
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data '{"grant_type":"authorization_code","code":"YOUR_AUTHORIZATION_CODE","redirect_uri":"http://127.0.0.1/callback","client_id":"YOUR_TOKEN_CLIENT_ID","client_secret":"YOUR_TOKEN_CLIENT_SECRET","code_verifier":"YOUR_CODE_VERIFIER"}' \
  'http://127.0.0.1:3000/oauth/token'
```

```example
# partner: userinfo
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/oauth/userinfo'
```

```example
# partner: partner rates
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/rates?carrier=MSC&originPort=Shanghai&destinationPort=Los%20Angeles&effectiveDate=2026-06-01&page=1&pageSize=25'
```

```example
# partner: partner rate
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/rates/docs-rate-1'
```

```example
# partner: partner sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/sailings?carrier=MSC&originPort=Shanghai&after=2026-01-01&page=1&pageSize=25'
```

```example
# partner: partner sailing
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/sailings/docs-sail-1'
```

```example
# partner: partner predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  'http://127.0.0.1:3000/api/partner/v1/me/predictive-pricing?after=2027-06-15&carrier=MSC&originPort=Shanghai&page=1&pageSize=25'
```

```example
# partner: mcp initialize
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"docs-example","version":"0"}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp tools/list
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp profile
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rateninja_get_my_profile","arguments":{}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp list rates
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rateninja_list_my_rates","arguments":{"carrier":"MSC","originPort":"Shanghai","destinationPort":"Los Angeles","effectiveDate":"2026-06-01","page":1,"pageSize":25}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp get rate
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"rateninja_get_my_rate","arguments":{"rateId":"docs-rate-1"}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp list sailings
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"rateninja_list_my_sailings","arguments":{"carrier":"MSC","originPort":"Shanghai","after":"2026-01-01","page":1,"pageSize":25}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp get sailing
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"rateninja_get_my_sailing","arguments":{"sailingId":"docs-sail-1"}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: mcp predictive
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'mcp-protocol-version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"rateninja_get_my_predictive_pricing","arguments":{"after":"2027-06-15","carrier":"MSC","originPort":"Shanghai","page":1,"pageSize":25}}}' \
  'http://127.0.0.1:3000/mcp'
```

```example
# partner: consents
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  'http://127.0.0.1:3000/oauth/consents'
```

```example
# partner: consents customer
curl -sS -o /dev/null -w '%{http_code}' \
  -b 'rate_ninja_session=YOUR_CUSTOMER_SESSION_COOKIE' \
  'http://127.0.0.1:3000/oauth/consents'
```

```example
# partner: refresh
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data '{"grant_type":"refresh_token","refresh_token":"YOUR_REFRESH_TOKEN","client_id":"YOUR_REVOKE_CLIENT_ID","client_secret":"YOUR_REVOKE_CLIENT_SECRET"}' \
  'http://127.0.0.1:3000/oauth/token'
```

```example
# partner: delete consent
curl -sS -o /dev/null -w '%{http_code}' \
  -X DELETE \
  -b 'rate_ninja_session=YOUR_SESSION_COOKIE' \
  -H 'X-CSRF-Token: YOUR_CSRF_TOKEN' \
  'http://127.0.0.1:3000/oauth/consents/YOUR_REVOKE_CLIENT_ID'
```

```example
# partner: revoke
curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  --data '{"client_id":"YOUR_REVOKE_CLIENT_ID","client_secret":"YOUR_REVOKE_CLIENT_SECRET","token":"YOUR_REVOKE_TOKEN"}' \
  'http://127.0.0.1:3000/oauth/revoke'
```
