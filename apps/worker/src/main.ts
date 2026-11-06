/**
 * The Temporal worker, as a plain Node process. To go live, replace the HTTP adapters below with
 * implementations over Shift4's own helpers. Nothing else here changes.
 */
import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Runtime } from "@temporalio/worker";
import {
  createActivities,
  createHttpFoundryStore,
  createHttpOracleReader,
  createHttpRecoveryIndex,
  createLogEventSink,
  createRecoveryStarter,
  deliverySettingsFromEnv,
  ensureAuditSchedule,
  ensureRecoverySchedule,
} from "@shift4/order-delivery";
import { createDeliveryWorkers } from "@shift4/order-delivery/worker";

const env = process.env;
const address = env.TEMPORAL_ADDRESS ?? "localhost:7233";
const namespace = env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = env.TEMPORAL_TASK_QUEUE ?? "order-delivery";
const apiKey = env.TEMPORAL_API_KEY;
const tls = apiKey ? true : undefined;
const settings = deliverySettingsFromEnv(env);
const oracleTaskQueue = settings.oracleTaskQueue ?? "oracle-reads";
const sweepEveryMs = Number(env.SYNC_SWEEP_EVERY_MS ?? 15 * 60_000);
const auditEveryMs = Number(env.SYNC_AUDIT_EVERY_MS ?? 24 * 60 * 60_000);
const foundryAccess = { baseUrl: env.FOUNDRY_URL ?? "http://127.0.0.1:4020", authorization: env.FOUNDRY_AUTHORIZATION };

// Prometheus metrics, including schedule-to-start latency, which rises when workers fall behind.
if (env.WORKER_METRICS_PORT) {
  Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: `${env.BIND_HOST ?? "127.0.0.1"}:${env.WORKER_METRICS_PORT}` } } } });
}

const client = new Client({ connection: await Connection.connect({ address, apiKey, tls }), namespace });
const connection = await NativeConnection.connect({ address, apiKey, tls });

const recovery = sweepEveryMs > 0
  ? { index: createHttpRecoveryIndex(foundryAccess), ...createRecoveryStarter(client, taskQueue, settings, Number(env.SYNC_RECOVERY_MAX_RUNS ?? 5)) }
  : undefined;

const workers = await createDeliveryWorkers({
  connection,
  namespace,
  taskQueue,
  oracleTaskQueue,
  oracleActivitiesPerSecond: Number(env.ORACLE_ACTIVITIES_PER_SECOND ?? 1),
  activities: createActivities({
    oracle: createHttpOracleReader({ baseUrl: env.ORACLE_URL ?? "http://127.0.0.1:4010", authorization: env.ORACLE_AUTHORIZATION }),
    foundry: createHttpFoundryStore(foundryAccess),
    recovery,
    events: createLogEventSink({ alertWebhookUrl: env.DELIVERY_ALERT_WEBHOOK_URL }),
  }),
});

if (sweepEveryMs > 0) {
  await ensureRecoverySchedule(client, {
    taskQueue,
    everyMs: sweepEveryMs,
    input: { lookbackMs: Number(env.SYNC_SWEEP_LOOKBACK_MS ?? 24 * 60 * 60_000), limit: Number(env.SYNC_SWEEP_LIMIT ?? 100), settings },
  });
}

if (recovery && auditEveryMs > 0) {
  await ensureAuditSchedule(client, {
    taskQueue,
    everyMs: auditEveryMs,
    input: { lookbackMs: Number(env.SYNC_AUDIT_LOOKBACK_MS ?? 3 * 24 * 60 * 60_000), limit: Number(env.SYNC_AUDIT_LIMIT ?? 100), settings },
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => workers.shutdown());

const health = env.WORKER_HEALTH_PORT
  ? createServer((_request, response) => {
      const ok = workers.healthy();
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, service: "worker" }));
    }).listen(Number(env.WORKER_HEALTH_PORT), env.BIND_HOST ?? "127.0.0.1")
  : null;

console.log(`worker on ${address}: queues ${taskQueue} and ${oracleTaskQueue}`);
await workers.run();
health?.close();
await connection.close();
