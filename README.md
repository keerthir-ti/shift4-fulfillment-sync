# Fulfillment sync

This project gets an approved sales order in front of the warehouse without waiting for a scheduled data copy. One Temporal workflow follows each order: it waits until Oracle Fusion's shipment lines cover what was ordered, then repeatedly compares Oracle with Palantir Foundry and writes only the differences, until the shipment lines and the fulfillment order the warehouse reads both match.

Everything here runs on simulators with made-up data, so no timing in this repository is a Shift4 measurement. Going live means implementing the two required adapters in `system-adapters.ts` and creating three Foundry actions. Workflow and activity code stays as it is.

The design, with its pros and cons, is in [docs/workflow-design.pdf](docs/workflow-design.pdf).

## Why

Approving an order in Oracle takes moments, but Fulfillment Manager reads from Foundry. Oracle builds shipment lines on its own schedule, and the app isn't told when they're ready. They reach Foundry only when the CData connector next copies the whole table and Foundry finishes indexing it.

That causes three problems:

- **Delay:** warehouse staff wait for the next copy, however early Oracle finished.
- **Growth:** each copy reads every row, so it takes longer as data builds up and uses more of the Oracle call allowance that users also depend on.
- **Silence:** an order that never arrives raises no error, so someone has to check Oracle by hand.

Reading one order at a time removes the wait and the bulk read from this path. The scheduled copy stays, because analytics and corrections still need it.

## Flow

```text
approveOrder (apps/web/lib/flow.ts)
  submit the order to Oracle
  start order-delivery:<SourceTransactionNumber>
  mirror the order to Foundry

deliverOrderToFulfillment
  AwaitingSubmittedOrder     findSubmittedOrder      order exists and is submitted
  AwaitingShipmentCoverage   checkShipmentCoverage   lines cover every ordered quantity
  Reconciling                reconcileOrder          compare both systems, write only differences
                                                     repeat until a pass finds nothing to change
  DeliveryVerified           recordDeliveryStatus    then one more check after the settle watch

Other endings
  CanceledInOracle           no lines left to ship
  OperatorStopped            stopped by an operator
  ActionRequired             deadline reached, a request rejected, or still different after 4 passes

Overdue is a flag beside the stage, raised at 30 minutes while work continues.

recoverySweepWorkflow (Temporal Schedule, optional)
  sweepMissedOrders          starts workflows for approved orders with no final status

deliveryAuditWorkflow (Temporal Schedule, optional)
  auditDeliveredOrders       rechecks recently delivered orders, which corrects later drift
```

## Trigger

The hook sits in `approveOrder()` and is implemented by `createSyncHooks()` in `apps/web/lib/fulfillment-sync.ts`. Set `FULFILLMENT_SYNC=on` to enable it. Without that setting, approval behaves as it did before this project.

| What Oracle's submit call returned | Workflow started? | What the user sees |
|---|---|---|
| Success | Yes, trigger `approved` | Approved |
| 5xx, timeout, network error or lost response | Yes, trigger `uncertain`, since the order may exist | Uncertain, with the reason |
| 429 | No | Oracle is busy, try again |
| Any other 4xx | No | The rejection |

Starting comes before the Foundry mirror, so a mirror failure can't hold an order back.

```ts
await startOrderDelivery(client, {
  orderKey,             // SourceTransactionNumber
  trigger: "approved",
  settings,             // deliverySettingsFromEnv()
}, "order-delivery");
```

Repeat starts are safe:

- **Identity:** the workflow ID is `order-delivery:<orderKey>`, which the app knows before it calls Oracle.
- **Double click:** `USE_EXISTING` joins the run in progress, and the Approve button disappears once an order is submitted.
- **Later retry or sweep:** `ALLOW_DUPLICATE` allows a fresh run once the previous one has closed.
- **Temporal unavailable:** connecting and starting each give up after 3 seconds. The approval still completes, and `NotStarted` goes on the order for the sweep to act on.

`requestCheckNow()` is a second trigger, for an operator or an Oracle event. It wakes a waiting workflow to check at once, or starts one if there isn't one. It's only a hint, so Oracle's data stays the truth and polling still runs. Nothing connects it to Oracle's events yet.

Work started by the sweep or audit runs at a lower Temporal priority than new approvals.

`orderKey` is opaque to the workflow. If source number alone isn't unique, use a key that carries the source system too, such as `ORDERHUB:12345`, and have your `findOrder` adapter interpret it.

## Workflow

`workflows.ts` contains decisions only, and every outside call happens in an activity. History holds identifiers, quantities and counts, and customer rows stay inside the activities.

1. **AwaitingSubmittedOrder** waits for Oracle to return the order as submitted. It relies on Oracle's record, so a lost submit response does no harm.
2. **AwaitingShipmentCoverage** repeats until active shipment lines cover each ordered quantity. Every fifth attempt also re-reads the order to notice a cancellation or changed line.
3. **Reconciling** runs `reconcileOrder` until a pass changes nothing. A pass that writes is followed by a 2-second wait, then another pass to verify it. A retry reads fresh data, so old data is never written.
4. **DeliveryVerified** is set only when a pass finds both the shipment lines and the fulfillment order matching Oracle.
5. **Settle watch** waits 5 minutes and reconciles once more, which catches a change made around the time of the write. If Foundry still differs, the order ends as `ActionRequired`. A failed check doesn't undo delivery, because the snapshot and audit still correct it.

The workflow returns `status`, `orderKey`, `orderNumber`, `linesVerified`, `reconcilePasses`, `wentOverdue`, `reason`, `stages` and `timings`, which show how long Oracle took on each order. Query `getDeliveryProgress` for the stage while it runs.

## Activities

The activities are in `activities.ts`, and they reach outside systems only through the adapters.

| Activity | Input | What it does |
|---|---|---|
| `findSubmittedOrder` | `orderKey` | Returns the order number and active lines, ignoring canceled and zero-quantity ones |
| `checkShipmentCoverage` | `order`, `refreshEvery` | Makes one check per attempt, across all pages and warehouses, and fails until quantities are covered |
| `reconcileOrder` | `order` | Reads the order, Oracle's lines and Foundry's objects, builds the expected fulfillment orders, writes what's missing, older or changed, removes what Oracle no longer supports, and returns only counts |
| `recordDeliveryStatus` | `orderKey`, `orderNumber`, `stage`, `message` | Sends an event and saves the stage on the sales order; a failure never changes the result |
| `sweepMissedOrders` | `lookbackMs`, `limit` | Starts recent submitted orders with no final status, skipping running and stopped ones, and stops after 5 runs per order |
| `auditDeliveredOrders` | `lookbackMs`, `limit` | Starts a low-priority reconcile for recently delivered orders, which corrects drift after their workflows ended |

A line needs nothing more once its active rows add up to the ordered quantity, so split lines work, or once all its rows are canceled.

| Situation | Failure type | Retried? |
|---|---|---|
| Oracle doesn't have the order yet | `OrderNotInOracleYet` | Yes |
| Order isn't submitted yet | `OrderNotSubmittedYet` | Yes |
| Quantities aren't covered yet | `ShipmentCoverageIncomplete` | Yes |
| 429 from Oracle or Foundry | `OracleThrottled`, `FoundryThrottled` | Yes, after `Retry-After` |
| 401 or 403 | `OracleAccessDenied`, `FoundryAccessDenied` | Yes, so an expired credential doesn't fail every open order |
| 5xx, 408, 409, 425 or network failure | `OracleUnreachable`, `FoundryUnreachable` | Yes |
| Any other 4xx | `OracleRejectedRequest`, `FoundryRejectedRequest` | No |
| A bad date or programming error | `UnexpectedActivityError` | No, because it would look like waiting |

The first three and a 429 are normal while waiting, so they're marked `BENIGN` to keep worker logs readable.

## Retries

Waiting is done by retrying a failing activity rather than by looping in the workflow. Retries don't grow the workflow history or hold a worker slot, and a replacement worker picks up where the last one stopped. Temporal won't schedule a retry that would land past the deadline, so keep the longest interval well below it.

Finding the order and waiting for lines share one deadline. Each reconcile call gets its own window, which lets the workflow outlast a Foundry outage.

| Setting | Default | Variable |
|---|---|---|
| First check interval | 5s | `SYNC_POLL_INITIAL_MS` |
| Interval growth | 1.5x | `SYNC_POLL_BACKOFF` |
| Longest interval | 60s | `SYNC_POLL_MAX_MS` |
| Overdue flag | 30 min | `SYNC_OVERDUE_AFTER_MS` |
| Deadline | 4 hours | `SYNC_DEADLINE_MS` |
| Reconcile window | 30 min | `SYNC_RECONCILE_WINDOW_MS` |
| Single attempt timeout | 30s | `SYNC_ATTEMPT_TIMEOUT_MS` |
| Order re-read | Every 5 attempts | `SYNC_ORDER_REFRESH_EVERY` |
| Reconcile passes | 4 | `SYNC_MAX_RECONCILE_PASSES` |
| Wait before verifying | 2s | `SYNC_VERIFY_DELAY_MS` |
| Settle watch | 5 min, 0 to turn off | `SYNC_SETTLE_WATCH_MS` |
| Oracle activities, across all workers | 1 per second | `ORACLE_ACTIVITIES_PER_SECOND` |
| Sweep frequency | 15 min, 0 to turn off | `SYNC_SWEEP_EVERY_MS` |
| Sweep lookback | 24 hours | `SYNC_SWEEP_LOOKBACK_MS` |
| Orders per sweep | 100 | `SYNC_SWEEP_LIMIT` |
| Sweep runs per order | 5 | `SYNC_RECOVERY_MAX_RUNS` |
| Audit frequency | 24 hours, 0 to turn off | `SYNC_AUDIT_EVERY_MS` |
| Audit lookback | 3 days | `SYNC_AUDIT_LOOKBACK_MS` |
| Orders per audit | 100 | `SYNC_AUDIT_LIMIT` |

All of these are starting values to tune once Oracle's real timings and limits are known. The Oracle limit counts activities on the `oracle-reads` queue rather than HTTP calls, and a reconcile pass makes at least two Oracle calls.

## Consistency with the snapshot

The workflow writes shipment lines and fulfillment orders as Foundry edits, under the same keys and values as the snapshot and its transform, so they land on the same objects. A fulfillment order appears only once one is written, and the app reads those objects. The simulator follows Foundry's documented "Apply most recent value" rules:

| Situation | Result |
|---|---|
| Reads after a workflow write | Include it at once |
| Workflow sends a version Foundry already holds unchanged, or an older one | Row is skipped; other rows still apply |
| Same version, different content | Row is written |
| Snapshot value changed in Oracle after the edit | Snapshot wins |
| Snapshot value changed in Oracle before the edit | Edit stays |
| Snapshot lacks a row the workflow created | Row stays |
| Workflow removes a row Oracle no longer has | Row is deleted, and a later snapshot doesn't bring it back |
| Oracle returns no lines at all | Nothing is removed, because a delete can't be undone by a retry |
| Foundry-only fields (lock, approval, activity, sync status) | Never overwritten |

Known limits:

- **Clocks:** the rule compares the edit's time with Oracle's timestamp, so a clock difference could hide an Oracle change from the snapshot. The settle watch catches one made soon after delivery.
- **Later changes:** after the settle watch, Oracle changes arrive with the next snapshot or audit. A row deleted in Oracle stays in Foundry until an audit run removes it, and only orders inside the audit's lookback are checked.
- **Partial writes:** the workflow writes every snapshot-owned field, because later snapshot values may not apply to properties an action didn't set.
- **Real Foundry:** these rules come from Foundry's documentation and haven't been tested on a real tenant.

## Monitoring

- **Explain an order:** `make explain ORDER=<SourceTransactionNumber>` calls `/api/order-delivery`, which reads Oracle, Foundry and Temporal and returns the state, a summary and the next action.
- **Retry:** `make retry ORDER=<SourceTransactionNumber>` asks one order to check now. After an outage, signal every overdue order with `temporal workflow signal --name checkNow --query 'DeliveryOverdue = true'`.
- **Temporal UI:** search by `DeliveryStage`, `DeliveryOverdue` or `SourceOrderNumber`. Each run shows a summary and its live status, and pending activities show the attempt count and the last failure, such as `found quantity 1 of 2`.
- **In Foundry:** the sales order holds the current status and a feed of what happened, and the app displays it.
- **Events:** `createLogEventSink` writes each stage change as a JSON log line. Set `DELIVERY_ALERT_WEBHOOK_URL` to post `Overdue` and `ActionRequired` events, or implement `DeliveryEventSink` to keep them elsewhere, such as Redis.
- **Metrics:** set `WORKER_METRICS_PORT` for Prometheus metrics. `order_delivery_oracle_wait_ms`, `order_delivery_total_ms` and `order_delivery_outcomes` show Oracle's real time, approve to visible, and results. Rising `temporal_activity_schedule_to_start_latency` means workers are falling behind.

Temporal keeps workflow history for the namespace's retention period, which the team should set at deployment.

## Integrating

1. Implement `OracleOrderReader`: `findOrder` and `listShipmentLines`.
2. Implement `FoundryFulfillmentStore`: `writeFulfillment`, `readFulfillment`, `removeFulfillment` and `recordDeliveryStatus`. Convert dates with `parseTimestamp`, which rejects a bad value instead of letting it pass the version check.
3. Create the Foundry actions, using `services/sim/src/foundry/server.ts` as the reference:
   - `sync-shipment-lines` writes shipment lines and fulfillment orders, with every snapshot-owned property under the transform's keys, and skips a row Foundry holds newer or unchanged.
   - `remove-shipment-lines` deletes shipment lines and fulfillment orders Oracle no longer supports.
   - `record-fulfillment-sync` saves the stage and ignores a repeated note.
4. Call the hook in your approve action, after the Oracle submit and before the Foundry mirror.
5. Give the worker its own Oracle and Foundry credentials, since it runs without a user session.
6. Register `SourceOrderNumber` and `DeliveryStage` as Keyword search attributes, and `DeliveryOverdue` as Bool.
7. Start `apps/worker/src/main.ts` with these variables:
   - `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_ORACLE_TASK_QUEUE`
   - `TEMPORAL_API_KEY`, for Temporal Cloud
   - `ORACLE_URL`, `ORACLE_AUTHORIZATION`, `FOUNDRY_URL`, `FOUNDRY_AUTHORIZATION`
   - `WORKER_HEALTH_PORT`, `WORKER_METRICS_PORT`, `DELIVERY_ALERT_WEBHOOK_URL`, all optional

The sweep and audit need a `RecoveryIndex`. To go without them, set `SYNC_SWEEP_EVERY_MS=0`, and the snapshot remains the fallback for missed orders.

Please confirm:

- Which object Fulfillment Manager reads, its transform's keys and required fields, so `fulfillmentOrders()` in `packages/contracts` can match it
- Which call submits the order, and whether `SourceTransactionNumber` is unique and known before that call, or whether identity needs the source system too
- How to filter shipment lines and find an order by source number
- Whether shipment-line objects accept action writes under the transform's keys, and whether a snapshot fills properties an action didn't set
- The type, timezone and precision of `LastUpdateDate`, and how far Oracle's and Foundry's clocks differ
- How Oracle represents cancellations, holds and deleted shipment lines
- Which Oracle status means shipment lines exist, and whether it raises a Fulfillment Line Status Update event
- Oracle's REST limit, and what it returns when exceeded

## Running locally

You only need Docker and `make`. Run `make` to list every command.

```bash
make problem    # today's path, with no Temporal
make solution   # the same stack, with Temporal, the worker and the workflow on
make stop
```

The app opens at http://127.0.0.1:13000, and with `make solution` the Temporal UI is at http://127.0.0.1:18243. Create a draft, approve it, and watch when it reaches Fulfillment Manager. Set `WEB_PORT`, `ORACLE_PORT`, `FOUNDRY_PORT`, `CONNECTOR_PORT`, `TEMPORAL_PORT`, `TEMPORAL_UI_PORT` or `WORKER_METRICS_PORT` if a port is taken. These commands use shorter polling, overdue, deadline, sweep and settle times so that results appear quickly.

| Command | What it does |
|---|---|
| `make status`, `make logs`, `make health` | Show container state, output and health |
| `make explain ORDER=<number>` | Explains one order |
| `make retry ORDER=<number>` | Asks one order to check now |
| `make reset` | Clears orders and restarts the scenario |
| `make clean` | Removes the containers, the image and simulator data |
| `make verify-docker` | Runs browser tests against the containers, with and without Temporal |

Working on the code itself also needs Node.js, pnpm and the [Temporal CLI](https://docs.temporal.io/cli). Run `pnpm install` first.

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the app and simulators without Docker or Temporal; add `FULFILLMENT_SYNC=on` for the workflow. It deletes `.local` each time it starts |
| `pnpm demo` | Approves orders at four points in the snapshot cycle, without and with the workflow, and prints how long each took |
| `pnpm measure:gap` | Measures today's path and the alternatives across data sizes on simulated time, then the workflow on real time |
| `pnpm test` | Runs unit and integration tests, including the real default timings on Temporal's time-skipping server |
| `pnpm test:e2e` | Runs browser tests; add `E2E_FULFILLMENT_SYNC=on` for the workflow, `E2E_CHANNEL=chrome` for an installed Chrome, and `E2E_BASE_URL` for a stack already running |
| `pnpm typecheck` | Checks types |
| `pnpm check:boundaries` | Confirms the workflow doesn't depend on the simulators |

These settings change how the simulators behave, with either way of running:

| Variable | Effect |
|---|---|
| `PROFILE=accelerated` | Default: 5s Oracle processing, 60s snapshots, no data-growth cost or call limit |
| `PROFILE=fifteen-minute` | The same, with 15-minute snapshots |
| `PROFILE=dev-estimate` | Snapshots every 5 minutes for shipment lines and 15 for orders, as described by Shift4. Snapshot cost that grows with rows, 90s Oracle processing and 120 shared calls per minute are assumptions |
| `ORACLE_EXISTING_SHIPMENTS=25000` | Puts that many completed shipment lines in Oracle at startup, so snapshots have real rows to read |

## Code

```text
packages/order-delivery/src/         workflows, activities, system adapters, client, worker, explain, events, settings
packages/contracts/src/              shared types, profiles, row builder, coverage, fulfillment order view
apps/worker/src/main.ts              worker process, sweep schedule, metrics
apps/web/lib/flow.ts                 create and approve flow
apps/web/lib/fulfillment-sync.ts     starts the workflow from the approve hook
apps/web/app/api/order-delivery/     the explain route
apps/web/                            sales and fulfillment screens, with a simulator timeline
services/sim/src/oracle/             Oracle REST subset, order processing, shared call budget
services/sim/src/connector/          scheduled snapshots with paged, frozen reads
services/sim/src/foundry/            backing data, indexing, Foundry's edit rules, actions
fixtures/                            synthetic reference data and scenarios
scripts/                             demo, gap measurement, dev launcher, Temporal dev server, boundary check, PDF build
tests/                               unit, integration and browser tests
docs/workflow-design.pdf             the problem, proposed solution, workflow design, pros and cons
docs/workflow-design.html            source for the PDF; rebuild with scripts/build-design-pdf.sh
Dockerfile, compose.yaml, Makefile   one-command Docker run
```
