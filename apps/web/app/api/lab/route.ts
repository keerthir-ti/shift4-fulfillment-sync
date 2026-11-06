import { NextResponse } from "next/server";
import { callService, connectorUrl, foundryUrl, oracleUrl, traces } from "../../../lib/clients";

export const dynamic = "force-dynamic";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";

export async function GET() {
  const [oracle, foundry, schedule, oracleEvents, foundryEvents, connectorEvents] = await Promise.all([
    callService("oracle", oracleUrl(`${PREFIX}/shipmentLines?limit=100`)),
    callService("foundry", foundryUrl("/lab/query/ShipmentLine")),
    callService("connector", connectorUrl("/lab/schedule")),
    callService("oracle", oracleUrl("/lab/events")),
    callService("foundry", foundryUrl("/lab/events")),
    callService("connector", connectorUrl("/lab/events")),
  ]);
  const oracleKnown = oracle.status < 400;
  const shipments = oracleKnown ? oracle.body.items ?? [] : [];
  return NextResponse.json(
    {
      simulator: true,
      oracle: {
        status: !oracleKnown ? "unknown" : shipments.length ? "ready" : "empty",
        shipments,
      },
      foundry: {
        status: foundry.status < 400 ? "ok" : "unknown",
        syncStatus: foundry.body.syncStatus ?? "unknown",
        items: foundry.body.items ?? [],
      },
      schedule: schedule.status < 400 ? schedule.body : { status: "unknown" },
      events: [...(oracleEvents.body.items ?? []), ...(foundryEvents.body.items ?? []), ...(connectorEvents.body.items ?? [])],
      traces: traces(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string; name?: string };
  if (body.action === "reset") {
    const result = await callService("connector", connectorUrl("/lab/reset"), { method: "POST" });
    return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  }
  if (body.action === "profile") {
    const result = await callService("connector", connectorUrl("/lab/profile"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: body.name }),
    });
    return NextResponse.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ message: "Unsupported lab action" }, { status: 400 });
}
