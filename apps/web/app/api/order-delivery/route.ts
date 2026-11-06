import { NextResponse } from "next/server";
import { explainOrderDelivery } from "@shift4/order-delivery/explain";
import { createHttpFoundryStore, createHttpOracleReader } from "@shift4/order-delivery/system-adapters";
import { foundryUrl, oracleUrl } from "../../../lib/clients";
import { requestCheckNow } from "@shift4/order-delivery/client";
import { deliverySettingsFromEnv } from "@shift4/order-delivery/types";
import { sharedClient } from "../../../lib/fulfillment-sync";

/** Read-only: why an order is or isn't in Fulfillment Manager, from Oracle, Foundry and Temporal. */
export async function GET(request: Request) {
  const orderKey = new URL(request.url).searchParams.get("orderKey");
  if (!orderKey) return NextResponse.json({ message: "orderKey is required" }, { status: 400 });
  const client = process.env.FULFILLMENT_SYNC === "on" ? await sharedClient().catch(() => undefined) : undefined;
  const explanation = await explainOrderDelivery({
    orderKey,
    oracle: createHttpOracleReader({ baseUrl: oracleUrl("") }),
    foundry: createHttpFoundryStore({ baseUrl: foundryUrl("") }),
    client,
  });
  return NextResponse.json(explanation, { headers: { "cache-control": "no-store" } });
}

/** Asks an order's workflow to check now, or starts one if there isn't one. Oracle's event integration calls this too. */
export async function POST(request: Request) {
  const { orderKey } = (await request.json().catch(() => ({}))) as { orderKey?: string };
  if (!orderKey) return NextResponse.json({ message: "orderKey is required" }, { status: 400 });
  if (process.env.FULFILLMENT_SYNC !== "on") return NextResponse.json({ message: "The workflow is off" }, { status: 409 });
  const client = await sharedClient();
  await requestCheckNow(client, { orderKey, settings: deliverySettingsFromEnv() }, process.env.TEMPORAL_TASK_QUEUE ?? "order-delivery");
  return NextResponse.json({ ok: true, orderKey });
}
