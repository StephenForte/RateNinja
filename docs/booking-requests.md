# Booking requests (P1)

A user at a Freight Forwarder/Customer company can ask to book slots on a rate they can see. A user at the company that owns that rate approves or declines the request in the app. Approval does not reserve capacity. A rate record is not evidence of allocatable or transferable space.

Contract Owner users cannot request a booking, and the rates grid does not show them a button. System admins act only as their home company. The company selected in the admin header is not a party to a request.

## What a request is

One saved rate, one container size (`20D`, `40D`, or `40HC`), and a whole number of slots from 1 to 1000 (`MAX_BOOKING_SLOTS` in `lib/limits.js`). The size must have a customer price. A missing price is rejected. A price of 0 is allowed. When the rate's max slots is a number, that request may ask for at most that many (other requests on the rate do not count), zero refuses every request with "This rate has no slots available.", and a request over the max is refused with "This rate allows at most N slots per request."; a blank max keeps the 1 to 1000 rule.

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

For owner tokens, the company must own the request. Another company's id is the same not-found response as a missing id. The body is the owner view: customer price and requester, and not the base price. `bookings:read` does not include `bookings:write`. The decide tool changes data and the decision is final. The first decision wins. A repeat is `already_decided`. Reading through the partner API or MCP does not change unread state. A decision made there is unread for the customer in the app, the same as a decision made in the app.

Customers can authorize the partner API and MCP, list available customer-priced rates and create booking requests. Discovery advertises `bookings:read` and `bookings:write` with the three read scopes. The server grants a requested scope only when the client is allowed it.

## Phase 2

P2 is not built here. It will send email to both ends through `lib/resend.js` when a request is created and when it is decided.


## Customer partner access

Customers use GET /api/partner/v1/me/available-rates (rates:read; MCP rateninja_list_available_rates) for app-grid customer prices through active links. Filters carrier, originPort and destinationPort are case-insensitive exact matches; page and pageSize use the usual bounds. Fields are id, carrier, originPort, destinationPort, inlandDeliveryLocation, commodityType, contractOwner, ownerCompanyName, contractNumber, rate20D, rate40D, rate40HC, rateEffectiveDate, rateExpirationDate, notes and bookable. bookable requires an unexpired rate (blank expiry or today UTC qualifies) and at least one price. Lists return { data, meta } with the allocation notice.

Customers use OAuth with `bookings:write` to call `POST /api/partner/v1/me/booking-requests` or MCP `rateninja_create_booking_request`. Both require `rateId`, `containerSize`, `slots` and the string `bookingCode`. The API returns `201 { data, meta }`. A repeat create makes another request; clients should list before retrying. Customers list and read only their company requests with bookings:read through the existing booking routes and tools. Their view never includes the deciding user. Reads leave unread state unchanged; a new request is unread for the owner. Hidden rates and another customer's request ids return the same not_found as missing ids.

Read the current nine-character code from the [CloudBBS rn announcement](https://cloudbbs.ai/supa/rn). Each option 9 post rotates the code. RateNinja trims and compares codes case-insensitively and may cache the current code for up to 60 seconds. An omitted, blank or wrong code returns HTTP 403 `invalid_booking_code`. If RateNinja cannot read a valid code, it returns HTTP 503 `booking_code_unavailable`, even when the request omits the code. MCP includes the error in `result.structuredContent.error`. Website bookings use the signed-in session and require no code.

Customer tokens never receive base prices, margins or owner company ids. Owner rates, sailings, predictive pricing and decisions return 403 owner_only to customers. Owners receive 403 customer_only on available-rates and create. MCP calls enforce company type before scopes and arguments; tools/list shows customers exactly profile, available rates, booking list, booking read and booking create. Owner discovery is unchanged. Create annotations are readOnlyHint false, destructiveHint false and idempotentHint false; the tool changes data. The available-rates list is read-only. Company type is live on each call. Scopes remain independently required, and discovery advertises all five scopes. Connected apps lets both supported types list and revoke grants; revoked credentials stop working.

## ForteL2 approval receipts

Each new approval queues a receipt on ForteL2 Sepolia (chain ID 852). The approval takes
effect immediately. The buyer and rate owner can follow the receipt from the booking
record, and the buyer needs no wallet. Approvals made before receipts were introduced
keep their original records. Pending and declined bookings have no receipt.

The booking table shows **Receipt pending**, **Receipt submitted**, **Receipt confirmed**,
or **Receipt failed**. Submitted and confirmed receipts link to the transaction explorer.
A receipt can fail independently of the approval.

### Verify a receipt

Build the JSON object below from the buyer's booking record. Use the exact stored values,
including nulls and the original `decidedAt` string. Use the existing JSON types and copy
booking `id` into `requestId`. The keys are in the order used by the server.

```js
const canonical = JSON.stringify({
    carrier: booking.carrier,
    containerSize: booking.containerSize,
    customerPrice: booking.customerPrice,
    decidedAt: booking.decidedAt,
    destinationPort: booking.destinationPort,
    originPort: booking.originPort,
    rateId: booking.rateId,
    requestId: booking.id,
    slots: booking.slots,
    status: booking.status,
    version: 1
});
```

Take Ethereum Keccak-256 of the UTF-8 bytes of this compact JSON. The result should match
`booking.receipt.receiptHash`. On ForteL2 Sepolia, look up `booking.receipt.txHash` and check
that the zero-value transaction succeeded and its input is `0x524e5231` followed by the
32 hash bytes (drop the hash's leading `0x`). The input contains only the `RNR1` tag and hash.
