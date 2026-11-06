import { NextResponse } from "next/server";
import { readOrders } from "../../../lib/reads";

export const dynamic = "force-dynamic";

export async function GET() {
  const orders = await readOrders();
  return NextResponse.json(orders, { headers: { "cache-control": "no-store" } });
}
