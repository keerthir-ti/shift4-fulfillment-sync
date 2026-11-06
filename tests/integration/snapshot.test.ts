import { afterEach, describe, expect, it } from "vitest";
import { acceleratedProfile } from "../../packages/contracts/src/index.js";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>>;
afterEach(async () => {
  await stack?.stop();
});

async function submitAccessory(at: number, source: string, quantity = 2) {
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
  expect(created.status).toBe(201);
  const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
  expect((await send(lineHref, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: quantity }) })).status).toBe(201);
  const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
  expect((await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) })).status).toBe(200);
  return created.body.OrderNumber as string;
}

describe("scheduled snapshots", () => {
  it("keeps a capture empty when oracle becomes ready during ingestion", async () => {
    stack = await startStack({
      profile: acceleratedProfile({
        oracleProcessingMs: 500,
        extractionMs: 2_000,
        indexingMs: 500,
        snapshotIntervalMs: 10_000,
      }),
    });
    const captured = await stack.connector.captureSnapshot("shipment-lines", 0);
    expect(captured.ok).toBe(true);
    expect(stack.connector.ctx.store.get(captured.id!)!.rows).toEqual([]);
    await submitAccessory(0, "early");
    await stack.clock.advanceTo(500);
    const live = await send(`${stack.oracle.url}${PREFIX}/shipmentLines`);
    expect(live.body.items.length).toBeGreaterThan(0);
    expect(stack.connector.ctx.store.get(captured.id!)!.rows).toEqual([]);
    await stack.clock.advanceTo(2_000);
    const committed = await send(`${stack.foundry.url}/lab/backing-generations/${captured.id}`);
    expect(committed.body.rows).toEqual([]);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);
    await stack.clock.advanceTo(12_500);
    const visible = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(visible.body.items.length).toBeGreaterThan(0);
  });

  it("does not publish a failed page and recovers on the next scheduled run", async () => {
    stack = await startStack({
      profile: acceleratedProfile({ oracleProcessingMs: 1_000, extractionMs: 100, indexingMs: 100, snapshotIntervalMs: 5_000 }),
    });
    await submitAccessory(0, "faulted");
    await send(`${stack.oracle.url}/lab/faults`, {
      method: "POST",
      body: JSON.stringify({ mode: "status", status: 429, pathIncludes: "shipmentLines" }),
    });
    await stack.clock.advanceTo(5_200);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.syncStatus).toBe("stale");
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toEqual([]);
    await stack.clock.advanceTo(10_300);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items.length).toBeGreaterThan(0);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.syncStatus).toBe("ok");
  });

  it("pages a full shipment extract into foundry", async () => {
    stack = await startStack({
      profile: acceleratedProfile({ oracleProcessingMs: 100, extractionMs: 100, indexingMs: 100, snapshotIntervalMs: 1_000, pageSize: 25 }),
    });
    await stack.clock.advanceTo(0);
    const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SourceTransactionNumber: "thirty",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
        SubmittedFlag: false,
      }),
    });
    const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
    for (let index = 0; index < 30; index += 1) {
      expect((await send(lineHref, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 1 }) })).status).toBe(201);
    }
    const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
    await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) });
    stack.oracle.ctx.requests.length = 0;
    await stack.clock.advanceTo(1_300);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toHaveLength(30);
    expect(stack.oracle.ctx.requests.some((request) => request.url.includes("offset=25"))).toBe(true);
  });
});
