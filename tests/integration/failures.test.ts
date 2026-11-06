import { afterEach, describe, expect, it } from "vitest";
import { acceleratedProfile, salesOrderKey } from "../../packages/contracts/src/index.js";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>>;
afterEach(async () => {
  await stack?.stop();
});

describe("failure modes", () => {
  it("keeps the last good view across 503, injected snapshot failure, and bad validation", async () => {
    stack = await startStack({
      profile: acceleratedProfile({ oracleProcessingMs: 100, extractionMs: 50, indexingMs: 50, snapshotIntervalMs: 1_000 }),
    });
    await stack.clock.advanceTo(0);
    const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SourceTransactionNumber: "keep",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
        SubmittedFlag: false,
      }),
    });
    const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
    await send(lineHref, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 2 }) });
    const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
    await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) });
    await stack.clock.advanceTo(1_200);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toHaveLength(1);

    await send(`${stack.oracle.url}/lab/faults`, {
      method: "POST",
      body: JSON.stringify({ mode: "status", status: 503, pathIncludes: "shipmentLines" }),
    });
    await stack.clock.advanceTo(2_200);
    const during = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(during.body.items).toHaveLength(1);
    expect(during.body.syncStatus).toBe("stale");

    await send(`${stack.connector.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "fail-snapshot" }) });
    await stack.clock.advanceTo(3_200);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items).toHaveLength(1);

    const beforeLock = (await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items.length;
    await send(`${stack.foundry.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "validation" }) });
    const rejected = await send(`${stack.foundry.url}/api/v2/ontologies/local/actions/set-warehouse-lock/apply`, {
      method: "POST",
      body: JSON.stringify({ parameters: { orderNumber: "5001", locked: true } }),
    });
    expect(rejected.status).toBe(400);
    expect((await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items).toHaveLength(beforeLock);
    expect((await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items.some((item: { properties: { fulfillmentLock?: boolean } }) => item.properties.fulfillmentLock)).toBe(false);

    await stack.clock.advanceTo(4_200);
    expect((await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.syncStatus).toBe("ok");
  });

  it("reconciles a lost create response by source identity", async () => {
    stack = await startStack();
    await send(`${stack.oracle.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "lose-response" }) });
    const lost = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SourceTransactionNumber: "lost-1",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
        SubmittedFlag: false,
      }),
    });
    expect(lost.status).toBe(504);
    expect(lost.body.outcome).toBe("uncertain");
    const retry = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SourceTransactionNumber: "lost-1",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
        SubmittedFlag: false,
      }),
    });
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe("reconciled");
    expect(retry.body.HeaderId).toBe(lost.body.headerId);
    expect((await send(`${stack.oracle.url}${PREFIX}/salesOrders`)).body.count).toBe(1);
    expect(salesOrderKey(retry.body.OrderNumber)).toContain(retry.body.OrderNumber);
  });

  it("rejects an ambiguous shipment row without replacing the last indexed generation", async () => {
    stack = await startStack();
    const good = await send(`${stack.foundry.url}/lab/backing-generations`, {
      method: "POST",
      body: JSON.stringify({
        kind: "shipment-lines",
        capturedAt: 1,
        immediate: true,
        objectTypes: ["ShipmentLine"],
        rows: [
          {
            objectType: "ShipmentLine",
            objectKey: "shipment-line:4001",
            sourceTimestamp: 1,
            present: ["ShipmentLine", "OrderNumber", "RequestedFulfillmentOrganizationCode", "SourceOrderFulfillmentLineId", "OrderedQuantity"],
            properties: {
              ShipmentLine: "4001",
              OrderNumber: "5001",
              RequestedFulfillmentOrganizationCode: "WH-DUB",
              SourceOrderFulfillmentLineId: null,
              OrderedQuantity: 2,
            },
          },
        ],
      }),
    });
    expect(good.status).toBe(200);
    const bad = await send(`${stack.foundry.url}/lab/backing-generations`, {
      method: "POST",
      body: JSON.stringify({
        kind: "shipment-lines",
        capturedAt: 2,
        immediate: true,
        objectTypes: ["ShipmentLine"],
        rows: [
          {
            objectType: "ShipmentLine",
            objectKey: "shipment-line:4002",
            sourceTimestamp: 2,
            present: ["ShipmentLine", "SourceOrderFulfillmentLineId"],
            properties: { ShipmentLine: "4002", SourceOrderFulfillmentLineId: null },
          },
        ],
      }),
    });
    expect(bad.status).toBe(422);
    const query = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(query.body.items.map((item: { objectKey: string }) => item.objectKey)).toEqual(["shipment-line:4001"]);
    expect(query.body.syncStatus).toBe("stale");
  });
});
