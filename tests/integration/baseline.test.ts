import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceleratedProfile } from "../../packages/contracts/src/index.js";
import type { LabEvent } from "../../services/sim/src/lab/events.js";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>>;
afterEach(async () => {
  await stack?.stop();
});

async function submitAt(at: number, source: string) {
  await stack.clock.advanceTo(at);
  const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
    method: "POST",
    body: JSON.stringify({
      SourceTransactionNumber: source,
      BuyingPartyName: "Synthetic Merchant Ltd",
      RequestedFulfillmentOrganizationCode: "WH-DUB",
      SubmittedFlag: false,
    }),
  });
  const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
  await send(lineHref, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 2 }) });
  const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
  const submitted = await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) });
  expect(submitted.status).toBe(200);
  return submitted.body.OrderNumber as string;
}

function events(): LabEvent[] {
  return [...stack.oracle.ctx.events.all(), ...stack.connector.ctx.events.all(), ...stack.foundry.ctx.events.all()];
}

describe("baseline gap", () => {
  it("separates oracle readiness from snapshot visibility, including a later approval", async () => {
    stack = await startStack();
    const sightings: { at: number; count: number }[] = [];
    const poll = (at: number) => {
      stack.clock.schedule(at, async () => {
        const body = await (await fetch(`${stack.foundry.url}/lab/query/ShipmentLine`)).json();
        sightings.push({ at: stack.clock.now(), count: body.items.length });
        poll(at + stack.profile.uiRefreshMs);
      });
    };
    poll(stack.profile.uiRefreshMs);

    const first = await submitAt(1_000, "order-a");
    await stack.clock.advanceTo(7_000);
    const oracleEarly = await send(`${stack.oracle.url}${PREFIX}/shipmentLines?orderNumber=${first}`);
    expect(oracleEarly.body.items).toEqual([expect.objectContaining({ ShipmentLine: "4001", OrderedQuantity: 2 })]);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);
    expect(sightings.find((sighting) => sighting.at === 7_000)?.count).toBe(0);

    const second = await submitAt(50_000, "order-b");
    await stack.clock.advanceTo(62_000);
    const backing = await send(`${stack.foundry.url}/lab/backing-generations`);
    const captured = backing.body.items.find((item: { kind: string; capturedAt: number; status: string }) => item.kind === "shipment-lines" && item.capturedAt === 60_000 && item.status === "committed");
    expect(captured).toBeTruthy();
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);

    await stack.clock.advanceTo(64_000);
    const indexed = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(indexed.body.items.map((item: { properties: { OrderNumber: string } }) => item.properties.OrderNumber).sort()).toEqual([first, second].sort());
    const firstSeen = sightings.find((sighting) => sighting.count > 0);
    expect(firstSeen?.at).toBeGreaterThanOrEqual(63_000);
    expect(firstSeen?.at).toBeLessThanOrEqual(64_000);

    const ready = events().filter((event) => event.eventType === "oracle.shipment.ready");
    const frozen = events().find((event) => event.eventType === "connector.capture.frozen" && event.detail?.capturedAt === 60_000 && event.detail?.kind === "shipment-lines");
    const committed = events().find((event) => event.eventType === "connector.snapshot.committed" && event.detail?.capturedAt === 60_000 && event.detail?.kind === "shipment-lines");
    const indexedEvent = events().find((event) => event.eventType === "foundry.indexed" && event.detail?.kind === "shipment-lines" && event.detail?.immediate !== true && event.virtualAt >= 60_000);
    const aReady = ready.find((event) => event.orderId === first)!;
    const bReady = ready.find((event) => event.orderId === second)!;
    expect(aReady.virtualAt - 1_000).toBe(5_000);
    expect(bReady.virtualAt - 50_000).toBe(5_000);
    expect((frozen?.detail?.capturedAt as number) - aReady.virtualAt).toBe(54_000);
    expect((frozen?.detail?.capturedAt as number) - bReady.virtualAt).toBe(5_000);

    const report = {
      profile: stack.profile,
      runtime: process.version,
      orders: {
        [first]: intervals(1_000, aReady.virtualAt, frozen!, committed!, indexedEvent!, firstSeen!.at),
        [second]: intervals(50_000, bReady.virtualAt, frozen!, committed!, indexedEvent!, firstSeen!.at),
      },
      requestCounts: {
        oracle: stack.oracle.ctx.requests.length,
        note: "Connector reads are full paged snapshots. Approval does not copy shipment lines.",
      },
    };
    const dir = join(process.cwd(), "artifacts/baseline/latest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "timings.json"), JSON.stringify(report, null, 2));
  });

  it("a snapshot at t=90 extends the wait without changing five-second oracle processing", async () => {
    stack = await startStack({ profile: acceleratedProfile({ name: "snapshot-at-90s", snapshotIntervalMs: 90_000 }) });
    const orderNumber = await submitAt(1_000, "late-window");
    await stack.clock.advanceTo(7_000);
    expect((await send(`${stack.oracle.url}${PREFIX}/shipmentLines?orderNumber=${orderNumber}`)).body.items).toHaveLength(1);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);
    await stack.clock.advanceTo(60_000);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);
    await stack.clock.advanceTo(93_000);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toHaveLength(1);
    const ready = events().find((event) => event.eventType === "oracle.shipment.ready")!;
    const frozen = events().find((event) => event.eventType === "connector.capture.frozen" && event.detail?.kind === "shipment-lines" && event.detail?.capturedAt === 90_000);
    expect(ready.virtualAt - 1_000).toBe(5_000);
    expect(frozen?.detail?.capturedAt).toBe(90_000);
    const dir = join(process.cwd(), "artifacts/baseline/latest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "timings-90.json"), JSON.stringify({ orderNumber, readyAt: ready.virtualAt, captureAt: 90_000, indexedBy: 93_000, oracleProcessingMs: 5_000 }, null, 2));
  });
});

function intervals(submit: number, readyAt: number, frozen: LabEvent, committed: LabEvent, indexed: LabEvent, browserAt: number) {
  const captureAt = frozen.detail?.capturedAt as number;
  return {
    approvalToOracleReadyMs: readyAt - submit,
    readyToCaptureMs: captureAt - readyAt,
    captureToCommitMs: committed.virtualAt - captureAt,
    commitToIndexMs: indexed.virtualAt - committed.virtualAt,
    indexToBrowserMs: browserAt - indexed.virtualAt,
    submit,
    readyAt,
    captureAt,
    commitAt: committed.virtualAt,
    indexAt: indexed.virtualAt,
    browserAt,
  };
}
