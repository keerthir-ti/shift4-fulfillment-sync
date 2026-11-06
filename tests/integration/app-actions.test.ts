import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveOrder, createOrder } from "../../apps/web/lib/flow.js";
import { readFulfillment, readOrders } from "../../apps/web/lib/reads.js";
import { clearTraces, traces } from "../../apps/web/lib/clients.js";
import { send, startStack } from "../helpers/stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;

beforeEach(async () => {
  stack = await startStack();
  process.env.ORACLE_URL = stack.oracle.url;
  process.env.FOUNDRY_URL = stack.foundry.url;
  process.env.CONNECTOR_URL = stack.connector.url;
  clearTraces();
  stack.oracle.ctx.requests.length = 0;
});

afterEach(async () => {
  await stack.stop();
});

describe("web actions", () => {
  it("writes oracle and mirrors the sales order without copying shipments", async () => {
    const created = await createOrder({
      buyingPartyName: "Synthetic Merchant Ltd",
      organizationCode: "WH-DUB",
      productNumber: "POS-ACC",
      quantity: 2,
      sourceTransactionNumber: "web-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const orders = await readOrders();
    expect(orders.items.map((item: { properties: { orderNumber: string } }) => item.properties.orderNumber)).toContain(created.orderNumber);
    const approved = await approveOrder({ headerId: created.headerId, orderNumber: created.orderNumber });
    expect(approved.ok).toBe(true);
    const fulfillment = await readFulfillment();
    expect(fulfillment.items).toEqual([]);
    expect(stack.oracle.ctx.requests.some((request) => request.url.includes("shipmentLines"))).toBe(false);
    expect(traces().some((trace) => trace.target === "oracle" && trace.url.includes("shipmentLines"))).toBe(false);
    expect(traces().filter((trace) => trace.target === "foundry" && trace.url.includes("ShipmentLine"))).toHaveLength(1);
    const uncertain = await send(`${stack.oracle.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "lose-response" }) });
    expect(uncertain.status).toBe(200);
    const lost = await createOrder({
      buyingPartyName: "Synthetic Merchant Ltd",
      organizationCode: "WH-DUB",
      productNumber: "POS-ACC",
      quantity: 1,
      sourceTransactionNumber: "web-lost",
    });
    expect(lost.ok).toBe(false);
    if (lost.ok) return;
    expect(lost.outcome).toBe("uncertain");
    const retried = await createOrder({
      buyingPartyName: "Synthetic Merchant Ltd",
      organizationCode: "WH-DUB",
      productNumber: "POS-ACC",
      quantity: 1,
      sourceTransactionNumber: "web-lost",
    });
    expect(retried.ok).toBe(true);
    const headers = await send(`${stack.oracle.url}/fscmRestApi/resources/11.13.18.05/salesOrders?limit=50`);
    expect(headers.body.items.filter((item: { SourceTransactionNumber: string }) => item.SourceTransactionNumber === "web-lost")).toHaveLength(1);
  });
});
