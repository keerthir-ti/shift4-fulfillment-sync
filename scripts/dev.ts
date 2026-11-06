import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";

const root = process.cwd();
const nodeBin = dirname(process.execPath);
const children: ChildProcess[] = [];
const webPort = Number(process.env.WEB_PORT ?? 3000);
const oraclePort = Number(process.env.ORACLE_PORT ?? 4010);
const foundryPort = Number(process.env.FOUNDRY_PORT ?? 4020);
const connectorPort = Number(process.env.CONNECTOR_PORT ?? 4030);
const syncOn = process.env.FULFILLMENT_SYNC === "on";
const temporalPort = Number(process.env.TEMPORAL_PORT ?? 7243);
const temporalUiPort = Number(process.env.TEMPORAL_UI_PORT ?? 8243);

const env = {
  ...process.env,
  PATH: `${nodeBin}:${homedir()}/.temporalio/bin:${process.env.PATH ?? ""}`,
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? `127.0.0.1:${temporalPort}`,
  // Quick settings to suit the accelerated simulators. Real defaults are in the workflow package.
  SYNC_POLL_INITIAL_MS: process.env.SYNC_POLL_INITIAL_MS ?? "1000",
  SYNC_POLL_MAX_MS: process.env.SYNC_POLL_MAX_MS ?? "5000",
  SYNC_OVERDUE_AFTER_MS: process.env.SYNC_OVERDUE_AFTER_MS ?? "60000",
  SYNC_DEADLINE_MS: process.env.SYNC_DEADLINE_MS ?? "300000",
  SYNC_SWEEP_EVERY_MS: process.env.SYNC_SWEEP_EVERY_MS ?? "60000",
  SYNC_SETTLE_WATCH_MS: process.env.SYNC_SETTLE_WATCH_MS ?? "30000",
  WEB_PORT: String(webPort),
  TEMPORAL_PORT: String(temporalPort),
  TEMPORAL_UI_PORT: String(temporalUiPort),
  ORACLE_PORT: String(oraclePort),
  FOUNDRY_PORT: String(foundryPort),
  CONNECTOR_PORT: String(connectorPort),
  ORACLE_URL: process.env.ORACLE_URL ?? `http://127.0.0.1:${oraclePort}`,
  FOUNDRY_URL: process.env.FOUNDRY_URL ?? `http://127.0.0.1:${foundryPort}`,
  CONNECTOR_URL: process.env.CONNECTOR_URL ?? `http://127.0.0.1:${connectorPort}`,
  DATA_DIR: process.env.DATA_DIR ?? ".local",
  PROFILE: process.env.PROFILE ?? "accelerated",
  SCENARIO_ID: process.env.SCENARIO_ID ?? "local-demo",
};

async function assertPortFree(port: number, name: string) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new Error(`Port ${port} is already in use (${name}). Stop that process or set a different port.`));
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

function start(name: string, command: string, args: string[], cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal || code === 0 || code === null) return;
    console.error(`${name} exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

async function waitFor(url: string) {
  const deadline = Date.now() + 30_000;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url} (${last})`);
}

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

rmSync(env.DATA_DIR ?? ".local", { recursive: true, force: true });
await assertPortFree(oraclePort, "oracle");
await assertPortFree(foundryPort, "foundry");
await assertPortFree(connectorPort, "connector");
await assertPortFree(webPort, "web");

start("oracle", "node_modules/.bin/tsx", ["services/sim/src/oracle/main.ts"]);
start("foundry", "node_modules/.bin/tsx", ["services/sim/src/foundry/main.ts"]);
await waitFor(`${env.ORACLE_URL}/health`);
await waitFor(`${env.FOUNDRY_URL}/health`);
start("connector", "node_modules/.bin/tsx", ["services/sim/src/connector/main.ts"]);
await waitFor(`${env.CONNECTOR_URL}/health`);
if (syncOn) {
  if (!process.env.TEMPORAL_ADDRESS) {
    await assertPortFree(temporalPort, "temporal");
    start("temporal", "bash", ["scripts/temporal-dev.sh"]);
    await waitFor(`http://127.0.0.1:${temporalUiPort}`);
    console.log(`Temporal UI at http://127.0.0.1:${temporalUiPort}`);
  }
  start("worker", "node_modules/.bin/tsx", ["apps/worker/src/main.ts"]);
}
start("web", "node_modules/.bin/next", ["dev", "--port", String(webPort), "--hostname", "127.0.0.1"], "apps/web");
await waitFor(`http://127.0.0.1:${webPort}/api/health`);
console.log(`local reproduction ready at http://127.0.0.1:${webPort}`);
await new Promise(() => undefined);
