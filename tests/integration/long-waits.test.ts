/**
 * The real default timings, in seconds of test time: Temporal's time-skipping server jumps over the waits.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { OracleShipment } from "../../packages/contracts/src/index.js";
import { createActivities, type ActivityDeps } from "../../packages/order-delivery/src/activities.js";
import { startOrderDelivery } from "../../packages/order-delivery/src/client.js";
import type { FulfillmentData } from "../../packages/order-delivery/src/system-adapters.js";
import { DEFAULT_DELIVERY_SETTINGS } from "../../packages/order-delivery/src/types.js";
import { WORKFLOWS_PATH } from "../../packages/order-delivery/src/worker.js";
import { quietLogger } from "../helpers/temporal.js";

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

// Temporal's IndexedValueType values.
const KEYWORD = 2;
const BOOL = 5;
const HOUR = 3_600_000;
const line: OracleShipment = { ShipmentLine: "1", OrderNumber: "7001", SourceLineId: "L-1", SourceOrderFulfillmentLineId: null, OrderedQuantity: 2, ProductNumber: "POS-ACC", RequestedFulfillmentOrganizationCode: "WH-DUB", BuyingPartyName: "Synthetic Merchant Ltd", LineStatus: "Ready to Release", LastUpdateDate: 100 };

function fakes(linesReady: () => boolean) {
  const notes: string[] = [];
  const held: FulfillmentData = { lines: [], orders: [] };
  const deps: ActivityDeps = {
    oracle: {
      findOrder: async () => ({ headerId: "H", orderNumber: "7001", submitted: true, status: "Submitted", lines: [{ sourceLineId: "L-1", quantity: 2, status: "Open" }] }),
      listShipmentLines: async () => (linesReady() ? [line] : []),
    },
    foundry: {
      writeFulfillment: async ({ lines, orders }) => {
        held.lines.push(...lines);
        held.orders.push(...orders);
        return { applied: lines.length, skipped: 0 };
      },
      readFulfillment: async () => held,
      removeFulfillment: async () => undefined,
      recordDeliveryStatus: async ({ stage }) => {
        notes.push(stage);
      },
    },
  };
  return { deps, notes };
}

async function run(deps: ActivityDeps, orderKey = `key-${randomUUID()}`) {
  const taskQueue = `tq-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: createActivities(deps) });
  return worker.runUntil(async () => (await startOrderDelivery(env.client, { orderKey, trigger: "approved", settings: DEFAULT_DELIVERY_SETTINGS }, taskQueue)).result());
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  await env.connection.operatorService.addSearchAttributes({
    namespace: env.namespace ?? "default",
    searchAttributes: {
      SourceOrderNumber: KEYWORD,
      DeliveryStage: KEYWORD,
      DeliveryOverdue: BOOL,
    },
  });
  bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: quietLogger });
}, 180_000);
afterAll(async () => {
  await env?.teardown();
});

describe("default timings", () => {
  it("lines that never appear go overdue at 30 minutes, then ActionRequired at 4 hours", async () => {
    const { deps, notes } = fakes(() => false);
    const final = await run(deps);
    expect(final).toMatchObject({ status: "ActionRequired", wentOverdue: true, reconcilePasses: 0 });
    expect(final.reason).toContain("found quantity 0 of 2");
    expect(final.timings.totalMs).toBeGreaterThanOrEqual(3.9 * HOUR);
    expect(notes).toEqual(["Overdue", "ActionRequired"]);
  }, 120_000);

  it("lines arriving after 2 hours are still delivered, flagged overdue, through the settle watch", async () => {
    let started: number | undefined;
    const { deps, notes } = fakes(() => {
      started ??= Date.now();
      return false;
    });
    const skippingClock = deps.oracle.listShipmentLines;
    let polls = 0;
    deps.oracle.listShipmentLines = async (orderNumber) => {
      polls += 1;
      // Past the 60-second cap, about 120 polls is 2 hours.
      return polls > 120 ? [line] : skippingClock(orderNumber);
    };
    const final = await run(deps);
    expect(final).toMatchObject({ status: "DeliveryVerified", wentOverdue: true, linesVerified: 1 });
    expect(final.timings.awaitingOracleMs).toBeGreaterThan(1.5 * HOUR);
    expect(notes).toEqual(["Overdue", "DeliveryVerified"]);
  }, 120_000);
});
