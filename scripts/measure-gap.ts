/**
 * pnpm measure:gap: measures today's path with no Temporal anywhere. It approves orders through the real
 * app flow at evenly spaced points in the snapshot cycle, for each schedule and data size, and records
 * when Oracle had the lines and when Fulfillment Manager could see them.
 *
 * Time is simulated, so a 15-minute wait takes seconds to run. The profile is an estimate, so these
 * results show how the delay behaves and are not Shift4 measurements.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveOrder, createOrder } from "../apps/web/lib/flow.js";
import { devEstimateProfile, type Profile } from "../packages/contracts/src/index.js";
import { send, startStack } from "../tests/helpers/stack.js";

const SCHEDULES = [
  { label: "5 min", shipmentSnapshotIntervalMs: 5 * 60_000 },
  { label: "15 min", shipmentSnapshotIntervalMs: 15 * 60_000 },
];
const DATA_SIZES = (process.env.MEASURE_SIZES ?? "0,1000,25000,100000").split(",").map(Number);
const POINTS_IN_CYCLE = Number(process.env.MEASURE_POINTS ?? 6);
const STEP_MS = 5_000;

type Sample = { approvedAtMs: number; oracleReadyMs: number; visibleMs: number; waitAfterReadyMs: number };

async function measureOne(profile: Profile, existingShipments: number, offsetMs: number) {
  const stack = await startStack({ profile, existingShipments });
  try {
    process.env.ORACLE_URL = stack.oracle.url;
    process.env.FOUNDRY_URL = stack.foundry.url;
    await stack.clock.advanceTo(offsetMs);
    const created = await createOrder({ buyingPartyName: "Synthetic Merchant Ltd", organizationCode: "WH-DUB", productNumber: "POS-ACC", quantity: 2 });
    if (!created.ok) throw new Error(created.message);
    const approved = await approveOrder({ headerId: created.headerId, orderNumber: created.orderNumber }, {});
    if (!approved.ok) throw new Error(approved.message);
    const search = `${stack.foundry.url}/api/v2/ontologies/local/objects/ShipmentLine/search`;
    const where = JSON.stringify({ where: { type: "eq", field: "OrderNumber", value: created.orderNumber } });
    const limit = offsetMs + 3 * profile.shipmentSnapshotIntervalMs + 60 * 60_000;
    for (let at = offsetMs + STEP_MS; at <= limit; at += STEP_MS) {
      await stack.clock.advanceTo(at);
      const found = await send(search, { method: "POST", body: where });
      if (found.body.data?.length) {
        const ready = stack.oracle.ctx.events.all().find((event) => event.eventType === "oracle.shipment.ready" && event.orderId === created.orderNumber);
        const sample: Sample = {
          approvedAtMs: offsetMs,
          oracleReadyMs: ready!.virtualAt - offsetMs,
          visibleMs: at - offsetMs,
          waitAfterReadyMs: at - ready!.virtualAt,
        };
        return { sample, rateLimited: stack.oracle.ctx.rateLimited.length, oracleCalls: stack.oracle.ctx.requests.length };
      }
    }
    throw new Error(`order ${created.orderNumber} was not visible within ${limit}ms`);
  } finally {
    await stack.stop();
  }
}

const minutes = (ms: number) => (ms / 60_000).toFixed(1);
const rows: Record<string, unknown>[] = [];
for (const schedule of SCHEDULES) {
  const profile = devEstimateProfile({ shipmentSnapshotIntervalMs: schedule.shipmentSnapshotIntervalMs });
  for (const existingShipments of DATA_SIZES) {
    const samples: Sample[] = [];
    let rateLimited = 0;
    const evenlySpaced = Array.from({ length: POINTS_IN_CYCLE }, (_, point) => Math.round(((point + 0.5) * schedule.shipmentSnapshotIntervalMs) / POINTS_IN_CYCLE));
    // The worst moment: Oracle finishes just after a snapshot starts, so the order waits for the next one.
    const justMissed = schedule.shipmentSnapshotIntervalMs - profile.oracleProcessingMs + 1_000;
    for (const offsetMs of [...evenlySpaced, justMissed]) {
      const result = await measureOne(profile, existingShipments, offsetMs);
      samples.push(result.sample);
      rateLimited += result.rateLimited;
    }
    const visible = samples.map((sample) => sample.visibleMs);
    const row = {
      schedule: schedule.label,
      existingShipments,
      oracleReadyMin: minutes(samples[0].oracleReadyMs),
      fastestVisibleMin: minutes(Math.min(...visible)),
      slowestVisibleMin: minutes(Math.max(...visible)),
      longestWaitAfterReadyMin: minutes(Math.max(...samples.map((sample) => sample.waitAfterReadyMs))),
      rateLimitedCalls: rateLimited,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const dir = join(process.cwd(), "artifacts/baseline/latest");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "gap-measurements.json"), JSON.stringify({ profile: devEstimateProfile(), pointsInCycle: POINTS_IN_CYCLE, stepMs: STEP_MS, rows }, null, 2));
console.log("Saved artifacts/baseline/latest/gap-measurements.json. Times are simulated, on an estimated profile.");
process.exit(0);
