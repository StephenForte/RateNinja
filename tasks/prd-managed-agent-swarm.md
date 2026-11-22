# PRD: Managed Agent Swarm (Premium)

Status: draft for operator review, 2026-11-22. Decisions of record: D-061 (product and
architecture) and D-062 (foundation contract) in `tasks/round-1-decisions.md`. Tasks R1-62 to
R1-66 in `tasks/round-1-plan.md`.

## 1. Summary

A third customer tab, **Managed Agent Swarm (Premium)**. A customer saves a *swarm*: global rules,
free-text instructions, and up to 25 trade lanes each with its own policy. Pressing **Run** starts
one **master agent** for that company. The master spawns one **search agent** per lane, reads their
reports, may redirect a search agent once, then spawns **booking agents** that make booking
requests and report back. The customer watches the whole run, agent by agent.

## 2. What exists today (measured on main `dbf9ee1`)

- Tabs: `Rates` and `Managed agents` (`public/index.html` `#ratesTabs`).
- Managed agents (D-039 to D-060): one row = one search, run by Kings. The runner
  (`lib/managed-agent-runner.js`) is code with two Claude calls per agent. Nothing spawns, and
  there is no tool loop.
- CloudBBS: one shared project `rn`, readable by other customers' agents. D-041 bans company
  names, ports and prices there.
- No premium or plan-tier concept exists in the code.
- Secrets at rest: only MFA secrets are encrypted (AES-256-GCM, key derived from
  `SESSION_SECRET`, `lib/mfa.js`).

## 3. Operator answers (2026-11-22)

| Question | Answer |
| --- | --- |
| How real are the agents | Master is a Claude tool-use loop; each sub-agent is its own Claude call chain; code enforces the caps |
| Where state lives | SQLite is the truth (the dashboard reads it). Agents also keep keyed state in a private CloudBBS project per customer |
| Where a run executes | Render web process now. A background worker is roadmap, when scale needs it |
| Booking gate | Automatic inside the caps now. An "I must approve first" checkbox is roadmap |
| Premium gate | Per-company flag set by a system admin. Others see the tab with a "Premium, contact Kings" panel |
| Data model | Separate swarm tables. Existing managed agents are untouched. A saved swarm can be run again |
| Global rules | Total spend cap (hard), total slots cap (hard), per-lane priority, free-text or uploaded `.md` instructions |
| "Terminal" | Web only in v1 |
| CloudBBS setup | The operator creates the project and token by hand; a system admin pastes them into the company's swarm settings (encrypted) |
| Redirect | Once per lane: a nearby destination or another sailing date inside the lane's window, only when the lane allows it |
| Master template | Versioned file in the repo (`prompts/`), no secrets |
| Limits | 25 lanes, one run at a time per company, master turn and time cap, customer can cancel |
| Views | The customer sees their runs. Rate owners and system admins see runs per customer |

## 4. Users and access

- **Customer user** (company type customer, swarm enabled): create, edit, delete and run swarms;
  see every run of their company; cancel a run.
- **Customer without the flag**: sees the tab and a premium panel. Every swarm API call returns
  403 `swarm_not_enabled`.
- **System admin**: enables the flag per company, sets the CloudBBS project and token, sees all
  runs of all customers.
- **Contract owner admin**: sees runs of the customers linked to their company (A1).

## 5. The wizard (tab `/swarm`)

1. **Instructions**: swarm name, free-text instructions (typed, pasted, or a `.md` file read in
   the browser into the same field; 20,000 characters at most; always shown as text, never HTML).
2. **Global rules**: total spend cap, total slots cap.
3. **Lanes**: pick 1 to 25 lanes (rate type, origin, destination, sailing date, container type).
4. **Policy**: per lane: priority (high, normal, low), allow alternatives, date flex (0 to 14
   days), allow booking, price range, slots, "Use AI for slot selection". Select all or some lanes
   to set one policy on many, then adjust single lanes.
5. **Review and Run**: saves the swarm and starts the run at once. "Save without running" is also
   offered.

## 6. A run

1. **Start**: one run per company at a time. The run stores a snapshot of the swarm, so later
   edits do not change a run in progress.
2. **Master** (Claude tool loop, template `prompts/swarm-master.md`) gets the snapshot and these
   tools only: `spawn_search(lane)`, `redirect_search(lane, destination | date)`,
   `spawn_booking(lane, rateId, slots)`, `read_state`, `write_state`, `finish(summary)`.
3. **Search agents**: one per lane. Each reads matches for its lane (customer prices only), picks
   the best rate, and reports rate, price, sailing and a short reason. Then it is closed.
4. **Decision**: when all have reported, the master ranks lanes by priority inside the caps. It
   may redirect a lane once when that lane has no bookable rate in range and its policy allows it.
5. **Booking agents**: one per funded lane. Each makes one booking request and reports the
   booking id or the refusal. Then it is closed.
6. **Finish**: the master writes a run summary. Statuses: `running`, `completed`, `failed`,
   `cancelled`, `interrupted` (the web process restarted mid-run; bookings already made stay).

### Guards (code, not the model)

A booking is refused by code unless all of these hold. The model cannot switch any of them off.

- The rate id is one that this run's search agent fetched for that lane, bookable and in the
  lane's price range.
- Booked spend so far + price × slots ≤ total spend cap.
- Booked slots so far + slots ≤ total slots cap.
- Slots follow the lane's policy and the rate's max slots (D-055, D-060).
- The lane allows booking, and has no booking yet in this run.
- Checked and recorded in one transaction, so two booking agents cannot both pass on the last
  of the budget.

Bookings stay requests that Kings approves, as today. The free-text instructions are untrusted
input: they can steer choices inside the guards and can never widen them.

### Limits

- Master turn cap and run time cap: fixed numbers, set in the engine task after a measured test
  run (unmeasured today).
- Cancel: stops the run between steps. Nothing is rolled back.
- Cost: each run spends Anthropic tokens on the server's key. Per-run token use is recorded on
  the run (unmeasured today; the engine task measures a 3-lane and a 25-lane run before the
  caps are fixed).

## 7. State

- **SQLite (truth)**: swarm, lanes, per-company settings, runs, run agents (role, lane, status,
  times, report, booking id), run totals (spend, slots, tokens).
- **CloudBBS (agents' shared state)**: the company's private project, read and written with that
  company's stored token. Keys are per run: policy snapshot, each search report, the master's
  plan, each booking result. If CloudBBS fails, the run fails at that step and says so; SQLite
  still shows what happened.
- Nothing from a swarm is ever written to `rn`.

## 8. Dashboards

- **Customer** (`/swarm`): list of runs; a run shows the master and each sub-agent with status,
  times, report text, booking link, and the run totals against the caps. Refreshes while running.
- **Owner and system admin**: the same view, read-only, chosen by customer.

## 9. Delivery

| Task | What | Depends on |
| --- | --- | --- |
| R1-62 | Foundation: migration 020, premium flag and CloudBBS settings (system admin API), swarm definition API | — |
| R1-63 | Wizard tab `/swarm`, premium panel, system-admin settings panel | R1-62 |
| R1-64 | Run engine: migration 021, master loop, sub-agents, guards, prompt templates, start and cancel, interrupted recovery, CloudBBS state | R1-62 |
| R1-65 | Customer run dashboard, Run and Cancel buttons | R1-63, R1-64 |
| R1-66 | Owner and system-admin runs view per customer | R1-64 |

R1-63 and R1-64 can run in parallel after R1-62 merges.

## 10. Roadmap (not in this delivery)

- Background worker on Render, so runs survive web deploys and scale.
- "I must approve first" checkbox: the run pauses after the search phase and the customer
  approves the master's plan.
- Creating and running swarms from the admin CLI, the partner API or MCP.
- Server creates the CloudBBS project and token itself.
- Scheduled or repeating runs.
- Billing for premium.

## 11. Assumptions (confirmed by the operator 2026-11-22)

- **A1**: a contract owner admin sees runs only for customers linked to their company; a system
  admin sees all.
- **A2**: both caps are required when any lane allows booking. Spend = customer price × slots of
  the booking requests made in the run, whether or not Kings later approves them.
- **A3**: the swarm list is company-wide. The creator or a company admin may edit or delete.
- **A4**: the booking is made in the name of the user who pressed Run.
- **A5**: date flex means the sailing date may move by up to N days either way, inside a rate
  window for the lane.
