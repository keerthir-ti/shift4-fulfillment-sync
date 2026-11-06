import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Finds the Temporal CLI on any machine: TEMPORAL_CLI, then PATH, then the installer's default location. */
export function temporalCli(): string {
  if (process.env.TEMPORAL_CLI) return process.env.TEMPORAL_CLI;
  try {
    const found = execSync("command -v temporal", { shell: "/bin/sh" }).toString().trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  const installed = join(homedir(), ".temporalio", "bin", "temporal");
  if (existsSync(installed)) return installed;
  throw new Error("Temporal CLI not found. Install it, or set TEMPORAL_CLI to its path.");
}

export const quietLogger = { info() {}, warn() {}, error: console.error, debug() {}, trace() {}, log() {} } as never;
