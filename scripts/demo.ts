/**
 * pnpm demo: one command, end to end, in the terminal. It starts the simulators, a Temporal dev
 * server and a worker, then approves orders at four points in the snapshot cycle, on today's path
 * and on the workflow, and prints both. The timings are synthetic, not Shift4's production latency.
 */
import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { acceleratedProfile } from "../packages/contracts/src/index.js";
import { createActivities } from "../packages/order-delivery/src/activities.js";
import { createHttpFoundryStore, createHttpOracleReader } from "../packages/order-delivery/src/system-adapters.js";
import { DELIVERY_OVERDUE, DELIVERY_STAGE, SOURCE_ORDER_NUMBER } from "../packages/order-delivery/src/search-attributes.js";
import { createDeliveryWorkers } from "../packages/order-delivery/src/worker.js";
import type { DeliverySettings } from "../packages/order-delivery/src/types.js";
import { approveOrder, createOrder, type FlowHooks } from "../apps/web/lib/flow.js";
import { createSyncHooks } from "../apps/web/lib/fulfillment-sync.js";
import { startWallClockStack, send } from "../tests/helpers/stack.js";
import { temporalCli } from "../tests/helpers/temporal.js";

const SNAPSHOT_MS = 20_000;
const OFFSETS_MS = [1_000, 6_000, 11_000, 16_000];
const profile = acceleratedProfile({ oracleProcessingMs: 2_000, snapshotIntervalMs: SNAPSHOT_MS, extractionMs: 1_000, indexingMs: 500 });
const settings: DeliverySettings = { pollInitialMs: 500, pollBackoff: 1, pollMaxMs: 500, overdueAfterMs: 60_000, deadlineMs: 60_000, reconcileWindowMs: 60_000, attemptTimeoutMs: 10_000, orderRefreshEvery: 5, maxReconcilePasses: 4, verifyDelayMs: 100, settleWatchMs: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Measured = { offsetMs: number; orderNumber: string; visibleAfterMs: number; oracleReads: number };

async function measure(hooks: FlowHooks): Promise<Measured[]> {
  const stack = await startWallClockStack({ profile });
  const previous = { oracle: process.env.ORACLE_URL, foundry: process.env.FOUNDRY_URL };
  try {
    const origin = stack.connector.ctx.origin;
    const urls = { oracle: stack.oracle.url, foundry: stack.foundry.url };
    const runs = OFFSETS_MS.map(async (offsetMs) => {
      await sleep(origin + offsetMs - Date.now());
      process.env.ORACLE_URL = urls.oracle;
      process.env.FOUNDRY_URL = urls.foundry;
      const created = await createOrder({ buyingPartyName: "Synthetic Merchant Ltd", organizationCode: "WH-DUB", productNumber: "POS-ACC", quantity: 2, sourceTransactionNumber: `verify-${randomUUID().slice(0, 8)}` });
      if (!created.ok) throw new Error(created.message);
      const approvedAt = Date.now();
      await approveOrder({ headerId: created.headerId, orderNumber: created.orderNumber }, hooks);
      for (;;) {
        const rows = await send(`${urls.foundry}/lab/query/FulfillmentOrder`);
        if (rows.body.items.some((row: { properties: { orderNumber: string } }) => row.properties.orderNumber === created.orderNumber)) break;
        if (Date.now() - approvedAt > 60_000) throw new Error(`order ${created.orderNumber} never became visible`);
        await sleep(50);
      }
      return { offsetMs, orderNumber: created.orderNumber, visibleAfterMs: Date.now() - approvedAt, oracleReads: 0 };
    });
    const measured = await Promise.all(runs);
    const reads = stack.oracle.ctx.requests.filter((request) => request.url.includes("/shipmentLines?q="));
    for (const row of measured) row.oracleReads = reads.filter((request) => decodeURIComponent(request.url).includes(`OrderNumber='${row.orderNumber}'`)).length;
    return measured;
  } finally {
    stack.clock.clear();
    await stack.stop();
    process.env.ORACLE_URL = previous.oracle;
    process.env.FOUNDRY_URL = previous.foundry;
  }
}

const spread = (rows: Measured[]) => Math.max(...rows.map((row) => row.visibleAfterMs)) - Math.min(...rows.map((row) => row.visibleAfterMs));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

console.log("Measuring today's path (about 40 seconds)...");
const today = await measure({});

console.log("Measuring the workflow path (about 40 seconds)...");
const env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: "existing-path", path: temporalCli() }, searchAttributes: [SOURCE_ORDER_NUMBER, DELIVERY_STAGE, DELIVERY_OVERDUE] } });
const taskQueue = `verify-${randomUUID().slice(0, 8)}`;
const oracleTaskQueue = `${taskQueue}-oracle`;
// The simulators restart for each measurement, so the adapters look up their address on every call.
const oracle = () => createHttpOracleReader({ baseUrl: process.env.ORACLE_URL! });
const foundry = () => createHttpFoundryStore({ baseUrl: process.env.FOUNDRY_URL! });
const lazy = {
  oracle: { findOrder: (key: string) => oracle().findOrder(key), listShipmentLines: (order: string) => oracle().listShipmentLines(order) },
  foundry: {
    writeFulfillment: (data: Parameters<ReturnType<typeof foundry>["writeFulfillment"]>[0]) => foundry().writeFulfillment(data),
    readFulfillment: (order: string) => foundry().readFulfillment(order),
    removeFulfillment: (items: Parameters<ReturnType<typeof foundry>["removeFulfillment"]>[0]) => foundry().removeFulfillment(items),
    recordDeliveryStatus: (entry: { orderNumber: string; stage: string; message: string }) => foundry().recordDeliveryStatus(entry),
  },
};
const workers = await createDeliveryWorkers({ connection: env.nativeConnection, taskQueue, oracleTaskQueue, oracleActivitiesPerSecond: 20, activities: createActivities(lazy) });
const running = workers.run();
const withWorkflow = await measure(createSyncHooks({ client: async () => env.client, taskQueue, settings: { ...settings, oracleTaskQueue } }));
workers.shutdown();
await running;
await env.teardown();

const lines = OFFSETS_MS.map((offset, index) => `| ${seconds(offset)} | ${seconds(today[index].visibleAfterMs)} | ${seconds(withWorkflow[index].visibleAfterMs)} | ${withWorkflow[index].oracleReads} |`);
const report = `Today's path against the workflow

Simulators on real time. Synthetic timings: Oracle ${seconds(profile.oracleProcessingMs)}, snapshot every ${seconds(SNAPSHOT_MS)}, copy ${seconds(profile.extractionMs)}, index ${seconds(profile.indexingMs)}. Not Shift4's production latency.

| Approved, after snapshot cycle start | Today: approve to visible | Workflow: approve to visible | Workflow: shipment-line reads in Oracle |
${lines.join("\n")}

Spread between orders: today ${seconds(spread(today))}, workflow ${seconds(spread(withWorkflow))}.
`;
console.log(`\n${report}`);
process.exit(0);
