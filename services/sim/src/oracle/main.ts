import { join } from "node:path";
import { loadReference } from "@shift4/contracts/fixture";
import { WallClock } from "../lab/clock.js";
import { profileByName } from "@shift4/contracts";
import { startOracle } from "./server.js";

const dataDir = process.env.DATA_DIR ?? ".local";
const profile = profileByName(process.env.PROFILE);
const fixturePath = process.env.FIXTURE_PATH ?? join(process.cwd(), "fixtures/oracle-baseline-scenario.json");
const scenarioPaths = (process.env.SCENARIO_PATHS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const oracle = await startOracle({
  scenarioId: process.env.SCENARIO_ID ?? "local-demo",
  profile,
  reference: loadReference(fixturePath, scenarioPaths),
  clock: new WallClock(),
  dataDir: join(dataDir, "oracle"),
  port: Number(process.env.ORACLE_PORT ?? 4010),
});

const existingShipments = Number(process.env.ORACLE_EXISTING_SHIPMENTS ?? 0);
if (existingShipments > 0 && oracle.ctx.store.shipments().length === 0) {
  oracle.ctx.store.seedExistingShipments(existingShipments, Date.now());
}

console.log(`oracle simulator listening on ${oracle.url}`);
