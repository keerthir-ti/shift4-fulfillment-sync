import type { DeliveryEvent, DeliveryEventSink } from "./system-adapters";

const ALERT_STAGES = new Set(["Overdue", "ActionRequired"]);

/**
 * Writes each stage change as one JSON log line, which keeps a trail beyond Temporal's retention once
 * logs are shipped somewhere durable. Overdue and ActionRequired also go to the webhook, if one is set.
 * Replace this with your own sink to store events elsewhere, such as Redis.
 */
export function createLogEventSink(options: { alertWebhookUrl?: string; log?: (line: string) => void } = {}): DeliveryEventSink {
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    async record(event: DeliveryEvent) {
      const alert = ALERT_STAGES.has(event.stage);
      log(JSON.stringify({ kind: "order-delivery", alert, ...event }));
      if (alert && options.alertWebhookUrl) {
        await fetch(options.alertWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5_000),
        });
      }
    },
  };
}
