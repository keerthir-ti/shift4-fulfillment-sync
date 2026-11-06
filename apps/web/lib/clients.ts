export type Trace = { target: "oracle" | "foundry" | "connector"; url: string; at: number; source: string };

const ring: Trace[] = [];

export function traces(): Trace[] {
  return ring.map((entry) => ({ ...entry }));
}

export function clearTraces(): void {
  ring.length = 0;
}

export async function callService(target: Trace["target"], url: string, init?: RequestInit, source = "client"): Promise<{ status: number; body: any }> {
  ring.push({ target, url, at: Date.now(), source });
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export function oracleUrl(path: string): string {
  return `${process.env.ORACLE_URL ?? "http://127.0.0.1:4010"}${path}`;
}

export function foundryUrl(path: string): string {
  return `${process.env.FOUNDRY_URL ?? "http://127.0.0.1:4020"}${path}`;
}

export function connectorUrl(path: string): string {
  return `${process.env.CONNECTOR_URL ?? "http://127.0.0.1:4030"}${path}`;
}
