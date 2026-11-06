import { NextResponse } from "next/server";
import { callService, connectorUrl, foundryUrl, oracleUrl } from "../../../lib/clients";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks = await Promise.all([
    callService("oracle", oracleUrl("/health")),
    callService("foundry", foundryUrl("/health")),
    callService("connector", connectorUrl("/health")),
  ]);
  const ok = checks.every((check) => check.status === 200 && check.body.ok === true);
  return NextResponse.json(
    { ok, services: checks.map((check) => check.body) },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
