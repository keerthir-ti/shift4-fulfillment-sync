import { fulfillmentOrders } from "@shift4/contracts";
import { callService, foundryUrl } from "./clients";

export async function readOrders() {
  const result = await callService("foundry", foundryUrl("/lab/query/SalesOrder"), undefined, "orders-read");
  return { status: result.status, syncStatus: result.body.syncStatus ?? "unknown", items: result.body.items ?? [] };
}

export async function readFulfillment() {
  const result = await callService("foundry", foundryUrl("/lab/query/ShipmentLine"), undefined, "fulfillment-read");
  const items: { properties: Record<string, unknown> }[] = result.body.items ?? [];
  return { status: result.status, syncStatus: result.body.syncStatus ?? "unknown", items, orders: fulfillmentOrders(items.map((item) => item.properties)) };
}
