/**
 * pnpm measure:gap: measures how long an approved order takes to reach Fulfillment Manager through the
 * real app flow, today and with each alternative, on the same simulators and settings.
 *
 * The snapshot paths run with no Temporal on simulated time, so a 15-minute wait takes seconds. The
 * workflow runs on real time with a real Temporal server, so that part takes about two minutes. The
 * profile is an estimate, so these results show how the delay behaves and are not Shift4 measurements.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { approveOrder, createOrder, type FlowHooks } from "../apps/web/lib/flow.js";
import { createSyncHooks } from "../apps/web/lib/fulfillment-sync.js";
import { devEstimateProfile, type Profile } from "../packages/contracts/src/index.js";
import { createActivities } from "../packages/order-delivery/src/activities.js";
import { DELIVERY_OVERDUE, DELIVERY_STAGE, SOURCE_ORDER_NUMBER } from "../packages/order-delivery/src/search-attributes.js";
import { createHttpFoundryStore, createHttpOracleReader } from "../packages/order-delivery/src/system-adapters.js";
import { DEFAULT_DELIVERY_SETTINGS, type DeliverySettings } from "../packages/order-delivery/src/types.js";
import { createDeliveryWorkers } from "../packages/order-delivery/src/worker.js";
import { send, startStack, startWallClockStack } from "../tests/helpers/stack.js";
import { temporalCli } from "../tests/helpers/temporal.js";

const PATHS: { label: string; overrides: Partial<Profile> }[] = [
  { label: "Snapshot every 15 min", overrides: { shipmentSnapshotIntervalMs: 15 * 60_000 } },
  { label: "Snapshot every 5 min", overrides: { shipmentSnapshotIntervalMs: 5 * 60_000 } },
  { label: "Snapshot every 1 min", overrides: { shipmentSnapshotIntervalMs: 60_000 } },
  { label: "Incremental every 5 min", overrides: { shipmentSnapshotIntervalMs: 5 * 60_000, connectorMode: "incremental" } },
];
const DATA_SIZES = (process.env.MEASURE_SIZES ?? "0,25000,100000").split(",").map(Number);
const POINTS_IN_CYCLE = Number(process.env.MEASURE_POINTS ?? 6);
const STEP_MS = 5_000;

const flowOrder = async (hooks: FlowHooks) => {
  const created = await createOrder({ buyingPartyName: "Synthetic Merchant Ltd", organizationCode: "WH-DUB", productNumber: "POS-ACC", quantity: 2, sourceTransactionNumber: `measure-${randomUUID().slice(0, 8)}` });
  if (!created.ok) throw new Error(created.message);
  const approved = await approveOrder({ headerId: created.headerId, orderNumber: created.orderNumber }, hooks);
  if (!approved.ok) throw new Error(approved.message);
  return created.orderNumber;
};

const isVisible = async (foundryUrl: string, orderNumber: string) => {
  const found = await send(`${foundryUrl}/api/v2/ontologies/local/objects/FulfillmentOrder/search`, { method: "POST", body: JSON.stringify({ where: { type: "eq", field: "orderNumber", value: orderNumber } }) });
  return found.body.data?.length > 0;
};

async function measureSnapshotPath(profile: Profile, existingShipments: number, offsetMs: number) {
  const stack = await startStack({ profile, existingShipments });
  try {
    process.env.ORACLE_URL = stack.oracle.url;
    process.env.FOUNDRY_URL = stack.foundry.url;
    await stack.clock.advanceTo(offsetMs);
    const orderNumber = await flowOrder({});
    const limit = offsetMs + 3 * profile.shipmentSnapshotIntervalMs + 60 * 60_000;
    for (let at = offsetMs + STEP_MS; at <= limit; at += STEP_MS) {
      await stack.clock.advanceTo(at);
      if (await isVisible(stack.foundry.url, orderNumber)) {
        const connectorCalls = stack.oracle.ctx.requests.filter((request) => request.url.includes("captureToken=") && request.url.includes("shipmentLines")).length;
        return { visibleMs: at - offsetMs, connectorCallsPerHour: Math.round((connectorCalls / at) * 3_600_000), rateLimited: stack.oracle.ctx.rateLimited.length };
      }
    }
    throw new Error(`order ${orderNumber} was not visible within ${limit}ms`);
  } finally {
    await stack.stop();
  }
}

/** The real workflow, on real time, with the same assumed Oracle processing time and a large table. */
async function measureWorkflow(existingShipments: number) {
  const profile = devEstimateProfile();
  const stack = await startWallClockStack({ profile, existingShipments });
  const env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: "existing-path", path: temporalCli() }, searchAttributes: [SOURCE_ORDER_NUMBER, DELIVERY_STAGE, DELIVERY_OVERDUE] } });
  try {
    process.env.ORACLE_URL = stack.oracle.url;
    process.env.FOUNDRY_URL = stack.foundry.url;
    const taskQueue = `measure-${randomUUID().slice(0, 8)}`;
    const settings: DeliverySettings = { ...DEFAULT_DELIVERY_SETTINGS, oracleTaskQueue: `${taskQueue}-oracle`, settleWatchMs: 0 };
    const workers = await createDeliveryWorkers({
      connection: env.nativeConnection,
      taskQueue,
      oracleTaskQueue: `${taskQueue}-oracle`,
      oracleActivitiesPerSecond: 1,
      activities: createActivities({ oracle: createHttpOracleReader({ baseUrl: stack.oracle.url }), foundry: createHttpFoundryStore({ baseUrl: stack.foundry.url }) }),
    });
    const running = workers.run();
    const approvedAt = Date.now();
    const orderNumber = await flowOrder(createSyncHooks({ client: async () => env.client, taskQueue, settings }));
    while (!(await isVisible(stack.foundry.url, orderNumber))) {
      if (Date.now() - approvedAt > 600_000) throw new Error("workflow did not deliver within 10 minutes");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const visibleMs = Date.now() - approvedAt;
    workers.shutdown();
    await running;
    return { visibleMs, oracleCalls: stack.oracle.ctx.requests.filter((request) => decodeURIComponent(request.url).includes(`'${orderNumber}'`)).length };
  } finally {
    stack.clock.clear();
    await stack.stop();
    await env.teardown();
  }
}

const minutes = (ms: number) => (ms / 60_000).toFixed(1);
const rows: Record<string, unknown>[] = [];
for (const path of PATHS) {
  const profile = devEstimateProfile(path.overrides);
  for (const existingShipments of DATA_SIZES) {
    const interval = profile.shipmentSnapshotIntervalMs;
    const evenlySpaced = Array.from({ length: POINTS_IN_CYCLE }, (_, point) => Math.round(((point + 0.5) * interval) / POINTS_IN_CYCLE));
    // The worst moment: Oracle finishes just after a snapshot starts, so the order waits for the next one.
    const justMissed = Math.max(1_000, interval * Math.ceil(profile.oracleProcessingMs / interval) - profile.oracleProcessingMs + 1_000);
    const results = [];
    for (const offsetMs of [...evenlySpaced, justMissed]) results.push(await measureSnapshotPath(profile, existingShipments, offsetMs));
    const visible = results.map((result) => result.visibleMs);
    const row = {
      path: path.label,
      existingShipments,
      fastestVisibleMin: minutes(Math.min(...visible)),
      slowestVisibleMin: minutes(Math.max(...visible)),
      connectorCallsPerHour: Math.max(...results.map((result) => result.connectorCallsPerHour)),
      rateLimitedCalls: results.reduce((sum, result) => sum + result.rateLimited, 0),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const workflowSize = Number(process.env.MEASURE_WORKFLOW_SIZE ?? 25_000);
const workflow = await measureWorkflow(workflowSize);
const workflowRow = { path: "Workflow, real time", existingShipments: workflowSize, visibleMin: minutes(workflow.visibleMs), oracleCallsForThisOrder: workflow.oracleCalls };
rows.push(workflowRow);
console.log(JSON.stringify(workflowRow));

const dir = join(process.cwd(), "artifacts/baseline/latest");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "gap-measurements.json"), JSON.stringify({ profile: devEstimateProfile(), pointsInCycle: POINTS_IN_CYCLE, stepMs: STEP_MS, rows }, null, 2));
console.log("Saved artifacts/baseline/latest/gap-measurements.json. Times use an estimated profile.");
process.exit(0);
