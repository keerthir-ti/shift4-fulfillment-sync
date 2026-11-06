import {
  presentProperties,
  salesOrderKey,
  salesOrderLineKey,
  shipmentSnapshotRow,
  type Collection,
  type ObjectType,
  type OracleShipment,
  type Profile,
  type SnapshotKind,
  type SnapshotRow,
} from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";
import type { EventLog } from "../lab/events.js";
import type { ConnectorStore } from "./store.js";

type OracleOrder = {
  OrderNumber: string;
  HeaderId: string;
  SourceTransactionNumber: string;
  BuyingPartyName: string;
  RequestedFulfillmentOrganizationCode: string;
  SubmittedFlag: boolean;
  Status: string;
  LastUpdateDate: number;
  lines?: {
    LineId: string;
    ProductNumber: string;
    OrderedQuantity: number;
    SourceLineId: string;
    LastUpdateDate: number;
  }[];
};

export function objectTypesFor(kind: SnapshotKind): ObjectType[] {
  return kind === "orders" ? ["SalesOrder", "SalesOrderLine"] : ["ShipmentLine"];
}

export type CaptureResult = { ok: true; id: string; rows: SnapshotRow[] } | { ok: false; message: string };

/**
 * Reads a frozen view of Oracle page by page. Reading can span a long time, so a wait never holds up
 * the caller: it schedules the next page on the clock and returns. `onFinished` runs once, at the end.
 * A 429 with Retry-After waits and continues the same run. Any other failure ends the run.
 */
export async function captureSnapshot(options: {
  kind: SnapshotKind;
  capturedAt: number;
  oracleUrl: string;
  profile: Profile;
  store: ConnectorStore;
  events: EventLog;
  clock: Clock;
  failNext: () => boolean;
  /** The first load at startup, which models data already in place, so it costs no time or budget. */
  initialLoad: boolean;
  /** Set for an incremental run: read only rows changed since this time. */
  updatedSince?: number;
  isCurrent: () => boolean;
  onFinished: (result: CaptureResult) => Promise<void>;
}): Promise<void> {
  const { kind, capturedAt, clock, profile } = options;
  options.events.record("connector.capture.started", { operationId: kind, detail: { capturedAt, kind } });
  const opened = await fetch(`${options.oracleUrl}/lab/captures`, { method: "POST" });
  if (!opened.ok) return options.onFinished({ ok: false, message: `capture token failed (${opened.status})` });
  const { token } = (await opened.json()) as { token: string };
  const path = kind === "orders" ? "/fscmRestApi/resources/11.13.18.05/salesOrders" : "/fscmRestApi/resources/11.13.18.05/shipmentLines";
  const headers: Record<string, string> = { "x-sim-caller": "connector" };
  if (options.initialLoad) headers["x-sim-initial-load"] = "true";
  const rows: SnapshotRow[] = [];

  const resumeAfter = (waitMs: number, offset: number) => {
    clock.schedule(clock.now() + waitMs, async () => {
      if (options.isCurrent()) await readPagesFrom(offset);
    });
  };

  const readPagesFrom = async (start: number): Promise<void> => {
    for (let offset = start; ; offset += profile.pageSize) {
      const url = `${options.oracleUrl}${path}?captureToken=${encodeURIComponent(token)}&limit=${profile.pageSize}&offset=${offset}${options.updatedSince === undefined ? "" : `&updatedSince=${options.updatedSince}`}`;
      const response = await fetch(url, { headers });
      const retryAfterSec = Number(response.headers.get("retry-after") ?? 0);
      if (response.status === 429 && retryAfterSec > 0) {
        options.events.record("connector.capture.rate-limited", { operationId: kind, detail: { capturedAt, offset, retryAfterSec } });
        return resumeAfter(retryAfterSec * 1000, offset);
      }
      if (!response.ok) {
        options.events.record("connector.snapshot.failed", { operationId: kind, detail: { capturedAt, status: response.status } });
        return options.onFinished({ ok: false, message: `snapshot page failed with ${response.status}` });
      }
      const page = (await response.json()) as Collection<OracleOrder | OracleShipment>;
      if (kind === "orders") rows.push(...mapOrders(page.items as OracleOrder[]));
      else rows.push(...(page.items as OracleShipment[]).map(shipmentSnapshotRow));
      if (!page.hasMore) return finish();
      if (!options.initialLoad && profile.oracleMsPerPage > 0) return resumeAfter(profile.oracleMsPerPage, offset + profile.pageSize);
    }
  };

  const finish = async (): Promise<void> => {
    if (options.failNext()) {
      options.events.record("connector.snapshot.failed", { operationId: kind, detail: { capturedAt, reason: "injected" } });
      return options.onFinished({ ok: false, message: "injected snapshot failure" });
    }
    const id = options.store.nextId(kind, capturedAt);
    options.store.save({ id, kind, capturedAt, status: "captured", rows, objectTypes: objectTypesFor(kind), error: null });
    options.events.record("connector.capture.frozen", { operationId: id, detail: { kind, capturedAt, count: rows.length } });
    return options.onFinished({ ok: true, id, rows });
  };

  return readPagesFrom(0);
}

export async function commitSnapshot(options: {
  id: string;
  foundryUrl: string;
  store: ConnectorStore;
  events: EventLog;
  immediate: boolean;
  append: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  const generation = options.store.get(options.id);
  if (!generation) return { ok: false, message: "generation missing" };
  const response = await fetch(`${options.foundryUrl}/lab/backing-generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: generation.id,
      kind: generation.kind,
      capturedAt: generation.capturedAt,
      rows: generation.rows,
      objectTypes: generation.objectTypes,
      immediate: options.immediate,
      append: options.append,
    }),
  });
  if (!response.ok) {
    const message = `foundry rejected snapshot (${response.status})`;
    options.store.update(generation.id, "failed", message);
    options.events.record("connector.snapshot.failed", { operationId: generation.id, detail: { message } });
    return { ok: false, message };
  }
  options.store.update(generation.id, "committed", null);
  options.events.record("connector.snapshot.committed", {
    operationId: generation.id,
    detail: { kind: generation.kind, capturedAt: generation.capturedAt, count: generation.rows.length },
  });
  return { ok: true };
}

export function scheduleCommit(options: {
  clock: Clock;
  at: number;
  epoch: () => number;
  run: () => Promise<void>;
}): void {
  const token = options.epoch();
  options.clock.schedule(options.at, async () => {
    if (options.epoch() !== token) return;
    await options.run();
  });
}

function mapOrders(orders: OracleOrder[]): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const order of orders) {
    const properties = {
      orderNumber: order.OrderNumber,
      headerId: order.HeaderId,
      sourceTransactionNumber: order.SourceTransactionNumber,
      buyingPartyName: order.BuyingPartyName,
      organizationCode: order.RequestedFulfillmentOrganizationCode,
      submittedFlag: order.SubmittedFlag,
      status: order.Status,
      lastUpdateDate: order.LastUpdateDate,
    };
    rows.push({
      objectType: "SalesOrder",
      objectKey: salesOrderKey(order.OrderNumber),
      sourceTimestamp: order.LastUpdateDate,
      ...presentProperties(properties),
    });
    for (const line of order.lines ?? []) {
      const lineProperties = {
        lineId: line.LineId,
        orderNumber: order.OrderNumber,
        productNumber: line.ProductNumber,
        quantity: line.OrderedQuantity,
        sourceLineId: line.SourceLineId,
      };
      rows.push({
        objectType: "SalesOrderLine",
        objectKey: salesOrderLineKey(line.LineId),
        sourceTimestamp: line.LastUpdateDate,
        ...presentProperties(lineProperties),
      });
    }
  }
  return rows;
}
