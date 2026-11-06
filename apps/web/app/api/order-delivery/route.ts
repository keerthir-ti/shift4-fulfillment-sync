import { NextResponse } from "next/server";
import { explainOrderDelivery } from "@shift4/order-delivery/explain";
import { createHttpFoundryStore, createHttpOracleReader } from "@shift4/order-delivery/system-adapters";
import { foundryUrl, oracleUrl } from "../../../lib/clients";
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
