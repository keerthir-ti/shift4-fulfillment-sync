import { afterEach, describe, expect, it } from "vitest";
import { salesOrderKey } from "../../packages/contracts/src/index.js";
import { send, startStack } from "../helpers/stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;
afterEach(async () => {
  await stack?.stop();
});

describe("foundry read model", () => {
  it("shows a mirrored order immediately and hides backing rows until indexing", async () => {
    stack = await startStack();
    const before = stack.foundry.ctx.store.listIndexed("SalesOrder").length;
    const invalid = await send(`${stack.foundry.url}/api/v2/ontologies/local/actions/mirror-sales-order/apply`, {
      method: "POST",
      body: JSON.stringify({ parameters: { orderNumber: "5001" } }),
    });
    expect(invalid.status).toBe(400);
    expect(stack.foundry.ctx.store.listIndexed("SalesOrder")).toHaveLength(before);

    const applied = await send(`${stack.foundry.url}/api/v2/ontologies/local/actions/mirror-sales-order/apply`, {
      method: "POST",
      body: JSON.stringify({
        parameters: {
          orderNumber: "5001",
          headerId: "H-1",
          buyingPartyName: "Synthetic Merchant Ltd",
          organizationCode: "WH-DUB",
          submittedFlag: false,
          lastUpdateDate: 1000,
          lines: [{ lineId: "L-1", productNumber: "POS-ACC", quantity: 2, sourceLineId: "L-1" }],
        },
      }),
    });
    expect(applied.status).toBe(200);
    const visible = await send(`${stack.foundry.url}/lab/query/SalesOrder`);
    expect(visible.body.items.map((item: { objectKey: string }) => item.objectKey)).toContain(salesOrderKey("5001"));

    const ingested = await send(`${stack.foundry.url}/lab/backing-generations`, {
      method: "POST",
      body: JSON.stringify({
        kind: "shipment-lines",
        capturedAt: 0,
        objectTypes: ["ShipmentLine"],
        immediate: false,
        rows: [
          {
            objectType: "ShipmentLine",
            objectKey: "shipment-line:4001",
            sourceTimestamp: 1000,
            present: ["ShipmentLine", "OrderNumber", "OrderedQuantity", "RequestedFulfillmentOrganizationCode", "SourceOrderFulfillmentLineId"],
            properties: {
              ShipmentLine: "4001",
              OrderNumber: "5001",
              OrderedQuantity: 2,
              RequestedFulfillmentOrganizationCode: "WH-DUB",
              SourceOrderFulfillmentLineId: null,
            },
          },
        ],
      }),
    });
    expect(ingested.body.indexed).toBe(false);
    const hidden = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(hidden.body.items).toEqual([]);
    await stack.clock.advanceTo(stack.profile.indexingMs);
    const shown = await send(`${stack.foundry.url}/lab/query/ShipmentLine`);
    expect(shown.body.items).toHaveLength(1);
  });

  it("keeps edit-only lock data and applies source precedence", async () => {
    stack = await startStack();
    await send(`${stack.foundry.url}/api/v2/ontologies/local/actions/mirror-sales-order/apply`, {
      method: "POST",
      body: JSON.stringify({
        parameters: {
          orderNumber: "5001",
          headerId: "H-1",
          buyingPartyName: "Synthetic Merchant Ltd",
          organizationCode: "WH-DUB",
          lines: [{ lineId: "L-1", productNumber: "POS-ACC", quantity: 2 }],
        },
      }),
    });
    const locked = await send(`${stack.foundry.url}/api/v2/ontologies/local/actions/set-warehouse-lock/apply`, {
      method: "POST",
      body: JSON.stringify({ parameters: { orderNumber: "5001", locked: true } }),
    });
    expect(locked.status).toBe(200);
    await stack.clock.advanceTo(2_000);
    await send(`${stack.foundry.url}/lab/edits`, {
      method: "POST",
      body: JSON.stringify({
        objectType: "SalesOrder",
        objectKey: salesOrderKey("5001"),
        property: "buyingPartyName",
        value: "Local Edit",
        ownership: "source",
      }),
    });
    const generation = {
      kind: "orders",
      objectTypes: ["SalesOrder", "SalesOrderLine"],
      immediate: true,
      rows: [
        {
          objectType: "SalesOrder",
          objectKey: salesOrderKey("5001"),
          sourceTimestamp: 1_000,
          present: ["orderNumber", "buyingPartyName", "organizationCode", "status", "lastUpdateDate"],
          properties: {
            orderNumber: "5001",
            buyingPartyName: "Oracle Name",
            organizationCode: "WH-DUB",
            status: "Submitted",
            lastUpdateDate: 1_000,
          },
        },
      ],
    };
    await send(`${stack.foundry.url}/lab/backing-generations`, { method: "POST", body: JSON.stringify({ ...generation, capturedAt: 1_000 }) });
    let order = (await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items[0].properties;
    expect(order.buyingPartyName).toBe("Local Edit");
    expect(order.fulfillmentLock).toBe(true);
    expect(order.activity.length).toBeGreaterThan(0);

    await stack.clock.advanceTo(5_000);
    await send(`${stack.foundry.url}/lab/backing-generations`, {
      method: "POST",
      body: JSON.stringify({
        ...generation,
        capturedAt: 5_000,
        rows: [{ ...generation.rows[0], sourceTimestamp: 5_000, properties: { ...generation.rows[0].properties, buyingPartyName: "Newer Oracle", lastUpdateDate: 5_000 } }],
      }),
    });
    order = (await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items[0].properties;
    expect(order.buyingPartyName).toBe("Newer Oracle");
    expect(order.fulfillmentLock).toBe(true);

    const again = await send(`${stack.foundry.url}/lab/backing-generations`, {
      method: "POST",
      body: JSON.stringify({ ...generation, capturedAt: 5_000, id: "repeat" }),
    });
    expect(again.status).toBe(200);
    expect((await send(`${stack.foundry.url}/lab/query/SalesOrder`)).body.items).toHaveLength(1);
  });
});
