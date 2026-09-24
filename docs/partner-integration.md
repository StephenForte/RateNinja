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

## Passwords

Passwords are Argon2id hashes. Plaintext values are not migrated and are cleared on startup. An administrator sets passwords in the admin screen.

Bootstrap the first admin before anyone can sign in:

```bash
node scripts/set-password.js SteveF 'a-long-password'
```

There is no email reset and no second factor in this pass.

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
