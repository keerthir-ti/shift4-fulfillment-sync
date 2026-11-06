/**
 * The swap boundary. Shift4 implements OracleOrderReader and FoundryFulfillmentStore with its own
 * helpers, and the workflow and activities only see these interfaces. RecoveryIndex and
 * DeliveryEventSink are optional. The HTTP implementations below talk to the local simulators.
 */
import { parseTimestamp, type OracleShipment } from "@shift4/contracts";

export class SystemHttpError extends Error {
  constructor(
    readonly system: "oracle" | "foundry",
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "SystemHttpError";
  }
}

export type OracleOrderView = {
  headerId: string;
  orderNumber: string;
  submitted: boolean;
  /** Order-level status, for example Canceled. */
  status: string;
  lines: { sourceLineId: string; quantity: number; status: string }[];
};

export interface OracleOrderReader {
  /** null, not an error, when Oracle holds no order for this source number. A lost response depends on it. */
  findOrder(orderKey: string): Promise<OracleOrderView | null>;
  /** Every shipment line of one order, across all pages and all warehouses. LastUpdateDate in epoch ms. */
  listShipmentLines(orderNumber: string): Promise<OracleShipment[]>;
}

export interface FoundryFulfillmentStore {
  /** Writes every snapshot-owned field. Rows Foundry already holds unchanged, or newer, are skipped. */
  writeShipmentLines(rows: OracleShipment[]): Promise<{ applied: number; skipped: number }>;
  /** What Foundry holds now for one order. LastUpdateDate in epoch ms. */
  readShipmentLines(orderNumber: string): Promise<OracleShipment[]>;
  /** Removes rows Oracle no longer has, because an object created by an Action outlives its source row. */
  removeShipmentLines(shipmentLines: string[]): Promise<void>;
  recordDeliveryStatus(entry: { orderNumber: string; stage: string; message: string }): Promise<void>;
}

/** Optional. Only the recovery sweep uses this. */
export interface RecoveryIndex {
  /** Source numbers of recent submitted orders with no final delivery status, newest first. */
  listOrdersNeedingDelivery(query: { since: number; limit: number }): Promise<string[]>;
}

export type DeliveryEvent = { orderKey: string; orderNumber?: string; stage: string; message: string; at: string };

/** Optional. Receives every stage change, to keep beyond Temporal's retention or to raise alerts. */
export interface DeliveryEventSink {
  record(event: DeliveryEvent): Promise<void>;
}

type HttpOptions = { baseUrl: string; authorization?: string; timeoutMs?: number };

async function request(system: "oracle" | "foundry", options: HttpOptions, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.authorization) headers.authorization = options.authorization;
  try {
    return await fetch(`${options.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new SystemHttpError(system, 0, `${system} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function failure(system: "oracle" | "foundry", response: Response): Promise<SystemHttpError> {
  const text = await response.text().catch(() => "");
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return new SystemHttpError(system, response.status, `${system} ${response.status}: ${text.slice(0, 200)}`, retryAfter > 0 ? retryAfter : undefined);
}

const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function createHttpOracleReader(options: HttpOptions & { version?: string; pageSize?: number }): OracleOrderReader {
  const base = `/fscmRestApi/resources/${options.version ?? "11.13.18.05"}`;
  const pageSize = options.pageSize ?? 100;
  return {
    async findOrder(orderKey) {
      const q = encodeURIComponent(`SourceTransactionNumber=${quoted(orderKey)}`);
      const response = await request("oracle", options, `${base}/salesOrders?q=${q}&limit=1`);
      if (!response.ok) throw await failure("oracle", response);
      const body = (await response.json()) as {
        items: { HeaderId: string; OrderNumber: string; SubmittedFlag: boolean; Status: string; lines?: { SourceLineId: string; OrderedQuantity: number; Status?: string }[] }[];
      };
      const order = body.items[0];
      if (!order) return null;
      return {
        headerId: order.HeaderId,
        orderNumber: order.OrderNumber,
        submitted: order.SubmittedFlag,
        status: order.Status,
        lines: (order.lines ?? []).map((line) => ({ sourceLineId: line.SourceLineId, quantity: line.OrderedQuantity, status: line.Status ?? "Open" })),
      };
    },
    async listShipmentLines(orderNumber) {
      const q = encodeURIComponent(`OrderNumber=${quoted(orderNumber)}`);
      const rows: OracleShipment[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const response = await request("oracle", options, `${base}/shipmentLines?q=${q}&limit=${pageSize}&offset=${offset}`);
        if (!response.ok) throw await failure("oracle", response);
        const body = (await response.json()) as { items: OracleShipment[]; hasMore: boolean };
        rows.push(...body.items.map((row) => ({ ...row, LastUpdateDate: parseTimestamp(row.LastUpdateDate) })));
        if (!body.hasMore) return rows;
      }
    },
  };
}

type FoundryObject = { __primaryKey: string } & Record<string, unknown>;

function foundryApi(options: HttpOptions & { ontology?: string }) {
  const base = `/api/v2/ontologies/${options.ontology ?? "local"}`;
  return {
    async applyAction<T>(action: string, parameters: Record<string, unknown>): Promise<T> {
      const response = await request("foundry", options, `${base}/actions/${action}/apply`, { method: "POST", body: JSON.stringify({ parameters }) });
      if (!response.ok) throw await failure("foundry", response);
      return (await response.json()) as T;
    },
    async search(objectType: string, where: unknown): Promise<FoundryObject[]> {
      const response = await request("foundry", options, `${base}/objects/${objectType}/search`, { method: "POST", body: JSON.stringify({ where }) });
      if (!response.ok) throw await failure("foundry", response);
      return ((await response.json()) as { data: FoundryObject[] }).data;
    },
  };
}

export function createHttpFoundryStore(options: HttpOptions & { ontology?: string }): FoundryFulfillmentStore {
  const api = foundryApi(options);
  return {
    async writeShipmentLines(rows) {
      const result = await api.applyAction<{ applied: number; skipped: number }>("sync-shipment-lines", { rows });
      return { applied: result.applied, skipped: result.skipped };
    },
    async readShipmentLines(orderNumber) {
      const objects = await api.search("ShipmentLine", { type: "eq", field: "OrderNumber", value: orderNumber });
      return objects.map(({ __primaryKey: _key, ...row }) => ({ ...row, LastUpdateDate: parseTimestamp(row.LastUpdateDate) }) as unknown as OracleShipment);
    },
    async removeShipmentLines(shipmentLines) {
      await api.applyAction("remove-shipment-lines", { shipmentLines });
    },
    async recordDeliveryStatus(entry) {
      await api.applyAction("record-fulfillment-sync", entry);
    },
  };
}

const FINAL_STAGES = new Set(["DeliveryVerified", "CanceledInOracle", "OperatorStopped"]);

export function createHttpRecoveryIndex(options: HttpOptions & { ontology?: string }): RecoveryIndex {
  const api = foundryApi(options);
  return {
    async listOrdersNeedingDelivery({ since, limit }) {
      const orders = await api.search("SalesOrder", {
        type: "and",
        value: [
          { type: "eq", field: "submittedFlag", value: true },
          { type: "gte", field: "lastUpdateDate", value: since },
        ],
      });
      return orders
        .filter((order) => !FINAL_STAGES.has(String((order.fulfillmentSync as { stage?: string } | undefined)?.stage)))
        .sort((a, b) => Number(b.lastUpdateDate) - Number(a.lastUpdateDate))
        .map((order) => order.sourceTransactionNumber)
        .filter((key): key is string => typeof key === "string" && key.length > 0)
        .slice(0, limit);
    },
  };
}
