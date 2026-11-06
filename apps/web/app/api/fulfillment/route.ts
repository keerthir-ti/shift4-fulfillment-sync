import { NextResponse } from "next/server";
import { readFulfillment } from "../../../lib/reads";

export const dynamic = "force-dynamic";

export async function GET() {
  const fulfillment = await readFulfillment();
  return NextResponse.json(fulfillment, { headers: { "cache-control": "no-store" } });
}
