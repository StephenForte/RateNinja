# Booking requests (P1)

A user at a Freight Forwarder/Customer company can ask to book slots on a rate they can see. A user at the company that owns that rate approves or declines the request in the app. Approval does not reserve capacity. A rate record is not evidence of allocatable or transferable space.

Contract Owner users cannot request a booking, and the rates grid does not show them a button. System admins act only as their home company. The company selected in the admin header is not a party to a request.

## What a request is

One saved rate, one container size (`20D`, `40D`, or `40HC`), and a whole number of slots from 1 to 1000 (`MAX_BOOKING_SLOTS` in `lib/limits.js`). The size must have a customer price. A missing price is rejected. A price of 0 is allowed.

The price stored on the request is the customer's price at that moment, from the same path as the rates grid (`customerPricedRate` in `lib/visibility.js`). It is not the owner's base price. The row also copies the rate's route, carrier, dates, and the owner company's name, so it stays readable after the rate is edited, soft-deleted, or pulled forward.

The owner company is taken from the rate. The request body cannot name a different owner.

## When a rate can be requested

The rate is saved, not soft-deleted, and the customer's company can see it now through an active link. The expiration date is blank or on or after today (UTC). A blank date is the same as the N/A the grid shows. A rate that is not yet effective can still be requested.

An expired rate is rejected with 400 and the message "This rate has expired." A rate the customer cannot see — unlinked owner, revoked link, soft-deleted, or no such rate — is 404 with the same body in every case.

Predictive rows reuse the saved rate's id. The grid hides the button on those rows and on expired rows. A request is always priced from the saved rate, never from the predictive figure.

## Decisions and who can see a request

Status is `pending`, `approved`, or `declined`. The first decision wins. A later decision gets 409. There is no cancel, edit, or reopen.

Any user of the owning company, member or admin, can decide. A customer user cannot. Another company that tries to read the request, decide it, or mark it read gets 404, not 403.

Both companies on the request can see it. Nobody else can. The customer response does not include who at the owner company decided. The owner response includes who requested it.

## Unread count

Read state is per company side, not per user. A new request is unread for the owner company. A decision is unread for the customer company. Opening Booking requests marks that side read. The header bell shows the signed-in user's unread count, links to `/profile/booking-requests`, and refreshes when they change pages and about every 60 seconds. A partner API or MCP read does not mark either side read.

## Partner API and MCP

A contract owner can list and read the company's booking requests with scope `bookings:read`, and approve or decline one with scope `bookings:write`. The routes are `GET /api/partner/v1/me/booking-requests`, `GET /api/partner/v1/me/booking-requests/{id}`, and `POST /api/partner/v1/me/booking-requests/{id}/decision`. The MCP tools are `rateninja_list_my_booking_requests`, `rateninja_get_my_booking_request`, and `rateninja_decide_booking_request`.

The token's company must own the request. Another company's id is the same not-found response as a missing id. The body is the owner view: customer price and requester, and not the base price. `bookings:read` does not include `bookings:write`. The decide tool changes data and the decision is final. The first decision wins. A repeat is `already_decided`. Reading through the partner API or MCP does not change unread state. A decision made there is unread for the customer in the app, the same as a decision made in the app.

Customer access on the partner API and MCP is planned, not available. Creating a request through those surfaces is not available either. Discovery does not advertise `bookings:read` or `bookings:write`. A client must request those scopes explicitly, for example with `scopes` in Cursor's `mcp.json` auth block, and the client must be allowed them.

## Phase 2

P2 is not built here. It will send email to both ends through `lib/resend.js` when a request is created and when it is decided.
