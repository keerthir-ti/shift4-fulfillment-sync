import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReference } from "../../packages/contracts/src/fixture.js";
import { acceleratedProfile, type Profile } from "../../packages/contracts/src/index.js";
import { ManualClock, WallClock, type Clock } from "../../services/sim/src/lab/clock.js";
import { startConnector } from "../../services/sim/src/connector/server.js";
import { startFoundry } from "../../services/sim/src/foundry/server.js";
import { startOracle } from "../../services/sim/src/oracle/server.js";

type StackOptions = {
  profile?: Profile;
  scenarioPaths?: string[];
  /** Shipment lines already in Oracle before the stack starts. */
  existingShipments?: number;
};

/** Controlled time: tests move the clock themselves. */
export const startStack = (options?: StackOptions) => buildStack(new ManualClock(0), options);

/** Real time, for anything that runs with a real Temporal server. */
export const startWallClockStack = (options?: StackOptions) => buildStack(new WallClock(), options);

async function buildStack<C extends Clock>(clock: C, options?: StackOptions) {
  const dir = mkdtempSync(join(tmpdir(), "shift4-repro-"));
  const profile = options?.profile ?? acceleratedProfile();
  const reference = loadReference(join(process.cwd(), "fixtures/oracle-baseline-scenario.json"), options?.scenarioPaths ?? []);
  const scenarioId = `scenario-${Math.random().toString(16).slice(2)}`;
  const oracle = await startOracle({ scenarioId, profile, reference, clock, dataDir: join(dir, "oracle") });
  if (options?.existingShipments) oracle.ctx.store.seedExistingShipments(options.existingShipments, clock.now() - 1);
  const foundry = await startFoundry({ scenarioId, profile, clock, dataDir: join(dir, "foundry") });
  const connector = await startConnector({
    scenarioId,
    profile,
    clock,
    dataDir: join(dir, "connector"),
    oracleUrl: oracle.url,
    foundryUrl: foundry.url,
  });
  return {
    clock,
    profile,
    scenarioId,
    oracle,
    foundry,
    connector,
    async stop() {
      await connector.stop();
      await foundry.stop();
      await oracle.stop();
    },
  };
}

export async function send(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
