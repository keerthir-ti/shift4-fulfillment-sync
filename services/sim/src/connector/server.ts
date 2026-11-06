import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { profileByName, type Profile, type SnapshotKind } from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";
import { EventLog } from "../lab/events.js";
import { startSchedules } from "./scheduler.js";
import { captureSnapshot, commitSnapshot, objectTypesFor, scheduleCommit } from "./snapshot.js";
import { ConnectorStore } from "./store.js";

export type ConnectorContext = {
  scenarioId: string;
  profile: Profile;
  clock: Clock;
  store: ConnectorStore;
  events: EventLog;
  oracleUrl: string;
  foundryUrl: string;
  epoch: number;
  origin: number;
  failNext: boolean;
  nextShipmentSnapshotAt: number | null;
  nextOrderSnapshotAt: number | null;
  runningKinds: Set<SnapshotKind>;
  queuedKinds: Set<SnapshotKind>;
};

export type RunningConnector = {
  app: FastifyInstance;
  ctx: ConnectorContext;
  url: string;
  port: number;
  captureSnapshot: (kind: SnapshotKind, capturedAt?: number) => Promise<{ ok: boolean; id?: string; message?: string }>;
  stop: () => Promise<void>;
};

export async function startConnector(options: {
  scenarioId: string;
  profile: Profile;
  clock: Clock;
  dataDir: string;
  oracleUrl: string;
  foundryUrl: string;
  port?: number;
  seed?: boolean;
}): Promise<RunningConnector> {
  const ctx: ConnectorContext = {
    scenarioId: options.scenarioId,
    profile: options.profile,
    clock: options.clock,
    store: new ConnectorStore(options.dataDir),
    events: new EventLog(options.scenarioId, "connector", options.clock),
    oracleUrl: options.oracleUrl,
    foundryUrl: options.foundryUrl,
    epoch: 0,
    origin: options.clock.now(),
    failNext: false,
    nextShipmentSnapshotAt: null,
    nextOrderSnapshotAt: null,
    runningKinds: new Set(),
    queuedKinds: new Set(),
  };
  const app = Fastify({ logger: false });

  /** For tests on a profile with no paging cost, where the capture finishes before this returns. */
  const capture = async (kind: SnapshotKind, capturedAt = ctx.clock.now()): Promise<RunResult> => {
    let result: RunResult = { ok: false, message: "capture is still reading pages" };
    await runCapture(ctx, kind, capturedAt, false, (finished) => {
      result = finished;
    });
    return result;
  };

  app.get("/health", async () => ({
    ok: true,
    service: "connector",
    scenarioId: ctx.scenarioId,
    profile: ctx.profile.name,
  }));
  app.get("/lab/events", async () => ({ items: ctx.events.all() }));
  app.get("/lab/schedule", async () => ({
    profile: ctx.profile.name,
    oracleProcessingMs: ctx.profile.oracleProcessingMs,
    shipmentIntervalMs: ctx.profile.shipmentSnapshotIntervalMs,
    orderIntervalMs: ctx.profile.orderSnapshotIntervalMs,
    extractionMs: ctx.profile.extractionMs,
    indexingMs: ctx.profile.indexingMs,
    uiRefreshMs: ctx.profile.uiRefreshMs,
    nextShipmentSnapshotAt: ctx.nextShipmentSnapshotAt,
    nextOrderSnapshotAt: ctx.nextOrderSnapshotAt,
    origin: ctx.origin,
    note: ctx.profile.name === "fifteen-minute"
      ? "15-minute snapshot preset is a selected schedule, not a measured Shift4 replica."
      : "Accelerated 60-second snapshot is the synthetic default, not a measured Shift4 replica.",
  }));
  app.post("/lab/faults", async (request) => {
    const body = request.body as { mode?: string };
    if (body.mode === "fail-snapshot") ctx.failNext = true;
    return { ok: true };
  });
  app.post("/lab/reset", async () => {
    await resetAndArm(ctx);
    return { ok: true };
  });
  app.post("/lab/profile", async (request, reply) => {
    const body = request.body as { name?: string };
    try {
      ctx.profile = profileByName(body.name);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "bad profile" });
    }
    arm(ctx);
    return { ok: true, profile: ctx.profile.name };
  });

  try {
    await app.listen({ port: options.port ?? 0, host: process.env.BIND_HOST ?? "127.0.0.1" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Port ${options.port} is already in use (connector). Stop the other process or set CONNECTOR_PORT.`);
    }
    throw error;
  }
  if (options.seed !== false) await seedBaseline(ctx);
  arm(ctx);
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    ctx,
    port,
    url: `http://127.0.0.1:${port}`,
    captureSnapshot: capture,
    stop: async () => {
      await app.close();
      ctx.store.close();
    },
  };
}

async function seedBaseline(ctx: ConnectorContext): Promise<void> {
  await runCapture(ctx, "orders", ctx.clock.now(), true);
  await runCapture(ctx, "shipment-lines", ctx.clock.now(), true);
  ctx.runningKinds.clear();
}

async function resetAndArm(ctx: ConnectorContext): Promise<void> {
  ctx.epoch += 1;
  ctx.store.reset();
  ctx.events.clear();
  ctx.failNext = false;
  ctx.origin = ctx.clock.now();
  await fetch(`${ctx.oracleUrl}/lab/reset`, { method: "POST" }).catch(() => undefined);
  await fetch(`${ctx.foundryUrl}/lab/reset`, { method: "POST" }).catch(() => undefined);
  await seedBaseline(ctx);
  arm(ctx);
}

function arm(ctx: ConnectorContext): void {
  ctx.epoch += 1;
  ctx.runningKinds.clear();
  ctx.queuedKinds.clear();
  ctx.origin = ctx.clock.now();
  ctx.nextOrderSnapshotAt = ctx.origin + ctx.profile.orderSnapshotIntervalMs;
  ctx.nextShipmentSnapshotAt = ctx.origin + ctx.profile.shipmentSnapshotIntervalMs;
  startSchedules({
    clock: ctx.clock,
    origin: ctx.origin,
    profile: ctx.profile,
    epoch: () => ctx.epoch,
    run: async (kind, at) => {
      if (kind === "orders") ctx.nextOrderSnapshotAt = at + ctx.profile.orderSnapshotIntervalMs;
      else ctx.nextShipmentSnapshotAt = at + ctx.profile.shipmentSnapshotIntervalMs;
      await runWhenFree(ctx, kind, at);
    },
  });
}

type RunResult = { ok: boolean; id?: string; message?: string };

/** One run per kind at a time. A run that comes due meanwhile waits, and several collapse into one. */
async function runWhenFree(ctx: ConnectorContext, kind: SnapshotKind, capturedAt: number): Promise<void> {
  if (ctx.runningKinds.has(kind)) {
    if (!ctx.queuedKinds.has(kind)) ctx.events.record("connector.capture.queued", { operationId: kind, detail: { capturedAt, kind } });
    ctx.queuedKinds.add(kind);
    return;
  }
  await runCapture(ctx, kind, capturedAt, false);
}

async function runCapture(ctx: ConnectorContext, kind: SnapshotKind, capturedAt: number, initialLoad: boolean, onResult?: (result: RunResult) => void): Promise<void> {
  const epoch = ctx.epoch;
  const isCurrent = () => ctx.epoch === epoch;
  ctx.runningKinds.add(kind);

  const release = async () => {
    if (!isCurrent()) return;
    ctx.runningKinds.delete(kind);
    if (ctx.queuedKinds.delete(kind)) await runCapture(ctx, kind, ctx.clock.now(), false);
  };

  await captureSnapshot({
    kind,
    capturedAt,
    oracleUrl: ctx.oracleUrl,
    profile: ctx.profile,
    store: ctx.store,
    events: ctx.events,
    clock: ctx.clock,
    initialLoad,
    isCurrent,
    failNext: () => {
      if (!ctx.failNext) return false;
      ctx.failNext = false;
      return true;
    },
    onFinished: async (captured) => {
      if (!captured.ok) {
        await fetch(`${ctx.foundryUrl}/lab/sync-failure`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: captured.message, kind, capturedAt }),
        }).catch(() => undefined);
        onResult?.(captured);
        return release();
      }
      const commit = async () => {
        await commitSnapshot({ id: captured.id, foundryUrl: ctx.foundryUrl, store: ctx.store, events: ctx.events, immediate: initialLoad });
        await release();
      };
      onResult?.({ ok: true, id: captured.id });
      if (initialLoad) return commit();
      scheduleCommit({
        clock: ctx.clock,
        at: ctx.clock.now() + ctx.profile.extractionMs + captured.rows.length * ctx.profile.extractionMsPerRow,
        epoch: () => ctx.epoch,
        run: commit,
      });
    },
  });
}

export { objectTypesFor };
