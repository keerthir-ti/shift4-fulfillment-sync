import { callService, foundryUrl } from "./clients";

export async function readOrders() {
  const result = await callService("foundry", foundryUrl("/lab/query/SalesOrder"), undefined, "orders-read");
  return { status: result.status, syncStatus: result.body.syncStatus ?? "unknown", items: result.body.items ?? [] };
}

/** What Fulfillment Manager shows: the fulfillment order objects, so an order appears only once one exists. */
export async function readFulfillment() {
  const result = await callService("foundry", foundryUrl("/lab/query/FulfillmentOrder"), undefined, "fulfillment-read");
  const items: { properties: Record<string, unknown> }[] = result.body.items ?? [];
  return { status: result.status, syncStatus: result.body.syncStatus ?? "unknown", orders: items.map((item) => item.properties) };
}
