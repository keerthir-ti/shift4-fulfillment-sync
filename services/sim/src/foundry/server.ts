import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  EDIT_ONLY_PROPERTIES,
  fulfillmentOrderContent,
  fulfillmentOrderKey,
  fulfillmentOrderRow,
  fulfillmentOrders,
  salesOrderKey,
  salesOrderLineKey,
  shipmentContent,
  shipmentLineKey,
  shipmentSnapshotRow,
  type FulfillmentOrderView,
  type ObjectType,
  type OracleShipment,
  type Profile,
  type SnapshotRow,
} from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";
import { EventLog } from "../lab/events.js";
import { scheduleIndex } from "./indexing.js";
import { FoundryStore } from "./store.js";

export type FoundryContext = {
  scenarioId: string;
  profile: Profile;
  clock: Clock;
  store: FoundryStore;
  events: EventLog;
  epoch: number;
  failNextAction: boolean;
  /** Simulated outage: API calls return this status until the given time. */
  outage: { status: number; until: number } | null;
  generationSeq: number;
  /** Simulated clock difference between Foundry and Oracle, applied to edit times. */
  editClockOffsetMs: number;
};

export type RunningFoundry = {
  app: FastifyInstance;
  ctx: FoundryContext;
  url: string;
  port: number;
  stop: () => Promise<void>;
};

export function createFoundryContext(options: {
  scenarioId: string;
  profile: Profile;
  clock: Clock;
  dataDir: string;
}): FoundryContext {
  return {
    scenarioId: options.scenarioId,
    profile: options.profile,
    clock: options.clock,
    store: new FoundryStore(options.dataDir),
    events: new EventLog(options.scenarioId, "foundry", options.clock),
    epoch: 0,
    failNextAction: false,
    outage: null,
    generationSeq: 1,
    editClockOffsetMs: 0,
  };
}

export function buildFoundryApp(ctx: FoundryContext): FastifyInstance {
  // A full snapshot arrives as one request, and it can be large.
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 * 1024 });

  app.get("/health", async () => ({
    ok: true,
    service: "foundry",
    scenarioId: ctx.scenarioId,
    profile: ctx.profile.name,
  }));

  app.get("/lab/events", async () => ({ items: ctx.events.all() }));

  app.post("/lab/reset", async () => {
    ctx.epoch += 1;
    ctx.store.reset();
    ctx.events.clear();
    ctx.failNextAction = false;
    ctx.outage = null;
    return { ok: true };
  });

  app.post("/lab/faults", async (request) => {
    const body = request.body as { mode?: string; status?: number; forMs?: number; offsetMs?: number };
    if (body.mode === "edit-clock-offset") ctx.editClockOffsetMs = body.offsetMs ?? 0;
    if (body.mode === "validation") ctx.failNextAction = true;
    if (body.mode === "outage") ctx.outage = { status: body.status ?? 503, until: ctx.clock.now() + (body.forMs ?? 0) };
    return { ok: true };
  });

  app.get("/lab/query/:objectType", async (request, reply) => {
    const { objectType } = request.params as { objectType: string };
    if (!isObjectType(objectType)) return reply.code(404).send({ message: "Unknown object type" });
    const sync = ctx.store.syncState();
    return {
      objectType,
      items: ctx.store.listIndexed(objectType),
      syncStatus: sync.status,
      syncMessage: sync.message,
      indexedAt: ctx.store.listIndexed(objectType).at(-1)?.indexedAt ?? null,
    };
  });

  app.get("/lab/backing-generations", async () => ({ items: ctx.store.generations() }));

  app.get("/lab/backing-generations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const generation = ctx.store.generations().find((item) => item.id === id);
    if (!generation) return reply.code(404).send({ message: "Generation not found" });
    return { ...generation, rows: ctx.store.rows(id) };
  });

  app.post("/lab/sync-failure", async (request) => {
    const body = request.body as { message?: string; kind?: string; capturedAt?: number };
    const id = `fail-${ctx.generationSeq++}`;
    ctx.store.recordFailure(id, body.kind ?? "unknown", body.capturedAt ?? ctx.clock.now(), body.message ?? "snapshot failed", ctx.clock.now());
    ctx.events.record("foundry.sync.failed", { operationId: id, detail: { message: body.message } });
    return { ok: true, id };
  });

  app.post("/lab/edits", async (request, reply) => {
    const body = request.body as {
      objectType?: ObjectType;
      objectKey?: string;
      property?: string;
      value?: unknown;
      ownership?: "source" | "edit-only";
    };
    if (!body.objectType || !body.objectKey || !body.property || !isObjectType(body.objectType)) {
      return reply.code(400).send({ code: "VALIDATION", message: "objectType, objectKey, and property are required" });
    }
    const ownership = body.ownership ?? (EDIT_ONLY_PROPERTIES.includes(body.property as (typeof EDIT_ONLY_PROPERTIES)[number]) ? "edit-only" : "source");
    ctx.store.upsertEdit(body.objectType, body.objectKey, body.property, body.value, ctx.clock.now(), ownership);
    const current = ctx.store.getIndexed(body.objectType, body.objectKey);
    if (current) {
      ctx.store.upsertIndexed(body.objectType, body.objectKey, { ...current, [body.property]: body.value }, ctx.clock.now(), null);
    }
    return { ok: true };
  });

  app.post("/lab/backing-generations", async (request, reply) => {
    const body = request.body as {
      id?: string;
      kind?: string;
      capturedAt?: number;
      rows?: SnapshotRow[];
      objectTypes?: ObjectType[];
      immediate?: boolean;
      append?: boolean;
    };
    if (!body.kind || !Array.isArray(body.rows) || typeof body.capturedAt !== "number") {
      return reply.code(400).send({ message: "kind, capturedAt, and rows are required" });
    }
    const objectTypes = body.objectTypes?.length ? body.objectTypes : [...new Set(body.rows.map((row) => row.objectType))];
    const ambiguous = body.rows.find((row) => row.objectType === "ShipmentLine" && !correlates(row.properties));
    if (ambiguous) {
      const id = body.id ?? `gen-${ctx.generationSeq++}`;
      ctx.store.recordFailure(id, body.kind, body.capturedAt, "ambiguous shipment correlation", ctx.clock.now());
      ctx.events.record("foundry.sync.failed", { operationId: id, detail: { message: "ambiguous shipment correlation" } });
      return reply.code(422).send({
        message: "ambiguous shipment correlation: OrderNumber and organization are required when SourceOrderFulfillmentLineId is null",
      });
    }
    const id = body.id ?? `gen-${ctx.generationSeq++}`;
    const append = body.append === true;
    const derived = objectTypes.includes("ShipmentLine") ? transformToFulfillmentOrders(ctx, body.rows, append) : [];
    const types: ObjectType[] = derived.length > 0 || (objectTypes.includes("ShipmentLine") && !append) ? [...new Set<ObjectType>([...objectTypes, "FulfillmentOrder"])] : objectTypes;
    ctx.store.writeGeneration(id, body.kind, body.capturedAt, ctx.clock.now(), [...body.rows, ...derived], types);
    if (body.immediate) {
      ctx.store.publish(id, ctx.clock.now(), { append });
      ctx.events.record("foundry.indexed", { operationId: id, detail: { kind: body.kind, immediate: true } });
      return { ok: true, id, indexed: true };
    }
    const indexingMs = ctx.profile.indexingMs + body.rows.length * ctx.profile.indexingMsPerRow;
    scheduleIndex(ctx.store, ctx.clock, () => ctx.epoch, id, ctx.clock.now() + indexingMs, () => {
      ctx.events.record("foundry.indexed", { operationId: id, detail: { kind: body.kind } });
    }, { append });
    return { ok: true, id, indexed: false };
  });

  app.post("/api/v2/ontologies/local/objects/:objectType/search", async (request, reply) => {
    if (ctx.outage && ctx.clock.now() < ctx.outage.until) return reply.code(ctx.outage.status).send({ message: "injected outage" });
    const { objectType } = request.params as { objectType: string };
    if (!isObjectType(objectType)) return reply.code(404).send({ message: "Unknown object type" });
    const where = (request.body as { where?: SearchClause })?.where;
    const data = ctx.store
      .listIndexed(objectType)
      .filter((row) => !where || matches(row.properties, where))
      .map((row) => ({ __primaryKey: row.objectKey, ...row.properties }));
    return { data };
  });

  app.post("/api/v2/ontologies/local/actions/:action/apply", async (request, reply) => {
    const { action } = request.params as { action: string };
    if (ctx.outage && ctx.clock.now() < ctx.outage.until) return reply.code(ctx.outage.status).send({ message: "injected outage" });
    if (ctx.failNextAction) {
      ctx.failNextAction = false;
      return reply.code(400).send({ code: "VALIDATION", message: "injected action validation failure" });
    }
    const parameters = ((request.body as { parameters?: Record<string, unknown> })?.parameters ?? {}) as Record<string, unknown>;
    if (action === "mirror-sales-order") return mirrorSalesOrder(ctx, parameters, reply);
    if (action === "set-warehouse-lock") return setWarehouseLock(ctx, parameters, reply);
    if (action === "sync-shipment-lines") return syncShipmentLines(ctx, parameters, reply);
    if (action === "remove-shipment-lines") return removeShipmentLines(ctx, parameters, reply);
    if (action === "record-fulfillment-sync") return recordFulfillmentSync(ctx, parameters, reply);
    return reply.code(404).send({ message: `Unknown action ${action}` });
  });

  return app;
}

export async function startFoundry(options: {
  scenarioId: string;
  profile: Profile;
  clock: Clock;
  dataDir: string;
  port?: number;
}): Promise<RunningFoundry> {
  const ctx = createFoundryContext(options);
  const app = buildFoundryApp(ctx);
  try {
    await app.listen({ port: options.port ?? 0, host: process.env.BIND_HOST ?? "127.0.0.1" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Port ${options.port} is already in use (foundry). Stop the other process or set FOUNDRY_PORT.`);
    }
    throw error;
  }
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    ctx,
    port,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      await app.close();
      ctx.store.close();
    },
  };
}

function mirrorSalesOrder(ctx: FoundryContext, parameters: Record<string, unknown>, reply: FastifyReply) {
  const orderNumber = typeof parameters.orderNumber === "string" ? parameters.orderNumber : "";
  const headerId = typeof parameters.headerId === "string" ? parameters.headerId : "";
  const buyingPartyName = typeof parameters.buyingPartyName === "string" ? parameters.buyingPartyName : "";
  const organizationCode = typeof parameters.organizationCode === "string" ? parameters.organizationCode : "";
  const lines = Array.isArray(parameters.lines) ? parameters.lines : [];
  if (!orderNumber || !headerId || !buyingPartyName || !organizationCode || lines.length === 0) {
    return reply.code(400).send({ code: "VALIDATION", message: "orderNumber, headerId, buyingPartyName, organizationCode, and lines are required" });
  }
  for (const line of lines) {
    const record = line as Record<string, unknown>;
    if (typeof record.productNumber !== "string" || typeof record.quantity !== "number" || record.quantity <= 0 || typeof record.lineId !== "string") {
      return reply.code(400).send({ code: "VALIDATION", message: "each line needs lineId, productNumber, and a positive quantity" });
    }
  }
  const at = ctx.clock.now();
  const key = salesOrderKey(orderNumber);
  const submitted = parameters.submittedFlag === true;
  const properties: Record<string, unknown> = {
    orderNumber,
    headerId,
    sourceTransactionNumber: typeof parameters.sourceTransactionNumber === "string" ? parameters.sourceTransactionNumber : "",
    buyingPartyName,
    organizationCode,
    submittedFlag: submitted,
    status: submitted ? "Submitted" : "Draft",
    approvalStatus: submitted ? "Submitted" : "Draft",
    lastUpdateDate: typeof parameters.lastUpdateDate === "number" ? parameters.lastUpdateDate : at,
  };
  const activity = appendActivity(ctx, key, { at, action: submitted ? "approve" : "create", detail: orderNumber });
  properties.activity = activity;
  // The mirror replaces the row, so Foundry-only fields must be carried across.
  for (const edit of ctx.store.editsFor("SalesOrder", key)) {
    if (edit.ownership === "edit-only" && !(edit.property in properties)) properties[edit.property] = edit.value;
  }
  ctx.store.upsertEdit("SalesOrder", key, "approvalStatus", properties.approvalStatus, at, "edit-only");
  ctx.store.upsertEdit("SalesOrder", key, "activity", activity, at, "edit-only");
  ctx.store.upsertIndexed("SalesOrder", key, properties, at, typeof properties.lastUpdateDate === "number" ? properties.lastUpdateDate : at);
  const indexedLines = [];
  for (const line of lines) {
    const record = line as Record<string, unknown>;
    const lineKey = salesOrderLineKey(String(record.lineId));
    const lineProperties = {
      lineId: record.lineId,
      orderNumber,
      productNumber: record.productNumber,
      quantity: record.quantity,
      sourceLineId: record.sourceLineId ?? record.lineId,
    };
    ctx.store.upsertIndexed("SalesOrderLine", lineKey, lineProperties, at, at);
    indexedLines.push({ objectKey: lineKey, properties: lineProperties });
  }
  ctx.events.record("foundry.action.applied", { orderId: orderNumber, operationId: "mirror-sales-order" });
  return { ok: true, objectKey: key, properties, lines: indexedLines };
}

function setWarehouseLock(ctx: FoundryContext, parameters: Record<string, unknown>, reply: FastifyReply) {
  const orderNumber = typeof parameters.orderNumber === "string" ? parameters.orderNumber : "";
  if (!orderNumber || typeof parameters.locked !== "boolean") {
    return reply.code(400).send({ code: "VALIDATION", message: "orderNumber and locked are required" });
  }
  const key = salesOrderKey(orderNumber);
  const current = ctx.store.getIndexed("SalesOrder", key);
  if (!current) return reply.code(400).send({ code: "VALIDATION", message: "Sales order is not in the ontology" });
  const at = ctx.clock.now();
  ctx.store.upsertEdit("SalesOrder", key, "fulfillmentLock", parameters.locked, at, "edit-only");
  const activity = appendActivity(ctx, key, { at, action: "set-warehouse-lock", detail: String(parameters.locked) });
  ctx.store.upsertIndexed("SalesOrder", key, { ...current, fulfillmentLock: parameters.locked, activity }, at, null);
  ctx.events.record("foundry.action.applied", { orderId: orderNumber, operationId: "set-warehouse-lock" });
  return { ok: true, objectKey: key };
}

/** The transform: fulfillment orders come from shipment lines. An incremental run needs the order's other lines too. */
function transformToFulfillmentOrders(ctx: FoundryContext, rows: SnapshotRow[], append: boolean): SnapshotRow[] {
  const lines = rows.filter((row) => row.objectType === "ShipmentLine" && typeof row.properties.OrderNumber === "string");
  const byKey = new Map(lines.map((row) => [row.objectKey, row.properties]));
  if (append) {
    const touched = new Set(lines.map((row) => row.properties.OrderNumber));
    for (const existing of ctx.store.listIndexed("ShipmentLine")) {
      if (touched.has(existing.properties.OrderNumber) && !byKey.has(existing.objectKey)) byKey.set(existing.objectKey, existing.properties);
    }
  }
  return fulfillmentOrders([...byKey.values()]).map(fulfillmentOrderRow);
}

/**
 * The workflow's write, as Foundry edits. Each row is checked on its own, so one row can't block
 * the others. A row is skipped if Foundry holds a newer version, or the same version unchanged.
 * Nothing makes a fulfillment order appear unless the caller sends it, as with a real Action.
 */
function syncShipmentLines(ctx: FoundryContext, parameters: Record<string, unknown>, reply: FastifyReply) {
  const rows = Array.isArray(parameters.rows) ? (parameters.rows as OracleShipment[]) : [];
  const orders = Array.isArray(parameters.fulfillmentOrders) ? (parameters.fulfillmentOrders as FulfillmentOrderView[]) : [];
  if (rows.length === 0 && orders.length === 0) return reply.code(400).send({ code: "VALIDATION", message: "rows or fulfillmentOrders are required" });
  const prepared = rows.map((row) => ({ shipment: row, snapshotRow: shipmentSnapshotRow(row) }));
  const ambiguous = prepared.find(({ snapshotRow }) => !correlates(snapshotRow.properties));
  if (ambiguous) return reply.code(400).send({ code: "VALIDATION", message: `ambiguous shipment correlation for ${ambiguous.snapshotRow.objectKey}` });
  const editedAt = ctx.clock.now() + ctx.editClockOffsetMs;
  const applyEdit = (row: SnapshotRow) => {
    for (const [property, value] of Object.entries(row.properties)) ctx.store.upsertEdit(row.objectType, row.objectKey, property, value, editedAt, "source");
    // Foundry guarantees reads after an edit include it, so the object changes at once.
    ctx.store.upsertIndexed(row.objectType, row.objectKey, row.properties, ctx.clock.now(), row.sourceTimestamp);
  };
  let applied = 0;
  for (const { shipment, snapshotRow } of prepared) {
    const held = ctx.store.getIndexed("ShipmentLine", snapshotRow.objectKey) as OracleShipment | undefined;
    if (held && (held.LastUpdateDate > shipment.LastUpdateDate || (held.LastUpdateDate === shipment.LastUpdateDate && shipmentContent(held) === shipmentContent(shipment)))) continue;
    applyEdit(snapshotRow);
    applied += 1;
  }
  let ordersApplied = 0;
  for (const order of orders) {
    const row = fulfillmentOrderRow(order);
    const held = ctx.store.getIndexed("FulfillmentOrder", row.objectKey) as FulfillmentOrderView | undefined;
    if (held && fulfillmentOrderContent(held) === fulfillmentOrderContent(order) && held.lastUpdateDate >= order.lastUpdateDate) continue;
    applyEdit(row);
    ordersApplied += 1;
  }
  ctx.events.record("foundry.action.applied", { orderId: String(rows[0]?.OrderNumber ?? orders[0]?.orderNumber), operationId: "sync-shipment-lines", detail: { applied, skipped: rows.length - applied, ordersApplied } });
  return { ok: true, applied, skipped: rows.length - applied, ordersApplied };
}

function removeShipmentLines(ctx: FoundryContext, parameters: Record<string, unknown>, reply: FastifyReply) {
  const lines = Array.isArray(parameters.shipmentLines) ? (parameters.shipmentLines as string[]) : [];
  const orders = Array.isArray(parameters.fulfillmentOrders) ? (parameters.fulfillmentOrders as { orderNumber: string; warehouse: string }[]) : [];
  if (lines.length === 0 && orders.length === 0) return reply.code(400).send({ code: "VALIDATION", message: "shipmentLines or fulfillmentOrders are required" });
  for (const line of lines) ctx.store.deleteObject("ShipmentLine", shipmentLineKey(line));
  for (const order of orders) ctx.store.deleteObject("FulfillmentOrder", fulfillmentOrderKey(order.orderNumber, order.warehouse));
  ctx.events.record("foundry.action.applied", { operationId: "remove-shipment-lines", detail: { removed: lines.length, ordersRemoved: orders.length } });
  return { ok: true, removed: lines.length, ordersRemoved: orders.length };
}

function recordFulfillmentSync(ctx: FoundryContext, parameters: Record<string, unknown>, reply: FastifyReply) {
  const orderNumber = typeof parameters.orderNumber === "string" ? parameters.orderNumber : "";
  const stage = typeof parameters.stage === "string" ? parameters.stage : "";
  const message = typeof parameters.message === "string" ? parameters.message : "";
  if (!orderNumber || !stage) return reply.code(400).send({ code: "VALIDATION", message: "orderNumber and stage are required" });
  const key = salesOrderKey(orderNumber);
  const current = ctx.store.getIndexed("SalesOrder", key);
  if (!current) return reply.code(400).send({ code: "VALIDATION", message: "Sales order is not in the ontology" });
  // Retries and repeat runs send the same note again, and it must not repeat in the feed.
  const previous = ctx.store.editsFor("SalesOrder", key).find((edit) => edit.property === "fulfillmentSync")?.value as { stage?: string; message?: string } | undefined;
  if (previous?.stage === stage && previous?.message === message) return { ok: true, repeated: true };
  const at = ctx.clock.now();
  const fulfillmentSync = { stage, message, at };
  ctx.store.upsertEdit("SalesOrder", key, "fulfillmentSync", fulfillmentSync, at, "edit-only");
  const activity = appendActivity(ctx, key, { at, action: `fulfillment-sync:${stage}`, detail: message });
  ctx.store.upsertIndexed("SalesOrder", key, { ...current, fulfillmentSync, activity }, at, typeof current.lastUpdateDate === "number" ? current.lastUpdateDate : null);
  return { ok: true };
}

type SearchClause =
  | { type: "and"; value: SearchClause[] }
  | { type: "eq" | "gte"; field: string; value: unknown };

function matches(properties: Record<string, unknown>, clause: SearchClause): boolean {
  if (clause.type === "and") return clause.value.every((inner) => matches(properties, inner));
  const actual = properties[clause.field];
  if (clause.type === "eq") return actual === clause.value;
  return typeof actual === "number" && typeof clause.value === "number" && actual >= clause.value;
}

function appendActivity(ctx: FoundryContext, objectKey: string, entry: { at: number; action: string; detail: string }) {
  const existing = ctx.store.editsFor("SalesOrder", objectKey).find((edit) => edit.property === "activity");
  const list = Array.isArray(existing?.value) ? [...(existing.value as unknown[])] : [];
  list.push(entry);
  ctx.store.upsertEdit("SalesOrder", objectKey, "activity", list, entry.at, "edit-only");
  return list;
}

function correlates(properties: Record<string, unknown>): boolean {
  const orderNumber = properties.OrderNumber;
  const organization = properties.RequestedFulfillmentOrganizationCode;
  const fulfillmentId = properties.SourceOrderFulfillmentLineId;
  if (typeof orderNumber === "string" && orderNumber && typeof organization === "string" && organization) return true;
  return fulfillmentId !== null && fulfillmentId !== undefined && fulfillmentId !== "";
}

function isObjectType(value: string): value is ObjectType {
  return value === "SalesOrder" || value === "SalesOrderLine" || value === "ShipmentLine" || value === "FulfillmentOrder";
}
