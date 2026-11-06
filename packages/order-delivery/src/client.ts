import { Client, Connection, ScheduleAlreadyRunning, ScheduleOverlapPolicy, WorkflowNotFoundError } from "@temporalio/client";
import { DELIVERY_OVERDUE, DELIVERY_STAGE, SOURCE_ORDER_NUMBER } from "./search-attributes";
import type { DeliveryResult, DeliverySettings, OrderDeliveryInput, RecoveryInput } from "./types";

export const workflowIdFor = (orderKey: string) => `order-delivery:${orderKey}`;
export const RECOVERY_SCHEDULE_ID = "order-delivery-recovery";

/** The short timeout means an unreachable Temporal can't stall an approval. */
export async function connectTemporal(options: { address?: string; namespace?: string; apiKey?: string; connectTimeoutMs?: number } = {}): Promise<Client> {
  const connection = await Connection.connect({
    address: options.address ?? "localhost:7233",
    apiKey: options.apiKey,
    tls: options.apiKey ? true : undefined,
    connectTimeout: options.connectTimeoutMs ?? 2_000,
  });
  return new Client({ connection, namespace: options.namespace ?? "default" });
}

const searchAttributesFor = (orderKey: string) => [
  { key: SOURCE_ORDER_NUMBER, value: orderKey },
  { key: DELIVERY_STAGE, value: "AwaitingSubmittedOrder" },
  { key: DELIVERY_OVERDUE, value: false },
];

/**
 * Starts the order's workflow. A double click joins the running one. Once a run has finished, a
 * retry or the sweep can start another, which is safe because each pass only writes differences.
 */
export function startOrderDelivery(client: Client, input: OrderDeliveryInput, taskQueue: string) {
  return client.workflow.start<(input: OrderDeliveryInput) => Promise<DeliveryResult>>("deliverOrderToFulfillment", {
    taskQueue,
    workflowId: workflowIdFor(input.orderKey),
    args: [input],
    workflowIdConflictPolicy: "USE_EXISTING",
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    typedSearchAttributes: searchAttributesFor(input.orderKey),
  });
}

/**
 * Passes on an Oracle event: it wakes the running workflow to check now, or starts one if approval
 * missed it. Polling still runs without events, so a lost event only costs time.
 */
export function notifyOracleEvent(client: Client, input: { orderKey: string; settings: DeliverySettings }, taskQueue: string) {
  return client.workflow.signalWithStart<(input: OrderDeliveryInput) => Promise<DeliveryResult>, []>("deliverOrderToFulfillment", {
    taskQueue,
    workflowId: workflowIdFor(input.orderKey),
    args: [{ orderKey: input.orderKey, trigger: "oracle-event", settings: input.settings }],
    signal: "oracleEventArrived",
    signalArgs: [],
    workflowIdConflictPolicy: "USE_EXISTING",
    workflowIdReusePolicy: "ALLOW_DUPLICATE",
    typedSearchAttributes: searchAttributesFor(input.orderKey),
  });
}

export type DeliveryStatusView = {
  workflowId: string;
  status: string;
  stage: string | null;
  overdue: boolean;
  attempts: number | null;
  lastFailure: string | null;
};

/** Stage and overdue flag from search attributes, attempts and last failure from the pending activity. */
export async function describeOrderDelivery(client: Client, orderKey: string): Promise<DeliveryStatusView | null> {
  try {
    const description = await client.workflow.getHandle(workflowIdFor(orderKey)).describe();
    const pending = description.raw.pendingActivities?.[0];
    return {
      workflowId: description.workflowId,
      status: description.status.name,
      stage: (description.typedSearchAttributes.get(DELIVERY_STAGE) as string | undefined) ?? null,
      overdue: description.typedSearchAttributes.get(DELIVERY_OVERDUE) === true,
      attempts: pending?.attempt ?? null,
      lastFailure: pending?.lastFailure?.message ?? null,
    };
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
}

/** What the sweep uses to start a missed order. It leaves a running workflow alone, and stops retrying after maxRuns. */
export function createRecoveryStarter(client: Client, taskQueue: string, settings: DeliverySettings, maxRuns = 5) {
  return {
    async start(orderKey: string): Promise<"started" | "running" | "stopped" | "capped"> {
      const current = await describeOrderDelivery(client, orderKey);
      if (current?.status === "RUNNING") return "running";
      // An operator stopped it on purpose, maybe before any status could be saved on the order.
      if (current?.status === "CANCELLED" || current?.status === "TERMINATED") return "stopped";
      let runs = 0;
      for await (const _run of client.workflow.list({ query: `WorkflowId = "${workflowIdFor(orderKey).replace(/["\\]/g, "\\$&")}"` })) runs += 1;
      if (runs >= maxRuns) return "capped";
      await startOrderDelivery(client, { orderKey, trigger: "recovery", settings }, taskQueue);
      return "started";
    },
  };
}

/** Creates the sweep schedule, or updates it so new settings apply. Skip overlap means a slow sweep can't pile up. */
export async function ensureRecoverySchedule(client: Client, options: { taskQueue: string; everyMs: number; input: RecoveryInput }): Promise<void> {
  const spec = { intervals: [{ every: options.everyMs }] };
  const action = {
    type: "startWorkflow" as const,
    workflowType: "recoverySweepWorkflow",
    workflowId: "order-delivery-recovery-run",
    taskQueue: options.taskQueue,
    args: [options.input],
  };
  try {
    await client.schedule.create({ scheduleId: RECOVERY_SCHEDULE_ID, spec, action, policies: { overlap: ScheduleOverlapPolicy.SKIP } });
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    await client.schedule.getHandle(RECOVERY_SCHEDULE_ID).update((current) => ({ ...current, spec, action }));
  }
}
