export type SnapshotKind = "orders" | "shipment-lines";

export type Profile = {
  name: string;
  oracleProcessingMs: number;
  snapshotIntervalMs: number;
  orderSnapshotIntervalMs: number;
  shipmentSnapshotIntervalMs: number;
  extractionMs: number;
  indexingMs: number;
  uiRefreshMs: number;
  pageSize: number;
  /** Time Oracle takes to return one page to the connector. */
  oracleMsPerPage: number;
  /** Added to extractionMs for every row in the snapshot. */
  extractionMsPerRow: number;
  /** Added to indexingMs for every row in the snapshot. */
  indexingMsPerRow: number;
  /** Oracle REST calls allowed per minute, shared by every caller. null means no limit. */
  oracleCallsPerMinute: number | null;
};

export type FixtureItem = {
  productNumber: string;
  name: string;
  stocked: boolean;
  splits?: { quantity: number; readyOffsetMs: number }[];
};

export type ReferenceData = {
  scenarioId: string;
  resourceVersion: string;
  businessUnit: string;
  customers: { name: string }[];
  organizations: { code: string; name: string }[];
  items: FixtureItem[];
  lineQuantity: number;
  expectedShipmentId: string;
  expectedShipmentQuantity: number;
};

export const EDIT_ONLY_PROPERTIES = ["approvalStatus", "fulfillmentLock", "activity", "fulfillmentSync"] as const;

export type ObjectType = "SalesOrder" | "SalesOrderLine" | "ShipmentLine";

export type SnapshotRow = {
  objectType: ObjectType;
  objectKey: string;
  sourceTimestamp: number | null;
  properties: Record<string, unknown>;
  present: string[];
};

export const salesOrderKey = (orderNumber: string) => `sales-order:${orderNumber}`;
export const salesOrderLineKey = (lineId: string) => `sales-order-line:${lineId}`;
export const shipmentLineKey = (shipmentId: string) => `shipment-line:${shipmentId}`;

export function acceleratedProfile(overrides: Partial<Profile> = {}): Profile {
  const snapshotIntervalMs = overrides.snapshotIntervalMs ?? 60_000;
  return {
    name: overrides.name ?? "accelerated",
    oracleProcessingMs: overrides.oracleProcessingMs ?? 5_000,
    snapshotIntervalMs,
    orderSnapshotIntervalMs: overrides.orderSnapshotIntervalMs ?? snapshotIntervalMs,
    shipmentSnapshotIntervalMs: overrides.shipmentSnapshotIntervalMs ?? snapshotIntervalMs,
    extractionMs: overrides.extractionMs ?? 2_000,
    indexingMs: overrides.indexingMs ?? 1_000,
    uiRefreshMs: overrides.uiRefreshMs ?? 1_000,
    pageSize: overrides.pageSize ?? 25,
    oracleMsPerPage: overrides.oracleMsPerPage ?? 0,
    extractionMsPerRow: overrides.extractionMsPerRow ?? 0,
    indexingMsPerRow: overrides.indexingMsPerRow ?? 0,
    oracleCallsPerMinute: overrides.oracleCallsPerMinute ?? null,
  };
}

/**
 * A working estimate of Shift4's DEV environment. Only the two schedules come from the client: shipment
 * lines every 5 minutes and orders about every 15. Every other value is an assumption to replace once
 * measured, because Oracle processing, snapshot run time and the REST limit are all still unknown.
 */
export function devEstimateProfile(overrides: Partial<Profile> = {}): Profile {
  return acceleratedProfile({
    name: "dev-estimate",
    oracleProcessingMs: 90_000,
    orderSnapshotIntervalMs: 15 * 60_000,
    shipmentSnapshotIntervalMs: 5 * 60_000,
    extractionMs: 15_000,
    indexingMs: 45_000,
    uiRefreshMs: 5_000,
    pageSize: 500,
    oracleMsPerPage: 300,
    extractionMsPerRow: 0.25,
    indexingMsPerRow: 2,
    oracleCallsPerMinute: 120,
    ...overrides,
  });
}

export function fifteenMinuteProfile(): Profile {
  return acceleratedProfile({
    name: "fifteen-minute",
    snapshotIntervalMs: 15 * 60 * 1000,
  });
}

export function profileByName(name: string | undefined): Profile {
  if (name === "fifteen-minute") return fifteenMinuteProfile();
  if (name === "dev-estimate") return devEstimateProfile();
  if (name === "accelerated" || name === undefined) return acceleratedProfile();
  throw new Error(`Unknown profile "${name}". Use accelerated, fifteen-minute or dev-estimate.`);
}

export type QuantityRef = { sourceLineId: string; quantity: number };

export type CoverageStatus = "none" | "partial" | "complete";

export type Coverage = {
  orderedQuantity: number;
  visibleQuantity: number;
  status: CoverageStatus;
  label: string;
  byLine: { sourceLineId: string; ordered: number; visible: number; status: CoverageStatus }[];
};

export function coverageLabel(status: CoverageStatus): string {
  if (status === "complete") return "initial synchronization complete";
  if (status === "partial") return "partially visible";
  return "not visible";
}

export function coverage(ordered: QuantityRef[], visible: QuantityRef[]): Coverage {
  const visibleBy = new Map<string, number>();
  for (const row of visible) {
    visibleBy.set(row.sourceLineId, (visibleBy.get(row.sourceLineId) ?? 0) + row.quantity);
  }
  const byLine = ordered.map((line) => {
    const seen = Math.min(line.quantity, visibleBy.get(line.sourceLineId) ?? 0);
    const status: CoverageStatus = seen <= 0 ? "none" : seen < line.quantity ? "partial" : "complete";
    return { sourceLineId: line.sourceLineId, ordered: line.quantity, visible: seen, status };
  });
  const orderedQuantity = byLine.reduce((sum, line) => sum + line.ordered, 0);
  const visibleQuantity = byLine.reduce((sum, line) => sum + line.visible, 0);
  const status: CoverageStatus =
    visibleQuantity <= 0 ? "none" : visibleQuantity < orderedQuantity ? "partial" : "complete";
  return { orderedQuantity, visibleQuantity, status, label: coverageLabel(status), byLine };
}

export type Collection<T> = {
  items: T[];
  count: number;
  hasMore: boolean;
  limit: number;
  offset: number;
};

export function paginate<T>(items: T[], limit: number, offset: number): Collection<T> {
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    count: slice.length,
    hasMore: offset + limit < items.length,
    limit,
    offset,
  };
}

/** A shipment line as Oracle's REST API returns it. */
export type OracleShipment = {
  ShipmentLine: string;
  OrderNumber: string;
  SourceLineId: string;
  SourceOrderFulfillmentLineId: string | null;
  OrderedQuantity: number;
  ProductNumber: string;
  RequestedFulfillmentOrganizationCode: string;
  BuyingPartyName: string;
  LineStatus: string;
  LastUpdateDate: number;
};

/**
 * The one way to turn an Oracle shipment line into a Foundry row. The snapshot and the
 * targeted write both use it, so they can never disagree on keys or values.
 */
export function shipmentSnapshotRow(shipment: OracleShipment): SnapshotRow {
  const properties = {
    ShipmentLine: shipment.ShipmentLine,
    OrderNumber: shipment.OrderNumber,
    SourceLineId: shipment.SourceLineId,
    SourceOrderFulfillmentLineId: shipment.SourceOrderFulfillmentLineId,
    OrderedQuantity: shipment.OrderedQuantity,
    ProductNumber: shipment.ProductNumber,
    RequestedFulfillmentOrganizationCode: shipment.RequestedFulfillmentOrganizationCode,
    BuyingPartyName: shipment.BuyingPartyName,
    LineStatus: shipment.LineStatus,
    LastUpdateDate: shipment.LastUpdateDate,
  };
  return {
    objectType: "ShipmentLine",
    objectKey: shipmentLineKey(shipment.ShipmentLine),
    sourceTimestamp: shipment.LastUpdateDate,
    ...presentProperties(properties),
  };
}

/**
 * Compares what Oracle owns, leaving out the version. It catches a change that kept the same
 * LastUpdateDate, which can happen when Oracle's timestamps are less precise than its updates.
 */
export function shipmentContent(shipment: OracleShipment): string {
  return JSON.stringify([
    shipment.OrderNumber,
    shipment.SourceLineId,
    shipment.SourceOrderFulfillmentLineId,
    shipment.OrderedQuantity,
    shipment.ProductNumber,
    shipment.RequestedFulfillmentOrganizationCode,
    shipment.BuyingPartyName,
    shipment.LineStatus,
  ]);
}

/** Oracle returns dates as text and the version check needs numbers. A bad value must never pass silently. */
export function parseTimestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new TypeError(`Not a usable timestamp: ${String(value)}`);
  return parsed;
}

export type FulfillmentOrderView = {
  orderNumber: string;
  warehouse: string;
  customer: string;
  status: string;
  lineCount: number;
  activeQuantity: number;
};

const SHIPPING_PROGRESS = ["Backordered", "Ready to Release", "Released to Warehouse", "Staged", "Shipped"];

/** What the warehouse works from: one entry per order and warehouse, at the status of its least advanced line. */
export function fulfillmentOrders(rows: Record<string, unknown>[]): FulfillmentOrderView[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${String(row.OrderNumber)}|${String(row.RequestedFulfillmentOrganizationCode)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((lines) => {
    const active = lines.filter((line) => line.LineStatus !== "Canceled" && Number(line.OrderedQuantity) > 0);
    const positions = active.map((line) => SHIPPING_PROGRESS.indexOf(String(line.LineStatus))).map((position) => (position < 0 ? 1 : position));
    return {
      orderNumber: String(lines[0].OrderNumber),
      warehouse: String(lines[0].RequestedFulfillmentOrganizationCode),
      customer: String(lines[0].BuyingPartyName ?? ""),
      status: active.length === 0 ? "Canceled" : SHIPPING_PROGRESS[Math.min(...positions)],
      lineCount: lines.length,
      activeQuantity: active.reduce((sum, line) => sum + Number(line.OrderedQuantity), 0),
    };
  });
}

export function presentProperties(properties: Record<string, unknown>): { properties: Record<string, unknown>; present: string[] } {
  return { properties, present: Object.keys(properties) };
}
