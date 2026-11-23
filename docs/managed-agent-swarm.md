# Managed Agent Swarm foundation

Session API for the premium flag, a company's CloudBBS project, and saved swarm definitions.
There is no swarm tab, run, or call to CloudBBS in this layer. The credential is stored and not tested.

Company identity is `companies.id` on the signed-in user (`actor.company.id`). `users.company_id` is not used.

## Access

`GET /api/swarm/access` is open to any signed-in user. The body is `{ "enabled": true }` or `{ "enabled": false }`.
A user whose company is not a customer, or whose company has no enabled settings row, gets `false`.

These five routes require a signed-in user of a customer company with the flag on.
Otherwise they return 403 `{ "error", "code": "swarm_not_enabled" }`:

- `GET /api/swarms`
- `POST /api/swarms`
- `GET /api/swarms/{id}`
- `PUT /api/swarms/{id}`
- `DELETE /api/swarms/{id}`

The list is company-wide. `canEdit` is true for the creator and for a company admin of that company.
Anyone else in the company can read. `PUT` and `DELETE` by another member return 403.
A swarm that belongs to another company returns the same 404 body as an id that does not exist.

Unsafe methods use the same CSRF check as other session writes (`X-CSRF-Token`).

## Swarm body

`POST` and `PUT` take `{ name, instructions, totalSpendCap, totalSlotsCap, lanes }`.

- `name`: 1 to 100 characters after trim. The stored name is trimmed.
- `instructions`: a string of 0 to 20,000 characters. It is stored and returned unchanged, as JSON text, including HTML.
- `lanes`: 1 to 25 objects. Each lane uses the managed-agent lane rules (visible lane, sailing date on or after today and inside a rate window, container type, booking fields, `acceptMaxSlots`) plus `priority` (`high`, `normal`, or `low`) and `dateFlexDays` (a whole number from 0 to 14). Omitted priority is `normal`. Omitted flex is 0. `savedQueryId` is not accepted.
- When any lane has `allowBookingRequest: true`, `totalSpendCap` (finite and greater than 0) and `totalSlotsCap` (a whole number from 1 to 10,000) are both required. Otherwise each may be null.
- A lane error is 400. The message is the managed-agent message for that row, and the body includes `position`.

`POST` creates the swarm and its lanes in one transaction. `PUT` replaces the swarm fields and all lanes in one transaction. An invalid lane leaves the previous swarm and lanes unchanged. `DELETE` removes the swarm and its lanes.

Responses carry `canEdit`. Audit rows for create, update, and delete store ids only (`swarm_created`, `swarm_updated`, `swarm_deleted`). They do not store instructions.

## System admin settings

Both routes require a signed-in system admin. Anyone else receives 403.

`GET /api/admin/swarm/companies` returns `{ companies: [...] }` for every customer-type company, including companies with no settings row. Each item is `{ companyId, name, enabled, bbsProject, hasBbsToken, updatedAt }`.

`PUT /api/admin/swarm/companies/{companyId}` takes `{ enabled, bbsProject, bbsToken? }`.

- `bbsProject` is null, or 1 to 64 characters of `[a-z0-9._-]` after trim.
- Omit `bbsToken` to keep the stored credential. A non-empty string replaces it. `null` clears it.
- `enabled: true` is saved only when the company is a customer and, after this write, it has a project and a credential that decrypts. Otherwise the response is 422 `swarm_settings_incomplete` and nothing is saved.
- A known company that is not a customer is 422 `customer_only`. An unknown company is 404.

The credential is encrypted at rest with AES-256-GCM (12-byte IV, 16-byte tag). The key is SHA-256 of `swarm-bbs:` plus `SESSION_SECRET`. No route, audit row, log line, or error returns the credential or its ciphertext. `hasBbsToken` is false when the row has no credential or the current secret cannot decrypt it. A later reader (`readBbsCredentials`) returns null in those cases, and also when the company is disabled or the row is missing.

A successful settings write audits `swarm_settings_updated` with `companyId`, `enabled`, `bbsProject`, and `tokenChanged` (true or false).
