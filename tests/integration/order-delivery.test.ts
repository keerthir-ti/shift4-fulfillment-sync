/**
 * The delivery workflow end to end: real Temporal dev server, real worker, the HTTP simulators.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { approveOrder, createOrder } from "../../apps/web/lib/flow.js";
import { createSyncHooks } from "../../apps/web/lib/fulfillment-sync.js";
import { readFulfillment, readOrders } from "../../apps/web/lib/reads.js";
import { acceleratedProfile, type OracleShipment, type Profile } from "../../packages/contracts/src/index.js";
import { createActivities, type ActivityDeps } from "../../packages/order-delivery/src/activities.js";
import {
  AUDIT_SCHEDULE_ID,
  connectTemporal,
  createRecoveryStarter,
  describeOrderDelivery,
  ensureAuditSchedule,
  ensureRecoverySchedule,
  requestCheckNow,
  RECOVERY_SCHEDULE_ID,
  startOrderDelivery,
  workflowIdFor,
} from "../../packages/order-delivery/src/client.js";
import { explainOrderDelivery } from "../../packages/order-delivery/src/explain.js";
import { DELIVERY_OVERDUE, DELIVERY_STAGE, SOURCE_ORDER_NUMBER } from "../../packages/order-delivery/src/search-attributes.js";
import { createHttpFoundryStore, createHttpOracleReader, createHttpRecoveryIndex, SystemHttpError } from "../../packages/order-delivery/src/system-adapters.js";
import type { DeliverySettings } from "../../packages/order-delivery/src/types.js";
import { createDeliveryWorkers, WORKFLOWS_PATH } from "../../packages/order-delivery/src/worker.js";
import { send, startWallClockStack } from "../helpers/stack.js";
import { quietLogger, temporalCli } from "../helpers/temporal.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
const NEVER_MS = 3_600_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let stack: Awaited<ReturnType<typeof startWallClockStack>>;

const fast = (over: Partial<DeliverySettings> = {}): DeliverySettings => ({
  pollInitialMs: 50,
  pollBackoff: 1,
  pollMaxMs: 50,
  overdueAfterMs: 60_000,
  deadlineMs: 20_000,
  reconcileWindowMs: 20_000,
  attemptTimeoutMs: 5_000,
  orderRefreshEvery: 2,
  maxReconcilePasses: 4,
  verifyDelayMs: 50,
  settleWatchMs: 0,
  ...over,
});

async function useStack(profile: Partial<Profile> = {}, scenarioPaths: string[] = []) {
  stack = await startWallClockStack({ scenarioPaths, profile: acceleratedProfile({ oracleProcessingMs: 200, snapshotIntervalMs: NEVER_MS, extractionMs: 50, indexingMs: 50, ...profile }) });
  process.env.ORACLE_URL = stack.oracle.url;
  process.env.FOUNDRY_URL = stack.foundry.url;
  process.env.CONNECTOR_URL = stack.connector.url;
}

const gateways = (): ActivityDeps => ({ oracle: createHttpOracleReader({ baseUrl: stack.oracle.url }), foundry: createHttpFoundryStore({ baseUrl: stack.foundry.url }) });
const recoveryFor = (taskQueue: string, maxRuns = 5) => ({ index: createHttpRecoveryIndex({ baseUrl: stack.foundry.url }), ...createRecoveryStarter(env.client, taskQueue, fast(), maxRuns) });

async function withWorker<T>(deps: ActivityDeps, run: (taskQueue: string) => Promise<T>): Promise<T> {
  const taskQueue = `tq-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: createActivities(deps) });
  return worker.runUntil(run(taskQueue));
}

async function draft(quantity = 2, productNumber = "POS-ACC") {
  const sourceTransactionNumber = `src-${randomUUID().slice(0, 8)}`;
  const created = await createOrder({ buyingPartyName: "Synthetic Merchant Ltd", organizationCode: "WH-DUB", productNumber, quantity, sourceTransactionNumber });
  if (!created.ok) throw new Error(created.message);
  return { orderKey: sourceTransactionNumber, headerId: created.headerId, orderNumber: created.orderNumber };
}

/** A second line on a draft, before it is submitted. */
const addLine = (headerId: string) =>
  send(`${stack.oracle.url}${PREFIX}/salesOrders/${headerId}/child/lines`, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 1 }) });
const submitInOracle = (headerId: string) => send(`${stack.oracle.url}${PREFIX}/salesOrders/${headerId}/action/submit`, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) });

const hooksFor = (taskQueue: string, settings = fast()) => createSyncHooks({ client: async () => env.client, taskQueue, settings });
const downHooks = () => createSyncHooks({ client: async () => { throw new Error("Temporal down"); }, taskQueue: "unused", settings: fast() });
const result = (orderKey: string) => env.client.workflow.getHandle(workflowIdFor(orderKey)).result();
const foundryLines = async (orderNumber: string) => ((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items as { properties: Record<string, unknown> }[]).filter((row) => row.properties.OrderNumber === orderNumber);
const warehouseView = async (orderNumber: string) => (await readFulfillment()).orders.filter((order) => order.orderNumber === orderNumber);
const syncStatus = async (orderNumber: string) => (await readOrders()).items.find((row: { properties: { orderNumber: string } }) => row.properties.orderNumber === orderNumber)?.properties.fulfillmentSync;
const oracleRows = async (orderNumber: string) => (await send(`${stack.oracle.url}${PREFIX}/shipmentLines?orderNumber=${orderNumber}`)).body.items as OracleShipment[];
const sim = (path: string, body: unknown) => send(`${path}`, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: "existing-path", path: temporalCli() }, searchAttributes: [SOURCE_ORDER_NUMBER, DELIVERY_STAGE, DELIVERY_OVERDUE] } });
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quietLogger });
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});
beforeEach(async () => {
  await useStack();
});
afterEach(async () => {
  stack.clock.clear();
  await stack.stop();
});

describe("normal flow", () => {
  it("delivers from the approve action before any snapshot, and confirms it", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      expect(await approveOrder(order, hooksFor(taskQueue))).toMatchObject({ ok: true });
      const final = await result(order.orderKey);
      expect(final).toMatchObject({ status: "DeliveryVerified", linesVerified: 1, reconcilePasses: 2, wentOverdue: false });
      expect(final.stages).toEqual(["AwaitingSubmittedOrder", "AwaitingShipmentCoverage", "Reconciling", "DeliveryVerified"]);
      expect(await foundryLines(order.orderNumber)).toHaveLength(1);
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "DeliveryVerified" });
      expect(await warehouseView(order.orderNumber)).toEqual([expect.objectContaining({ orderNumber: order.orderNumber, warehouse: "WH-DUB", status: "Ready to Release", lineCount: 1, activeQuantity: 2 })]);
      expect(final.timings.awaitingOracleMs).toBeGreaterThan(0);
      expect(final.timings.totalMs).toBeGreaterThanOrEqual(final.timings.awaitingOracleMs!);
    });
  });

  it("isn't delivered until the fulfillment order the warehouse reads exists and is correct", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realWrite = deps.foundry.writeFulfillment;
    let firstWrite = true;
    // The first write reaches the lines but not the fulfillment order, like an action that only did half its job.
    deps.foundry.writeFulfillment = async (data) => {
      if (!firstWrite) return realWrite(data);
      firstWrite = false;
      return realWrite({ lines: data.lines, orders: [] });
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", reconcilePasses: 3 });
    });
    expect(await warehouseView(order.orderNumber)).toHaveLength(1);
  });

  it("keeps the fulfillment order's status right when Oracle moves a line on", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      const [row] = await oracleRows(order.orderNumber);
      await sim(`${stack.oracle.url}/lab/shipments/${row.ShipmentLine}`, { lineStatus: "Staged" });
      await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "audit", settings: fast() }, taskQueue)).result();
      expect((await warehouseView(order.orderNumber))[0]).toMatchObject({ status: "Staged" });
    });
  });

  it("accepts an order key that carries source system and ID", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const orderKey = `ORDERHUB:${randomUUID().slice(0, 8)}`;
      const created = await createOrder({ buyingPartyName: "Synthetic Merchant Ltd", organizationCode: "WH-DUB", productNumber: "POS-ACC", quantity: 1, sourceTransactionNumber: orderKey });
      if (!created.ok) throw new Error(created.message);
      await approveOrder({ headerId: created.headerId, orderNumber: created.orderNumber }, hooksFor(taskQueue));
      expect(await result(orderKey)).toMatchObject({ status: "DeliveryVerified", orderKey });
    });
  });

  it("shows live status and a summary in the Temporal UI", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await sleep(500);
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      const metadata = await handle.query<{ currentDetails?: string }>("__temporal_workflow_metadata");
      expect(metadata.currentDetails).toContain("AwaitingShipmentCoverage");
      expect(await (await handle.describe()).staticSummary()).toContain(order.orderKey);
      await handle.terminate();
    });
  });

  it("writes split quantities together, only when complete", async () => {
    stack.clock.clear();
    await stack.stop();
    await useStack({}, [`${process.cwd()}/fixtures/scenarios/staggered.json`]);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft(4, "POS-SPLIT");
      await approveOrder(order, hooksFor(taskQueue));
      await sleep(6_500);
      expect(await oracleRows(order.orderNumber)).toHaveLength(1);
      expect(await foundryLines(order.orderNumber)).toEqual([]);
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified", linesVerified: 2 });
      expect(await foundryLines(order.orderNumber)).toHaveLength(2);
    });
  });

  it("does not change the flow when no hooks are configured", async () => {
    const order = await draft();
    expect(await approveOrder(order)).toMatchObject({ ok: true });
    await sleep(600);
    expect(await oracleRows(order.orderNumber)).toHaveLength(1);
    expect(await foundryLines(order.orderNumber)).toEqual([]);
  });
});

describe("starting the workflow", () => {
  it("scenario 1: boundary check passes, so the trigger and worker need no simulator", () => {
    expect(execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-boundaries.ts"]).toString()).toContain("boundary check passed");
  });

  it("scenario 2: approving again starts it when the first start failed", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      expect(await approveOrder(order, downHooks())).toMatchObject({ ok: true });
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "NotStarted" });
      await approveOrder(order, hooksFor(taskQueue));
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
  });

  it("gives up quickly on an unreachable Temporal, so approval isn't stalled", async () => {
    const hooks = createSyncHooks({ client: () => connectTemporal({ address: "127.0.0.1:59999" }), taskQueue: "unused", settings: fast() });
    const order = await draft();
    const started = Date.now();
    expect(await approveOrder(order, hooks)).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "NotStarted" });
  });

  it("still delivers when the Foundry mirror fails after the Oracle submit", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await sim(`${stack.foundry.url}/lab/faults`, { mode: "validation" });
      expect(await approveOrder(order, hooksFor(taskQueue))).toMatchObject({ ok: false });
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
  });

  it("still delivers when Oracle's submit response is lost", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await sim(`${stack.oracle.url}/lab/faults`, { mode: "lose-response" });
      expect(await approveOrder(order, hooksFor(taskQueue))).toMatchObject({ ok: false, outcome: "uncertain" });
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
  });

  it("still delivers when the submit fails with a network error after Oracle accepted it", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const response = await realFetch(url, init);
        if (String(url).includes("/action/submit")) throw new TypeError("socket hang up");
        return response;
      };
      try {
        expect(await approveOrder(order, hooksFor(taskQueue))).toMatchObject({ ok: false, outcome: "uncertain" });
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
  });

  it("does not claim success when the submit never reached Oracle", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      const handle = await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "uncertain", settings: fast({ deadlineMs: 2_500 }) }, taskQueue);
      const final = await handle.result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("not submitted");
    });
  });

  it("attaches a double click to the same run", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      const first = (await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).describe()).runId;
      await approveOrder(order, hooksFor(taskQueue));
      expect((await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).describe()).runId).toBe(first);
      await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).terminate();
    });
  });
});

async function useStackWith(oracleProcessingMs: number) {
  stack.clock.clear();
  await stack.stop();
  await useStack({ oracleProcessingMs });
}

describe("recovery sweep", () => {
  it("scenario 3: delivers an approved order whose workflow never started, then finds nothing", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, downHooks());
      const activities = createActivities({ ...gateways(), recovery: recoveryFor(taskQueue) });
      expect(await activities.sweepMissedOrders({ lookbackMs: NEVER_MS, limit: 10 })).toMatchObject({ checked: 1, started: 1 });
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
      expect(await activities.sweepMissedOrders({ lookbackMs: NEVER_MS, limit: 10 })).toMatchObject({ checked: 0, started: 0 });
    });
  });

  it("runs from a real Temporal Schedule", async () => {
    const taskQueue = `tq-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: bundle,
      activities: createActivities({ ...gateways(), recovery: recoveryFor(taskQueue) }),
    });
    await worker.runUntil(async () => {
      const order = await draft();
      await approveOrder(order, downHooks());
      await ensureRecoverySchedule(env.client, { taskQueue, everyMs: NEVER_MS, input: { lookbackMs: NEVER_MS, limit: 10, settings: fast() } });
      await ensureRecoverySchedule(env.client, { taskQueue, everyMs: NEVER_MS * 2, input: { lookbackMs: NEVER_MS, limit: 10, settings: fast() } });
      const schedule = env.client.schedule.getHandle(RECOVERY_SCHEDULE_ID);
      expect((await schedule.describe()).spec.intervals?.[0].every).toBe(NEVER_MS * 2);
      await schedule.trigger();
      for (let waited = 0; waited < 10_000 && !(await describeOrderDelivery(env.client, order.orderKey)); waited += 100) await sleep(100);
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
      await schedule.delete();
    });
  });

  it("the audit corrects drift on a delivered order, and leaves matching orders unchanged", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      const firstRun = (await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).describe()).runId;
      const [row] = await oracleRows(order.orderNumber);
      await sim(`${stack.oracle.url}/lab/shipments/${row.ShipmentLine}`, { lineStatus: "Staged" });
      const activities = createActivities({ ...gateways(), recovery: recoveryFor(taskQueue) });
      expect(await activities.auditDeliveredOrders({ lookbackMs: NEVER_MS, limit: 10 })).toMatchObject({ checked: 1, rechecking: 1, failed: 0 });
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      expect((await handle.describe()).runId).not.toBe(firstRun);
      expect(await handle.result()).toMatchObject({ status: "DeliveryVerified", reconcilePasses: 2 });
      expect((await foundryLines(order.orderNumber))[0].properties.LineStatus).toBe("Staged");
      expect((await warehouseView(order.orderNumber))[0]).toMatchObject({ status: "Staged" });
    });
  });

  it("runs the audit from a real Temporal Schedule", async () => {
    const taskQueue = `tq-${randomUUID()}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: createActivities({ ...gateways(), recovery: recoveryFor(taskQueue) }) });
    await worker.runUntil(async () => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      const firstRun = (await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).describe()).runId;
      await ensureAuditSchedule(env.client, { taskQueue, everyMs: NEVER_MS, input: { lookbackMs: NEVER_MS, limit: 10, settings: fast() } });
      const schedule = env.client.schedule.getHandle(AUDIT_SCHEDULE_ID);
      await schedule.trigger();
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      for (let waited = 0; waited < 10_000 && (await handle.describe()).runId === firstRun; waited += 100) await sleep(100);
      expect((await handle.describe()).runId).not.toBe(firstRun);
      expect(await handle.result()).toMatchObject({ status: "DeliveryVerified" });
      await schedule.delete();
    });
  });

  it("stops restarting an order after its limit, and never restarts a delivered one", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const delivered = await draft();
      await approveOrder(delivered, hooksFor(taskQueue));
      await result(delivered.orderKey);
      const failing = await draft();
      await approveOrder(failing, hooksFor(taskQueue, fast({ deadlineMs: 100 })));
      await sim(`${stack.oracle.url}/lab/orders/${failing.headerId}/cancel`, {}).catch(() => undefined);
      await result(failing.orderKey).catch(() => undefined);
      await sleep(1_500);
      const index = createHttpRecoveryIndex({ baseUrl: stack.foundry.url });
      expect(await index.listOrdersNeedingDelivery({ since: 0, limit: 10 })).not.toContain(delivered.orderKey);
      const starter = createRecoveryStarter(env.client, taskQueue, fast(), 1);
      expect(await starter.start(failing.orderKey)).toBe("capped");
    });
  });

  it("leaves a running workflow and a cancelled order alone", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      const activities = createActivities({ ...gateways(), recovery: recoveryFor(taskQueue) });
      expect(await activities.sweepMissedOrders({ lookbackMs: NEVER_MS, limit: 10 })).toMatchObject({ started: 0, running: 1 });
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      await handle.cancel();
      await handle.result().catch(() => undefined);
      expect(await activities.sweepMissedOrders({ lookbackMs: NEVER_MS, limit: 10 })).toMatchObject({ started: 0 });
    });
  });
});

describe("reconciling", () => {
  it("scenario 4: handles Oracle changing a line that reaches Foundry first", async () => {
    const order = await draft();
    await addLine(order.headerId);
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realRead = deps.oracle.listShipmentLines;
    let raced = false;
    deps.oracle.listShipmentLines = async (orderNumber) => {
      const rows = await realRead(orderNumber);
      if (!raced && rows.length === 2) {
        raced = true;
        // After the workflow's read, line 1 changes in Oracle and the newer version reaches Foundry first.
        await sleep(5);
        await sim(`${stack.oracle.url}/lab/shipments/${rows[0].ShipmentLine}`, { lineStatus: "Staged" });
        const [changed] = await oracleRows(orderNumber);
        await deps.foundry.writeFulfillment({ lines: [changed], orders: [] });
      }
      return rows;
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", linesVerified: 2 });
    });
    expect(await foundryLines(order.orderNumber)).toHaveLength(2);
  });

  it("scenario 5: Oracle changing between read and write doesn't leave old values", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realWrite = deps.foundry.writeFulfillment;
    let changed = false;
    deps.foundry.writeFulfillment = async (data) => {
      if (!changed) {
        changed = true;
        await sleep(5);
        await sim(`${stack.oracle.url}/lab/shipments/${data.lines[0].ShipmentLine}`, { lineStatus: "Staged" });
      }
      return realWrite(data);
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", reconcilePasses: 3 });
    });
    expect((await foundryLines(order.orderNumber))[0].properties.LineStatus).toBe("Staged");
  });

  it("recognises a write whose response was lost, and doesn't write it twice", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realWrite = deps.foundry.writeFulfillment;
    let attempts = 0;
    deps.foundry.writeFulfillment = async (data) => {
      attempts += 1;
      await realWrite(data);
      throw new SystemHttpError("foundry", 0, "response lost after the write");
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", reconcilePasses: 1 });
    });
    expect(attempts).toBe(1);
    expect(await foundryLines(order.orderNumber)).toHaveLength(1);
  });

  it("removes a row from Foundry that Oracle no longer has, and a later snapshot doesn't bring it back", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const [real] = await oracleRows(order.orderNumber);
    const deps = gateways();
    await deps.foundry.writeFulfillment({ lines: [{ ...real, ShipmentLine: "gone-from-oracle" }], orders: [] });
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", linesVerified: 1 });
    });
    expect((await foundryLines(order.orderNumber)).map((row) => row.properties.ShipmentLine)).toEqual([real.ShipmentLine]);
  });

  it("catches an Oracle change made just after delivery, during the settle watch", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    await withWorker(gateways(), async (taskQueue) => {
      const handle = await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast({ settleWatchMs: 1_500 }) }, taskQueue);
      for (let waited = 0; waited < 8_000 && (await syncStatus(order.orderNumber))?.stage !== "DeliveryVerified"; waited += 50) await sleep(50);
      const [row] = await oracleRows(order.orderNumber);
      await sim(`${stack.oracle.url}/lab/shipments/${row.ShipmentLine}`, { lineStatus: "Staged" });
      expect(await handle.result()).toMatchObject({ status: "DeliveryVerified" });
    });
    expect((await foundryLines(order.orderNumber))[0].properties.LineStatus).toBe("Staged");
  });

  it("does not report delivery when a line is added after the first read", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realWrite = deps.foundry.writeFulfillment;
    deps.foundry.writeFulfillment = async (data) => {
      await addLine(order.headerId);
      return realWrite(data);
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast({ reconcileWindowMs: 2_500 }) }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("found quantity 2 of 3");
    });
  });

  it("reads every page of a long order", async () => {
    const order = await draft();
    await addLine(order.headerId);
    await addLine(order.headerId);
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = { ...gateways(), oracle: createHttpOracleReader({ baseUrl: stack.oracle.url, pageSize: 1 }) };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", linesVerified: 3 });
    });
  });

  it("reports ActionRequired, not delivered, if Foundry never matches", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    deps.foundry.readFulfillment = async () => ({ lines: [], orders: [] });
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast({ maxReconcilePasses: 2 }) }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("1 missing");
    });
  });

  it("scenario 6: delivers an order that ships from two warehouses", async () => {
    const order = await draft();
    await addLine(order.headerId);
    await submitInOracle(order.headerId);
    await sleep(500);
    const rows = await oracleRows(order.orderNumber);
    await sim(`${stack.oracle.url}/lab/shipments/${rows[1].ShipmentLine}`, { organizationCode: "WH-EAST" });
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast({ deadlineMs: 4_000 }) }, taskQueue)).result();
      expect(final).toMatchObject({ status: "DeliveryVerified", linesVerified: 2 });
    });
    const warehouses = (await foundryLines(order.orderNumber)).map((row: { properties: Record<string, unknown> }) => row.properties.RequestedFulfillmentOrganizationCode);
    expect(new Set(warehouses)).toEqual(new Set(["WH-DUB", "WH-EAST"]));
  });
});

describe("cancellation", () => {
  it("scenario 7: stops early when the order is canceled in Oracle while waiting", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue, fast({ deadlineMs: 20_000 })));
      const started = Date.now();
      await sleep(300);
      await sim(`${stack.oracle.url}/lab/orders/${order.headerId}/cancel`, {});
      expect(await result(order.orderKey)).toMatchObject({ status: "CanceledInOracle" });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "CanceledInOracle" });
    });
  });

  it("finishes immediately when the order was already canceled", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sim(`${stack.oracle.url}/lab/orders/${order.headerId}/cancel`, {});
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final).toMatchObject({ status: "CanceledInOracle" });
    });
  });

  it("ends as canceled, not delivered, when the order is canceled just before reconciling", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realList = deps.oracle.listShipmentLines;
    let canceled = false;
    deps.oracle.listShipmentLines = async (orderNumber) => {
      const rows = await realList(orderNumber);
      if (!canceled) {
        canceled = true;
        await sim(`${stack.oracle.url}/lab/orders/${order.headerId}/cancel`, {});
      }
      return rows;
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("CanceledInOracle");
    });
  });

  it("scenario 8: an operator cancel is reported as cancelled and recorded", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      await sleep(500);
      await handle.cancel();
      await handle.result().catch(() => undefined);
      expect((await handle.describe()).status.name).toBe("CANCELLED");
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "OperatorStopped" });
    });
  });
});

describe("settle watch", () => {
  it("doesn't report delivery if Foundry still differs after the watch", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    const realRead = deps.foundry.readFulfillment;
    let verified = false;
    deps.foundry.recordDeliveryStatus = async (entry) => {
      if (entry.stage === "DeliveryVerified") verified = true;
    };
    deps.foundry.readFulfillment = async (orderNumber) => (verified ? { lines: [], orders: [] } : realRead(orderNumber));
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast({ settleWatchMs: 300 }) }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("1 missing");
    });
  });
});

describe("Oracle events", () => {
  it("wakes a waiting workflow, so it checks at once instead of waiting out the backoff", async () => {
    await useStackWith(500);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      const slow = fast({ pollInitialMs: 60_000, pollMaxMs: 60_000, deadlineMs: 600_000 });
      const started = Date.now();
      const handle = await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: slow }, taskQueue);
      await submitInOracle(order.headerId);
      await sleep(1_500);
      await requestCheckNow(env.client, { orderKey: order.orderKey, settings: slow }, taskQueue);
      await sleep(300);
      await requestCheckNow(env.client, { orderKey: order.orderKey, settings: slow }, taskQueue);
      expect(await handle.result()).toMatchObject({ status: "DeliveryVerified" });
      expect(Date.now() - started).toBeLessThan(20_000);
    });
  });

  it("starts the workflow if approval missed it", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await submitInOracle(order.headerId);
      await sleep(500);
      await requestCheckNow(env.client, { orderKey: order.orderKey, settings: fast() }, taskQueue);
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
  });
});

describe("explaining an order", () => {
  const explain = (orderKey: string) => explainOrderDelivery({ orderKey, ...gateways(), client: env.client });

  it("answers for each situation, without opening Oracle by hand", async () => {
    expect((await explain("never-seen")).summary).toContain("no order");
    const order = await draft();
    expect((await explain(order.orderKey)).summary).toContain("isn't submitted");
    await submitInOracle(order.headerId);
    expect(await explain(order.orderKey)).toMatchObject({ oracle: { expectedQuantity: 2, coveredQuantity: 0 } });
    await sleep(500);
    expect((await explain(order.orderKey)).summary).toContain("doesn't match");
    await withWorker(gateways(), async (taskQueue) => {
      await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
    });
    expect(await explain(order.orderKey)).toMatchObject({ foundry: { matchesOracle: true }, nextAction: "None." });
  });
});

describe("failures", () => {
  it("scenario 9: rides out a Foundry outage", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    await sim(`${stack.foundry.url}/lab/faults`, { mode: "outage", status: 503, forMs: 3_000 });
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("DeliveryVerified");
    });
  });

  it("scenario 10: holds all polling to one shared Oracle rate limit", async () => {
    await useStackWith(NEVER_MS);
    const LIMIT = 5;
    const orders = [];
    for (let index = 0; index < 30; index += 1) {
      const order = await draft();
      await submitInOracle(order.headerId);
      orders.push(order);
    }
    const deps = gateways();
    const calls: number[] = [];
    const realRead = deps.oracle.listShipmentLines;
    deps.oracle.listShipmentLines = async (orderNumber) => {
      calls.push(Date.now());
      return realRead(orderNumber);
    };
    const taskQueue = `tq-${randomUUID()}`;
    const oracleTaskQueue = `${taskQueue}-oracle`;
    const workers = await createDeliveryWorkers({ connection: env.nativeConnection, taskQueue, oracleTaskQueue, oracleActivitiesPerSecond: LIMIT, activities: createActivities(deps), workflowBundle: bundle });
    const running = workers.run();
    const settings = fast({ oracleTaskQueue, orderRefreshEvery: 0 });
    const handles = await Promise.all(orders.map((order) => startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings }, taskQueue)));
    await sleep(3_000);
    calls.length = 0;
    await sleep(3_000);
    const perSecond = calls.length / 3;
    await Promise.all(handles.map((handle) => handle.terminate()));
    workers.shutdown();
    await running;
    expect(perSecond).toBeGreaterThan(0);
    expect(perSecond).toBeLessThanOrEqual(LIMIT * 1.5);
  });

  it("scenario 11: flags an overdue order, keeps its stage and polling, then still delivers", async () => {
    await useStackWith(3_000);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue, fast({ overdueAfterMs: 500 })));
      await sleep(1_500);
      expect(await describeOrderDelivery(env.client, order.orderKey)).toMatchObject({ status: "RUNNING", stage: "AwaitingShipmentCoverage", overdue: true });
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "Overdue" });
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified", wentOverdue: true });
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "DeliveryVerified" });
    });
  });

  it("ends in ActionRequired with the reason when lines never appear", async () => {
    await useStackWith(NEVER_MS);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue, fast({ deadlineMs: 2_500 })));
      const final = await result(order.orderKey);
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("found quantity 0 of 2");
      expect(await syncStatus(order.orderNumber)).toMatchObject({ stage: "ActionRequired" });
    });
  });

  it("honors Retry-After on a 429, and recovers from a 503", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    await sim(`${stack.oracle.url}/lab/faults`, { mode: "status", status: 429, retryAfterSec: 2, pathIncludes: "shipmentLines" });
    await sim(`${stack.oracle.url}/lab/faults`, { mode: "status", status: 503, pathIncludes: "shipmentLines" });
    const started = Date.now();
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("DeliveryVerified");
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  });

  it("does not retry a rejected Oracle request", async () => {
    const deps = gateways();
    let calls = 0;
    const realFind = deps.oracle.findOrder;
    deps.oracle.findOrder = async (key) => {
      calls += 1;
      await send(`${stack.oracle.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "status", status: 400, pathIncludes: "salesOrders" }) });
      return realFind(key);
    };
    const order = await draft();
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("400");
    });
    expect(calls).toBe(1);
  });

  it("keeps retrying through expired credentials, so one bad token doesn't fail every open order", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    await sim(`${stack.oracle.url}/lab/faults`, { mode: "status", status: 401, pathIncludes: "salesOrders" });
    await sim(`${stack.foundry.url}/lab/faults`, { mode: "outage", status: 403, forMs: 1_000 });
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("DeliveryVerified");
    });
  });

  it("retries a Foundry stale-object conflict, which a fresh read resolves", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    await sim(`${stack.foundry.url}/lab/faults`, { mode: "outage", status: 409, forMs: 1_000 });
    await withWorker(gateways(), async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("DeliveryVerified");
    });
  });

  it("stops at once on an unexpected error such as a bad date, rather than looking like a long wait", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    let reads = 0;
    deps.foundry.readFulfillment = async () => {
      reads += 1;
      throw new TypeError("Not a usable timestamp: yesterday");
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
      expect(final.reason).toContain("usable timestamp");
    });
    expect(reads).toBe(1);
  });

  it("tells the user Oracle is busy on a 429, and doesn't start a workflow", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await sim(`${stack.oracle.url}/lab/faults`, { mode: "status", status: 429, retryAfterSec: 1, pathIncludes: "action/submit" });
      expect(await approveOrder(order, hooksFor(taskQueue))).toMatchObject({ ok: false, outcome: "busy" });
      expect(await describeOrderDelivery(env.client, order.orderKey)).toBeNull();
    });
  });

  it("does not retry a rejected Foundry write", async () => {
    const order = await draft();
    await submitInOracle(order.headerId);
    await sleep(500);
    const deps = gateways();
    let writes = 0;
    const realWrite = deps.foundry.writeFulfillment;
    deps.foundry.writeFulfillment = async (data) => {
      writes += 1;
      await sim(`${stack.foundry.url}/lab/faults`, { mode: "validation" });
      return realWrite(data);
    };
    await withWorker(deps, async (taskQueue) => {
      const final = await (await startOrderDelivery(env.client, { orderKey: order.orderKey, trigger: "approved", settings: fast() }, taskQueue)).result();
      expect(final.status).toBe("ActionRequired");
    });
    expect(writes).toBe(1);
  });

  it("survives a worker restart while waiting, with no duplicates", async () => {
    await useStackWith(2_000);
    const order = await draft();
    const taskQueue = `tq-${randomUUID()}`;
    const makeWorker = () => Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: createActivities(gateways()) });
    const first = await makeWorker();
    const running = first.run();
    await approveOrder(order, hooksFor(taskQueue));
    await sleep(500);
    first.shutdown();
    await running;
    await sleep(2_000);
    expect(await foundryLines(order.orderNumber)).toEqual([]);
    const second = await makeWorker();
    await second.runUntil(async () => {
      expect(await result(order.orderKey)).toMatchObject({ status: "DeliveryVerified" });
    });
    expect(await foundryLines(order.orderNumber)).toHaveLength(1);
  });
});

describe("with the snapshot", () => {
  it("reconciles onto the same row, with Foundry-only fields kept", async () => {
    stack.clock.clear();
    await stack.stop();
    await useStack({ snapshotIntervalMs: 4_000 });
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      await sim(`${stack.foundry.url}/api/v2/ontologies/local/actions/set-warehouse-lock/apply`, { parameters: { orderNumber: order.orderNumber, locked: true } });
      await sleep(5_000);
      expect(await foundryLines(order.orderNumber)).toHaveLength(1);
      const sales = (await readOrders()).items.find((row: { properties: { orderNumber: string } }) => row.properties.orderNumber === order.orderNumber);
      expect(sales.properties).toMatchObject({ fulfillmentLock: true, fulfillmentSync: { stage: "DeliveryVerified" } });
    });
  });
});

describe("Foundry-only fields", () => {
  it("survive re-approving, and a repeated note adds nothing to the feed", async () => {
    const order = await draft();
    await approveOrder(order, {});
    const action = (name: string, parameters: unknown) => sim(`${stack.foundry.url}/api/v2/ontologies/local/actions/${name}/apply`, { parameters });
    const note = { orderNumber: order.orderNumber, stage: "DeliveryVerified", message: "Confirmed." };
    await action("record-fulfillment-sync", note);
    await action("record-fulfillment-sync", note);
    await action("set-warehouse-lock", { orderNumber: order.orderNumber, locked: true });
    await approveOrder(order, {});
    const sales = (await readOrders()).items.find((row: { properties: { orderNumber: string } }) => row.properties.orderNumber === order.orderNumber).properties;
    expect(sales).toMatchObject({ fulfillmentLock: true, fulfillmentSync: { stage: "DeliveryVerified" } });
    expect(sales.activity.filter((entry: { action: string }) => entry.action === "fulfillment-sync:DeliveryVerified")).toHaveLength(1);
  });
});

describe("data in Temporal", () => {
  it("keeps customer names and shipment rows out of workflow history", async () => {
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      const history = await env.client.workflow.getHandle(workflowIdFor(order.orderKey)).fetchHistory();
      const payloads = (history.events ?? []).flatMap((event) => [event.activityTaskScheduledEventAttributes?.input, event.activityTaskCompletedEventAttributes?.result]).flatMap((list) => list?.payloads ?? []);
      expect(payloads.length).toBeGreaterThan(0);
      const text = payloads.map((payload) => Buffer.from(payload.data ?? []).toString("utf8")).join(" ");
      expect(text).toContain(order.orderNumber);
      expect(text).not.toContain("Synthetic Merchant");
      expect(text).not.toContain("BuyingPartyName");
    });
  });
});

describe("safe code changes", () => {
  it("replays a recorded history, and history stays small even after many polls", async () => {
    await useStackWith(2_000);
    await withWorker(gateways(), async (taskQueue) => {
      const order = await draft();
      await approveOrder(order, hooksFor(taskQueue));
      await result(order.orderKey);
      const handle = env.client.workflow.getHandle(workflowIdFor(order.orderKey));
      const history = await handle.fetchHistory();
      expect(history.events!.length).toBeLessThan(80);
      await Worker.runReplayHistory({ workflowBundle: bundle, replayName: "order-delivery" }, history);
    });
  });
});
