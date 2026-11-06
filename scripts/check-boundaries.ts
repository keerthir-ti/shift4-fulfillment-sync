import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const skip = new Set(["node_modules", ".next", "artifacts", ".local", "test-results", "playwright-report"]);

/** Temporal is allowed here. Everywhere else, especially the simulators, it stays out. */
const temporalAllowed = new Set(["package.json", "apps/web/package.json", "apps/worker/package.json", "packages/order-delivery/package.json"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const files = walk(".");
for (const file of files) {
  if (!file.endsWith("package.json") || temporalAllowed.has(file)) continue;
  const text = readFileSync(file, "utf8");
  if (text.includes("@temporalio") || text.includes("temporalio")) {
    console.error(`Temporal dependency found in ${file}`);
    process.exit(1);
  }
}

const guarded = [
  "apps/web/lib/flow.ts",
  "apps/web/lib/reads.ts",
  "apps/web/app/actions.ts",
  "apps/web/app/api/fulfillment/route.ts",
  "apps/web/app/api/orders/route.ts",
];
for (const file of guarded) {
  const text = readFileSync(file, "utf8");
  if (text.includes("shipmentLines") || text.includes("backing-generations")) {
    console.error(`Shipment shortcut found in ${file}`);
    process.exit(1);
  }
}

// The workflow package and worker are what Shift4 keeps, so they must not depend on a simulator.
for (const file of files) {
  if (!/^(packages\/fulfillment-workflow|apps\/worker)\/.*\.ts$/.test(file) && file !== "apps/web/lib/fulfillment-sync.ts") continue;
  const text = readFileSync(file, "utf8");
  if (/\/lab\/|services\/sim|@shift4\/sim/.test(text)) {
    console.error(`Simulator dependency found in ${file}`);
    process.exit(1);
  }
}
console.log("boundary check passed: Temporal only where allowed, no shipment shortcut on the sales path, no simulator dependency in the workflow");
