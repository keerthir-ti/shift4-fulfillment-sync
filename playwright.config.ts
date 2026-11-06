import { defineConfig } from "@playwright/test";

const LOCAL_URL = "http://127.0.0.1:3540";
// Set E2E_BASE_URL to test a stack that is already running, such as the Docker one.
const runningStack = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  workers: 1,
  expect: { timeout: 40_000 },
  // Set E2E_CHANNEL=chrome to use an installed Chrome.
  use: { baseURL: runningStack ?? LOCAL_URL, trace: "retain-on-failure", channel: process.env.E2E_CHANNEL },
  webServer: runningStack
    ? undefined
    : {
        command: `FULFILLMENT_SYNC=${process.env.E2E_FULFILLMENT_SYNC ?? "off"} WEB_PORT=3540 ORACLE_PORT=4540 FOUNDRY_PORT=4541 CONNECTOR_PORT=4542 ORACLE_URL=http://127.0.0.1:4540 FOUNDRY_URL=http://127.0.0.1:4541 CONNECTOR_URL=http://127.0.0.1:4542 TEMPORAL_PORT=7544 TEMPORAL_UI_PORT=8544 node_modules/.bin/tsx scripts/dev.ts`,
        url: `${LOCAL_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
