import { join } from "node:path";
import { profileByName } from "@shift4/contracts";
import { WallClock } from "../lab/clock.js";
import { startConnector } from "./server.js";

const oracleUrl = process.env.ORACLE_URL ?? "http://127.0.0.1:4010";
const foundryUrl = process.env.FOUNDRY_URL ?? "http://127.0.0.1:4020";

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url} (${last})`);
}

await waitReady(oracleUrl);
await waitReady(foundryUrl);

const connector = await startConnector({
  scenarioId: process.env.SCENARIO_ID ?? "local-demo",
  profile: profileByName(process.env.PROFILE),
  clock: new WallClock(),
  dataDir: join(process.env.DATA_DIR ?? ".local", "connector"),
  oracleUrl,
  foundryUrl,
  port: Number(process.env.CONNECTOR_PORT ?? 4030),
});

console.log(`connector simulator listening on ${connector.url}`);
