import { join } from "node:path";
import { profileByName } from "@shift4/contracts";
import { WallClock } from "../lab/clock.js";
import { startFoundry } from "./server.js";

const foundry = await startFoundry({
  scenarioId: process.env.SCENARIO_ID ?? "local-demo",
  profile: profileByName(process.env.PROFILE),
  clock: new WallClock(),
  dataDir: join(process.env.DATA_DIR ?? ".local", "foundry"),
  port: Number(process.env.FOUNDRY_PORT ?? 4020),
});

console.log(`foundry simulator listening on ${foundry.url}`);
