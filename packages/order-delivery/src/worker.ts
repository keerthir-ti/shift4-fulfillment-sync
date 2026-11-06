import { fileURLToPath } from "node:url";
import { Worker, type NativeConnection, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { Activities } from "./activities";

export const WORKFLOWS_PATH = fileURLToPath(new URL("./workflows.ts", import.meta.url));

export type DeliveryWorkerOptions = {
  connection: NativeConnection;
  namespace?: string;
  taskQueue: string;
  oracleTaskQueue: string;
  /** Enforced by the Temporal server across every worker on the queue. */
  oracleActivitiesPerSecond: number;
  activities: Activities;
  /** Tests pass a prebuilt bundle. Otherwise the workflow code is bundled at startup. */
  workflowBundle?: WorkflowBundleWithSourceMap;
};

/**
 * Two workers in one process. One runs workflows and status notes. The other runs anything that reads
 * Oracle on a rate-limited queue, so polling stays within the limit however many orders are open.
 */
export async function createDeliveryWorkers(options: DeliveryWorkerOptions) {
  // On a deploy, calls in flight get time to finish. Anything cut off is retried, and repeats are safe.
  const shared = { connection: options.connection, namespace: options.namespace, activities: options.activities, shutdownGraceTime: 10_000 };
  const main = await Worker.create({
    ...shared,
    taskQueue: options.taskQueue,
    ...(options.workflowBundle ? { workflowBundle: options.workflowBundle } : { workflowsPath: WORKFLOWS_PATH }),
  });
  const oracle = await Worker.create({
    ...shared,
    taskQueue: options.oracleTaskQueue,
    maxTaskQueueActivitiesPerSecond: options.oracleActivitiesPerSecond,
  });
  return {
    main,
    oracle,
    run: () => Promise.all([main.run(), oracle.run()]).then(() => undefined),
    shutdown() {
      main.shutdown();
      oracle.shutdown();
    },
    healthy: () => main.getState() === "RUNNING" && oracle.getState() === "RUNNING",
  };
}
