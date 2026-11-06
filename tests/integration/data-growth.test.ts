import { afterEach, describe, expect, it } from "vitest";
import { acceleratedProfile, devEstimateProfile, profileByName, type Profile } from "../../packages/contracts/src/index.js";
import { ManualClock } from "../../services/sim/src/lab/clock.js";
import { OracleCallBudget } from "../../services/sim/src/oracle/call-budget.js";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

const growthProfile = (overrides: Partial<Profile> = {}) =>
  acceleratedProfile({
    name: "growth-test",
    oracleProcessingMs: 1_000,
    snapshotIntervalMs: 10_000,
    orderSnapshotIntervalMs: 100_000_000,
    extractionMs: 100,
    indexingMs: 100,
    pageSize: 100,
    oracleMsPerPage: 100,
    extractionMsPerRow: 1,
    indexingMsPerRow: 1,
    ...overrides,
  });

async function createDraft(source: string) {
  const created = await send(`${stack!.oracle.url}${PREFIX}/salesOrders`, {
    method: "POST",
    body: JSON.stringify({ SourceTransactionNumber: source, BuyingPartyName: "Synthetic Merchant Ltd", RequestedFulfillmentOrganizationCode: "WH-DUB", SubmittedFlag: false }),
  });
  return created;
}

async function approveOrder(source: string): Promise<string> {
  const created = await createDraft(source);
  expect(created.status).toBe(201);
  const link = (rel: string) => created.body.links.find((entry: { rel: string }) => entry.rel === rel).href as string;
  expect((await send(link("lines"), { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 2 }) })).status).toBe(201);
  expect((await send(link("submit"), { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) })).status).toBe(200);
  return created.body.OrderNumber as string;
}

async function isVisible(orderNumber: string): Promise<boolean> {
  const rows = await send(`${stack!.foundry.url}/lab/query/ShipmentLine`);
  return rows.body.items.some((row: { properties: { OrderNumber: string } }) => row.properties.OrderNumber === orderNumber);
}

async function advanceUntilVisible(orderNumber: string, limitMs: number): Promise<number> {
  for (let at = stack!.clock.now() + 100; at <= limitMs; at += 100) {
    await stack!.clock.advanceTo(at);
    if (await isVisible(orderNumber)) return at;
  }
  throw new Error(`order ${orderNumber} was not visible by ${limitMs}`);
}

describe("snapshot run time as data grows", () => {
  it("takes longer with more rows, while Oracle processing stays the same", async () => {
    const visibleAt: Record<number, number> = {};
    const readyAfter: Record<number, number> = {};
    for (const existingShipments of [0, 2_000]) {
      stack = await startStack({ profile: growthProfile(), existingShipments });
      await stack.clock.advanceTo(500);
      const orderNumber = await approveOrder(`growth-${existingShipments}`);
      visibleAt[existingShipments] = await advanceUntilVisible(orderNumber, 30_000);
      const ready = stack.oracle.ctx.events.all().find((event) => event.eventType === "oracle.shipment.ready" && event.orderId === orderNumber);
      readyAfter[existingShipments] = ready!.virtualAt - 500;
      await stack.stop();
      stack = undefined;
    }
    expect(readyAfter[2_000]).toBe(readyAfter[0]);
    // 20 extra pages at 100ms, then 2,000 rows at 1ms to copy and 1ms to index.
    expect(visibleAt[2_000] - visibleAt[0]).toBeGreaterThanOrEqual(5_900);
    expect(visibleAt[2_000] - visibleAt[0]).toBeLessThanOrEqual(6_300);
  });

  it("freezes the view at the start, so a row created during a slow read waits for the next run", async () => {
    stack = await startStack({ profile: growthProfile(), existingShipments: 2_000 });
    await stack.clock.advanceTo(9_500);
    const orderNumber = await approveOrder("during-read");
    // Oracle creates the line at 10.5s, while the run that started at 10s is still reading pages.
    await stack.clock.advanceTo(10_600);
    expect((await send(`${stack.oracle.url}${PREFIX}/shipmentLines?orderNumber=${orderNumber}`)).body.items).toHaveLength(1);
    await stack.clock.advanceTo(17_000);
    expect(await isVisible("EXISTING-1")).toBe(true);
    expect(await isVisible(orderNumber)).toBe(false);
    expect(await advanceUntilVisible(orderNumber, 30_000)).toBeGreaterThan(20_000);
  });

  it("queues a run that comes due during a slow one, and commits them in order", async () => {
    stack = await startStack({ profile: growthProfile({ snapshotIntervalMs: 2_000, oracleMsPerPage: 200 }), existingShipments: 2_000 });
    await stack.clock.advanceTo(25_000);
    const events = stack.connector.ctx.events.all();
    expect(events.some((event) => event.eventType === "connector.capture.queued")).toBe(true);
    // capturedAt 0 is the startup load, which models data already in place.
    const committed = events
      .filter((event) => event.eventType === "connector.snapshot.committed" && event.detail?.kind === "shipment-lines" && (event.detail?.capturedAt as number) > 0)
      .map((event) => event.detail?.capturedAt as number);
    expect(committed.length).toBeGreaterThan(1);
    expect(committed).toEqual([...committed].sort((a, b) => a - b));
    // One run reads 20 pages at 200ms (3.8s between the first and last) and copies for 2.1s. The next starts only then.
    expect(committed[1] - committed[0]).toBeGreaterThanOrEqual(5_900);
  });
});

describe("shared Oracle call budget", () => {
  it("refills steadily and says how long to wait", async () => {
    const clock = new ManualClock(0);
    const budget = new OracleCallBudget(60, clock);
    for (let call = 0; call < 60; call += 1) expect(budget.spend()).toBe(0);
    expect(budget.spend()).toBe(1);
    await clock.advanceTo(1_000);
    expect(budget.spend()).toBe(0);
    expect(budget.spend()).toBe(1);
  });

  it("makes a large snapshot wait for budget and still finish, with nothing lost", async () => {
    stack = await startStack({ profile: growthProfile({ oracleCallsPerMinute: 12, snapshotIntervalMs: 1_000_000 }), existingShipments: 2_000 });
    await stack.clock.advanceTo(1_000_000);
    expect(await isVisible("EXISTING-1")).toBe(true);
    await stack.clock.advanceTo(1_002_000);
    const events = stack.connector.ctx.events.all();
    expect(events.some((event) => event.eventType === "connector.capture.rate-limited")).toBe(true);
    expect(events.some((event) => event.eventType === "connector.snapshot.failed")).toBe(false);
    expect(stack.oracle.ctx.rateLimited.every((call) => call.caller === "connector")).toBe(true);
    await stack.clock.advanceTo(1_200_000);
    const committed = stack.connector.ctx.events.all().find((event) => event.eventType === "connector.snapshot.committed" && event.detail?.capturedAt === 1_000_000);
    expect(committed?.detail?.count).toBe(2_000);
    // 20 pages from a budget of 12 that refills one every 5s: about 40s of reading, then 2.1s of copying.
    expect(committed!.virtualAt - 1_000_000).toBeGreaterThanOrEqual(40_000);
    expect(committed!.virtualAt - 1_000_000).toBeLessThan(46_000);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.syncStatus).toBe("ok");
  });

  it("turns the app away with Retry-After when the snapshot has used the budget", async () => {
    stack = await startStack({ profile: growthProfile({ oracleCallsPerMinute: 12, snapshotIntervalMs: 1_000_000 }), existingShipments: 2_000 });
    await stack.clock.advanceTo(1_002_000);
    const response = await fetch(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ SourceTransactionNumber: "turned-away", BuyingPartyName: "Synthetic Merchant Ltd", RequestedFulfillmentOrganizationCode: "WH-DUB", SubmittedFlag: false }),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(stack.oracle.ctx.rateLimited.some((call) => call.caller === "app-or-worker")).toBe(true);
  });
});

describe("dev estimate profile", () => {
  it("uses the client's schedules, and every default stays off for other profiles", () => {
    const profile = profileByName("dev-estimate");
    expect(profile).toEqual(devEstimateProfile());
    expect(profile.shipmentSnapshotIntervalMs).toBe(5 * 60_000);
    expect(profile.orderSnapshotIntervalMs).toBe(15 * 60_000);
    const accelerated = acceleratedProfile();
    expect([accelerated.oracleMsPerPage, accelerated.extractionMsPerRow, accelerated.indexingMsPerRow, accelerated.oracleCallsPerMinute]).toEqual([0, 0, 0, null]);
  });
});
