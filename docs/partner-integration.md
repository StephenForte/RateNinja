# Rate Ninja partner integration

Partner OAuth, the partner API, and MCP run in this Rate Ninja service. The demo key on `/api/v1/*` is not partner access.

Production on Render keeps partner OAuth **off** until the security gates in the partner PRD are accepted. Set `PARTNER_OAUTH_ENABLED=true` only after that review. The app is not live. Attach `rateninja.co` to this same service later; DNS is not required to deploy.

## Configuration

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs browser session cookies |
| `OAUTH_SIGNING_SECRET` | Signs partner access tokens. Falls back to `SESSION_SECRET` when unset |
| `PARTNER_OAUTH_ENABLED` | `true` or `false`. Production Render sets `false`. When unset, OAuth is on only if `NODE_ENV` is not `production` |
| `RATE_NINJA_API_KEY` | Demo API only |
| `SQLITE_DB_PATH` | SQLite file. Render uses `/var/data/rateninja.db` |
| `HOST` | Defaults to `0.0.0.0` |
| `PORT` | Render provides this |

Local callbacks may be `http://localhost` or `http://127.0.0.1`. Every other redirect must be `https`.

## Passwords and sign-in

Passwords are Argon2id hashes. Plaintext values are not migrated and are cleared on startup. An administrator can still set a password in the admin screen.

Bootstrap the first admin before anyone can sign in:

```bash
node scripts/set-password.js SteveF 'a-long-password'
```

The sign-in page is `/login` on this same service. It collects username and password, then an authenticator or recovery code only when that user has enrolled two-factor authentication. Enrollment is optional. SteveF can clear two-factor for a user from the admin screen.

Forgot-password emails are sent with the Resend API. Set `RESEND_API_KEY` and `RESEND_FROM` in the environment. Do not commit either value. If they are missing, the reset request still returns success and does not say whether the account exists. The server logs that mail was not sent, without the reset token or the API key. Reset links expire after 30 minutes, work once, and only a hash of the token is stored. The link origin is `PUBLIC_ORIGIN` (default `https://rate-ninja.onrender.com`). The request `Host` and `X-Forwarded-Host` headers are not used. The account needs an email address, which an administrator saves on the user row. Changing a password invalidates outstanding authenticator login challenges.

## Existing database

Startup opens the SQLite file at `SQLITE_DB_PATH` and adds any missing columns and tables before queries that use them. A database created before `owner_company_id` and the partner tables is updated in place. Rows are not deleted and the file is not replaced. The Render disk at `/var/data/rateninja.db` is that file.

## Tokens

| Item | Lifetime |
| --- | --- |
| Authorization code | 60 seconds, single use |
| Access token | 10 minutes, audience `rn:partner-api` |
| Refresh token | 30 days, rotated on use |

Reuse of an old refresh token revokes that token family. Revocation is checked on the next API or MCP call.

PKCE `S256` is required. Confidential clients send `client_secret` in the token request body. Public clients (Cursor or Claude using a person's own Rate Ninja login) omit the secret.

Only a contract-owner account can approve a client. Customer accounts are denied.

## Endpoints

- `GET /oauth/authorize` and `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `GET /oauth/userinfo`
- `GET /oauth/consents` and `DELETE /oauth/consents/{clientId}`
- `GET /api/partner/v1/me/rates` and `GET /api/partner/v1/me/rates/{rateId}`
- `GET /api/partner/v1/me/sailings` and `GET /api/partner/v1/me/sailings/{sailingId}`
- `POST /mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /api/health`

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Empty rate or sailing lists are HTTP 200. Responses are base/contract data, not customer-margin prices, and they are not capacity allocations. Currency and source updated time are `null` because those columns are not stored.

The first registered client display name is **Capacity Exchange**. Administrators can rename it and register more clients. A confidential secret is shown once at creation or rotation.

## Health

`GET /api/health` reports whether the database, session secret, and OAuth signing key are present, which hash algorithm is in use, and whether partner OAuth is enabled. It does not return secret values. Render's platform health check stays on `/`.

## API-to-tool coverage

Appended by R1-12. A later docs pass rewrites this guide. Equivalent authorized requests return the same data and metadata on the partner route and the MCP tool. Company ownership comes from the access token. The demo API key is not accepted on `/mcp` or any partner route.

| Capability | API | MCP tool | Scope |
| --- | --- | --- | --- |
| Current subject and company | `GET /oauth/userinfo` | `rateninja_get_my_profile` | `profile:read` |
| Rate search and pagination | `GET /api/partner/v1/me/rates` | `rateninja_list_my_rates` | `rates:read` |
| One authorized rate | `GET /api/partner/v1/me/rates/{rateId}` | `rateninja_get_my_rate` | `rates:read` |
| Sailing search and pagination | `GET /api/partner/v1/me/sailings` | `rateninja_list_my_sailings` | `sailings:read` |
| One authorized sailing | `GET /api/partner/v1/me/sailings/{sailingId}` | `rateninja_get_my_sailing` | `sailings:read` |
| Predictive pricing | `GET /api/partner/v1/me/predictive-pricing` | `rateninja_get_my_predictive_pricing` | `rates:read` |

The demo predictive route remains `GET /api/v1/predictive-pricing`. It is not owner-scoped and still requires `carrier`, `originPort`, and `after`. The partner and MCP predictive calls are limited to the token's contract owner.

Owner-scoped predictive parameters follow D-019. `after` is required (`YYYY-MM-DD`, more than 90 days ahead). `carrier` and `originPort` are optional case-insensitive exact matches, the same match as partner rates. `page` defaults to 1 and `pageSize` defaults to 50, with the same ceilings as partner rates (10000 and 100). The output is base contract pricing marked as an estimate. It includes the input date, the basis (latest rate per route, then 5% per full 30-day period), the owner company, and list metadata (`total`, `page`, `pageSize`, `returned`, `notice`). It does not apply a customer margin and it is not stored.

An MCP `tools/call` is checked against the tool's `inputSchema` before the tool runs. A missing required field, an unknown property, a wrong type, a non-`YYYY-MM-DD` date, or a page size above 100 returns a tool error `invalid_request`. The partner query string still coerces an out-of-range page or page size down to the ceiling, which is the existing partner rate behavior.

MCP rate, sailing, and predictive reads write the same audit event as the matching partner read, with the same user and client, plus `detail.channel` of `mcp`. Profile follows `/oauth/userinfo` and does not write a data-read audit. Audit details do not include tokens or the query payload.

`initialize` echoes a requested `protocolVersion` when this server supports it. Otherwise it answers the latest supported version. The supported set exercised with MCP Inspector 2.10.1 and the tests is `2025-11-25` and `2025-03-26`. `2025-11-25` is the latest of those.
