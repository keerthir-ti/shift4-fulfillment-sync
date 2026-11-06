import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { paginate, type Profile, type ReferenceData } from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";
import { EventLog } from "../lab/events.js";
import { OracleCallBudget } from "./call-budget.js";
import { armFulfillment } from "./processing.js";
import { findCustomer, findItem, findOrganization } from "./reference-data.js";
import { OracleStore, type LineRecord, type OrderRecord, type ShipmentRecord } from "./store.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
const READ_ONLY = ["HeaderId", "OrderNumber", "LastUpdateDate", "ShipmentLine", "CreatedBy"];

export type Fault =
  | { mode: "status"; status: number; pathIncludes?: string; retryAfterSec?: number }
  | { mode: "lose-response" };

export type OracleContext = {
  scenarioId: string;
  profile: Profile;
  reference: ReferenceData;
  clock: Clock;
  store: OracleStore;
  events: EventLog;
  requests: { method: string; url: string }[];
  faults: Fault[];
  epoch: number;
  callBudget: OracleCallBudget | null;
  /** Calls the budget turned away, and who made them. */
  rateLimited: { caller: string; url: string; at: number }[];
};

export type RunningOracle = {
  app: FastifyInstance;
  ctx: OracleContext;
  url: string;
  port: number;
  stop: () => Promise<void>;
};

export function createOracleContext(options: {
  scenarioId: string;
  profile: Profile;
  reference: ReferenceData;
  clock: Clock;
  dataDir: string;
}): OracleContext {
  return {
    scenarioId: options.scenarioId,
    profile: options.profile,
    reference: options.reference,
    clock: options.clock,
    store: new OracleStore(options.dataDir),
    events: new EventLog(options.scenarioId, "oracle", options.clock),
    requests: [],
    faults: [],
    epoch: 0,
    callBudget: options.profile.oracleCallsPerMinute ? new OracleCallBudget(options.profile.oracleCallsPerMinute, options.clock) : null,
    rateLimited: [],
  };
}

export function buildOracleApp(ctx: OracleContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    ctx.requests.push({ method: request.method, url: request.url });
    if (!ctx.callBudget || !request.url.startsWith(PREFIX) || request.headers["x-sim-initial-load"]) return;
    const retryAfterSec = ctx.callBudget.spend();
    if (retryAfterSec === 0) return;
    const caller = request.headers["x-sim-caller"];
    ctx.rateLimited.push({ caller: typeof caller === "string" ? caller : "app-or-worker", url: request.url, at: ctx.clock.now() });
    return reply.code(429).header("retry-after", String(retryAfterSec)).send({ message: "Oracle call budget used up" });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "oracle",
    scenarioId: ctx.scenarioId,
    profile: ctx.profile.name,
  }));

  app.post("/lab/reset", async () => {
    ctx.epoch += 1;
    ctx.store.reset();
    ctx.events.clear();
    ctx.requests.length = 0;
    ctx.rateLimited.length = 0;
    ctx.faults.length = 0;
    ctx.callBudget = ctx.profile.oracleCallsPerMinute ? new OracleCallBudget(ctx.profile.oracleCallsPerMinute, ctx.clock) : null;
    return { ok: true };
  });

  app.post("/lab/faults", async (request, reply) => {
    const body = request.body as Fault;
    if (body?.mode !== "status" && body?.mode !== "lose-response") {
      return reply.code(400).send({ message: "fault mode must be status or lose-response" });
    }
    if (body.mode === "status" && !Number.isInteger(body.status)) {
      return reply.code(400).send({ message: "status fault requires an integer status" });
    }
    ctx.faults.push(body);
    return { ok: true, queued: ctx.faults.length };
  });

  app.post("/lab/captures", async () => {
    const token = ctx.store.openCapture(ctx.clock.now());
    return { token, capturedAt: ctx.clock.now(), simulatorOnly: true };
  });

  app.get("/lab/events", async () => ({ items: ctx.events.all() }));

  app.post("/lab/orders/:headerId/cancel", async (request, reply) => {
    const { headerId } = request.params as { headerId: string };
    if (!ctx.store.findOrder(headerId)) return reply.code(404).send({ message: "Sales order not found" });
    ctx.store.cancelOrder(headerId, ctx.clock.now());
    return { ok: true };
  });

  app.post("/lab/shipments/:shipmentId", async (request, reply) => {
    const { shipmentId } = request.params as { shipmentId: string };
    const body = asRecord(request.body);
    const at = ctx.clock.now();
    if (typeof body.organizationCode === "string") ctx.store.setShipmentOrganization(shipmentId, body.organizationCode, at);
    if (typeof body.lineStatus === "string" && !ctx.store.setShipmentStatus(shipmentId, body.lineStatus, at)) {
      return reply.code(404).send({ message: "Shipment line not found" });
    }
    return { ok: true };
  });

  app.post(`${PREFIX}/salesOrders`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    const body = asRecord(request.body);
    const readOnly = READ_ONLY.find((field) => field in body);
    if (readOnly) return reply.code(400).send({ code: "VALIDATION", message: `${readOnly} is read-only` });
    if (body.SubmittedFlag !== false) {
      return reply.code(400).send({ code: "VALIDATION", message: "SubmittedFlag must be false when creating a draft" });
    }
    const source = stringField(body, "SourceTransactionNumber");
    const party = stringField(body, "BuyingPartyName");
    const org = stringField(body, "RequestedFulfillmentOrganizationCode");
    if (!source || !party || !org) {
      return reply.code(400).send({ code: "VALIDATION", message: "SourceTransactionNumber, BuyingPartyName, and RequestedFulfillmentOrganizationCode are required" });
    }
    if (!findCustomer(ctx.reference, party)) {
      return reply.code(400).send({ code: "VALIDATION", message: `Unknown customer ${party}` });
    }
    if (!findOrganization(ctx.reference, org)) {
      return reply.code(400).send({ code: "VALIDATION", message: `Unknown organization ${org}` });
    }
    const existing = ctx.store.findBySource(source);
    if (existing) {
      return reply.code(200).send({ ...orderBody(existing, request), outcome: "reconciled" });
    }
    const created = ctx.store.createOrder({
      sourceTransactionNumber: source,
      buyingPartyName: party,
      organizationCode: org,
      businessUnit: stringField(body, "BusinessUnitName") || ctx.reference.businessUnit,
      at: ctx.clock.now(),
    });
    if (loseResponse(ctx)) {
      return reply.code(504).send({
        outcome: "uncertain",
        message: "Oracle committed the sales order but the response was lost",
        sourceTransactionNumber: source,
        headerId: created.headerId,
        orderNumber: created.orderNumber,
      });
    }
    return reply.code(201).send(orderBody(created, request));
  });

  app.post(`${PREFIX}/salesOrders/:headerId/child/lines`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    const { headerId } = request.params as { headerId: string };
    const order = ctx.store.findOrder(headerId);
    if (!order) return reply.code(404).send({ message: "Sales order not found" });
    const body = asRecord(request.body);
    const readOnly = READ_ONLY.find((field) => field in body);
    if (readOnly) return reply.code(400).send({ code: "VALIDATION", message: `${readOnly} is read-only` });
    const product = stringField(body, "ProductNumber");
    const quantity = body.OrderedQuantity;
    if (!product || typeof quantity !== "number" || quantity <= 0) {
      return reply.code(400).send({ code: "VALIDATION", message: "ProductNumber and a positive OrderedQuantity are required" });
    }
    const item = findItem(ctx.reference, product);
    if (!item) return reply.code(400).send({ code: "VALIDATION", message: `Unknown product ${product}` });
    if (!item.stocked) return reply.code(400).send({ code: "VALIDATION", message: `${product} is not stocked` });
    const line = ctx.store.addLine(headerId, product, quantity, ctx.clock.now());
    return reply.code(201).send(lineBody(line));
  });

  app.post(`${PREFIX}/salesOrders/:headerId/action/submit`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    const { headerId } = request.params as { headerId: string };
    const order = ctx.store.findOrder(headerId);
    if (!order) return reply.code(404).send({ message: "Sales order not found" });
    const body = asRecord(request.body);
    if (body.SubmittedFlag !== true) {
      return reply.code(400).send({ code: "VALIDATION", message: "SubmittedFlag must be true to submit" });
    }
    if (ctx.store.lines(headerId).length === 0) {
      return reply.code(400).send({ code: "VALIDATION", message: "Cannot submit an order with no lines" });
    }
    if (order.submittedFlag) return reply.send(orderBody(order, request));
    let submitted: OrderRecord;
    try {
      armFulfillment(ctx.store, ctx.clock, ctx.profile, ctx.reference, () => ctx.epoch, headerId, (shipment) => {
        ctx.events.record("oracle.shipment.ready", {
          orderId: shipment.orderNumber,
          operationId: shipment.shipmentId,
          detail: { quantity: shipment.quantity, sourceLineId: shipment.sourceLineId },
        });
      });
      submitted = ctx.store.markSubmitted(headerId, ctx.clock.now());
    } catch (error) {
      return reply.code(400).send({ code: "VALIDATION", message: error instanceof Error ? error.message : "submit failed" });
    }
    ctx.events.record("oracle.order.submitted", { orderId: submitted.orderNumber, operationId: submitted.headerId });
    if (loseResponse(ctx)) {
      return reply.code(504).send({
        outcome: "uncertain",
        message: "Oracle submitted the order but the response was lost",
        headerId,
        orderNumber: submitted.orderNumber,
      });
    }
    return reply.send(orderBody(submitted, request));
  });

  app.get(`${PREFIX}/salesOrders/:headerId`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    const { headerId } = request.params as { headerId: string };
    const order = ctx.store.findOrder(headerId);
    if (!order) return reply.code(404).send({ message: "Sales order not found" });
    return orderBody(order, request);
  });

  app.get(`${PREFIX}/salesOrders/:headerId/child/lines`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    const { headerId } = request.params as { headerId: string };
    if (!ctx.store.findOrder(headerId)) return reply.code(404).send({ message: "Sales order not found" });
    const query = request.query as Record<string, string>;
    if (unsupportedQuery(query)) return reply.code(400).send({ code: "VALIDATION", message: "Unsupported query syntax" });
    const { limit, offset } = pageQuery(query, ctx.profile.pageSize);
    return paginate(ctx.store.lines(headerId).map(lineBody), limit, offset);
  });

  app.get(`${PREFIX}/salesOrders`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    if (unsupportedQuery(request.query as Record<string, string>)) return reply.code(400).send({ code: "VALIDATION", message: "Unsupported query syntax" });
    const query = withFilters(request.query as Record<string, string>);
    const source = resolveOrders(ctx, query);
    if (!source) return reply.code(400).send({ message: "Unknown capture token" });
    let orders = source.orders;
    if (query.orderNumber) orders = orders.filter((order) => order.orderNumber === query.orderNumber);
    if (query.organization) orders = orders.filter((order) => order.organizationCode === query.organization);
    if (query.sourceTransactionNumber) orders = orders.filter((order) => order.sourceTransactionNumber === query.sourceTransactionNumber);
    const { limit, offset } = pageQuery(query, ctx.profile.pageSize);
    const lines = source.lines;
    return paginate(
      orders.map((order) => ({
        ...orderBody(order, request),
        lines: lines.filter((line) => line.headerId === order.headerId).map(lineBody),
      })),
      limit,
      offset,
    );
  });

  app.get(`${PREFIX}/shipmentLines`, async (request, reply) => {
    if (await statusFault(ctx, reply, request.url)) return;
    if (unsupportedQuery(request.query as Record<string, string>)) return reply.code(400).send({ code: "VALIDATION", message: "Unsupported query syntax" });
    const query = withFilters(request.query as Record<string, string>);
    const source = resolveShipments(ctx, query);
    if (!source) return reply.code(400).send({ message: "Unknown capture token" });
    let rows = source;
    if (query.organization) rows = rows.filter((row) => row.organizationCode === query.organization);
    const { limit, offset } = pageQuery(query, ctx.profile.pageSize);
    return paginate(rows.map(shipmentBody), limit, offset);
  });

  return app;
}

export async function startOracle(options: {
  scenarioId: string;
  profile: Profile;
  reference: ReferenceData;
  clock: Clock;
  dataDir: string;
  port?: number;
}): Promise<RunningOracle> {
  const ctx = createOracleContext(options);
  const app = buildOracleApp(ctx);
  try {
    await app.listen({ port: options.port ?? 0, host: process.env.BIND_HOST ?? "127.0.0.1" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new Error(`Port ${options.port} is already in use (oracle). Stop the other process or set ORACLE_PORT.`);
    }
    throw error;
  }
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    ctx,
    port,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await app.close();
      ctx.store.close();
    },
  };
}

function resolveOrders(ctx: OracleContext, query: Record<string, string>) {
  if (!query.captureToken) return { orders: ctx.store.orders(), lines: ctx.store.allLines() };
  const frozen = ctx.store.capture(query.captureToken);
  if (!frozen) return undefined;
  return frozen;
}

function resolveShipments(ctx: OracleContext, query: Record<string, string>): ShipmentRecord[] | undefined {
  if (!query.captureToken) return query.orderNumber ? ctx.store.shipmentsForOrder(query.orderNumber) : ctx.store.shipments();
  const frozen = ctx.store.capture(query.captureToken)?.shipments;
  return query.orderNumber ? frozen?.filter((row) => row.orderNumber === query.orderNumber) : frozen;
}

async function statusFault(ctx: OracleContext, reply: FastifyReply, url: string): Promise<boolean> {
  const index = ctx.faults.findIndex((fault) => fault.mode === "status" && (!fault.pathIncludes || url.includes(fault.pathIncludes)));
  if (index === -1) return false;
  const fault = ctx.faults.splice(index, 1)[0];
  if (fault.mode !== "status") return false;
  if (fault.retryAfterSec !== undefined) reply.header("retry-after", String(fault.retryAfterSec));
  await reply.code(fault.status).send({ message: "injected upstream fault", status: fault.status });
  return true;
}

function loseResponse(ctx: OracleContext): boolean {
  const index = ctx.faults.findIndex((fault) => fault.mode === "lose-response");
  if (index === -1) return false;
  ctx.faults.splice(index, 1);
  return true;
}

function orderBody(order: OrderRecord, request: FastifyRequest) {
  const base = `http://${request.headers.host}${PREFIX}/salesOrders/${order.headerId}`;
  return {
    HeaderId: order.headerId,
    OrderNumber: order.orderNumber,
    SourceTransactionNumber: order.sourceTransactionNumber,
    BuyingPartyName: order.buyingPartyName,
    RequestedFulfillmentOrganizationCode: order.organizationCode,
    BusinessUnitName: order.businessUnit,
    SubmittedFlag: order.submittedFlag,
    Status: order.status,
    LastUpdateDate: order.lastUpdateMs,
    links: [
      { rel: "self", href: base },
      { rel: "lines", href: `${base}/child/lines` },
      { rel: "submit", href: `${base}/action/submit` },
    ],
  };
}

function lineBody(line: LineRecord) {
  return {
    LineId: line.lineId,
    HeaderId: line.headerId,
    ProductNumber: line.productNumber,
    OrderedQuantity: line.quantity,
    SourceLineId: line.sourceLineId,
    Status: line.status,
    LastUpdateDate: line.lastUpdateMs,
  };
}

function shipmentBody(shipment: ShipmentRecord) {
  return {
    ShipmentLine: shipment.shipmentId,
    OrderNumber: shipment.orderNumber,
    SourceLineId: shipment.sourceLineId,
    SourceOrderFulfillmentLineId: shipment.sourceOrderFulfillmentLineId,
    OrderedQuantity: shipment.quantity,
    ProductNumber: shipment.productNumber,
    RequestedFulfillmentOrganizationCode: shipment.organizationCode,
    BuyingPartyName: shipment.buyingPartyName,
    LineStatus: shipment.lineStatus,
    LastUpdateDate: shipment.lastUpdateMs,
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] : "";
}

/** The small part of Oracle's q syntax these simulators need: one attribute equal to a quoted value. */
const Q_FILTER = /^(SourceTransactionNumber|OrderNumber)='((?:[^']|'')*)'$/;

function unsupportedQuery(query: Record<string, string>): boolean {
  if ("finder" in query || "orderBy" in query) return true;
  return "q" in query && !Q_FILTER.test(query.q);
}

/** Turns a supported q filter into the plain filters the handlers use. */
function withFilters(query: Record<string, string>): Record<string, string> {
  const match = query.q ? Q_FILTER.exec(query.q) : null;
  if (!match) return query;
  const value = match[2].replace(/''/g, "'");
  return { ...query, [match[1] === "OrderNumber" ? "orderNumber" : "sourceTransactionNumber"]: value };
}

function pageQuery(query: Record<string, string>, fallback: number): { limit: number; offset: number } {
  const limit = query.limit ? Number(query.limit) : fallback;
  const offset = query.offset ? Number(query.offset) : 0;
  return { limit: Number.isFinite(limit) && limit > 0 ? limit : fallback, offset: Number.isFinite(offset) && offset >= 0 ? offset : 0 };
}
