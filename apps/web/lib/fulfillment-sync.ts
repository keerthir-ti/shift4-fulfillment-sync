/**
 * Starts the delivery workflow from the approve action. It never blocks or fails an approval:
 * if Temporal is unreachable, the order is recorded as not started and the recovery sweep picks it up.
 */
import type { Client } from "@temporalio/client";
import { connectTemporal, startOrderDelivery } from "@shift4/order-delivery/client";
import { deliverySettingsFromEnv, type DeliveryTrigger } from "@shift4/order-delivery/types";
import type { FlowHooks } from "./flow";

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

export function createSyncHooks(options: { client: () => Promise<Client>; taskQueue: string; settings?: ReturnType<typeof deliverySettingsFromEnv> }): FlowHooks {
  return {
    async onOracleSubmitted(event: { orderKey: string; trigger: DeliveryTrigger }) {
      try {
        const client = await withTimeout(options.client(), 3_000, "Temporal connection");
        const input = { orderKey: event.orderKey, trigger: event.trigger, settings: options.settings ?? deliverySettingsFromEnv() };
        await withTimeout(startOrderDelivery(client, input, options.taskQueue), 3_000, "Workflow start");
        return { started: true };
      } catch (error) {
        console.error("[fulfillment-sync] not started", event.orderKey, error);
        return { started: false, reason: error instanceof Error ? error.message : "unknown error" };
      }
    },
  };
}

let cached: Promise<Client> | null = null;
function sharedClient(): Promise<Client> {
  if (!cached) {
    cached = connectTemporal({
      address: process.env.TEMPORAL_ADDRESS,
      namespace: process.env.TEMPORAL_NAMESPACE,
      apiKey: process.env.TEMPORAL_API_KEY,
    }).catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

export { sharedClient };

export function defaultSyncHooks(): FlowHooks {
  return createSyncHooks({ client: sharedClient, taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "order-delivery" });
}
