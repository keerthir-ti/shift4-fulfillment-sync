import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { coverage, shipmentContent, type OracleShipment } from "@shift4/contracts";
import { SystemHttpError, type DeliveryEventSink, type FoundryFulfillmentStore, type OracleOrderReader, type OracleOrderView, type RecoveryIndex } from "./system-adapters";
import type { CoverageResult, OrderLine, OrderReference, ReconcileResult, RecoveryResult, RowDifferences } from "./types";

export type ActivityDeps = {
  oracle: OracleOrderReader;
  foundry: FoundryFulfillmentStore;
  /** Leave out to turn the recovery sweep off. */
  recovery?: { index: RecoveryIndex; start(orderKey: string): Promise<"started" | "running" | "stopped" | "capped"> };
  events?: DeliveryEventSink;
};

const isCanceled = (status: string) => ["CANCELED", "CANCELLED"].includes(status.toUpperCase());

/**
 * How each failure behaves. A busy or unreachable system retries. Expired credentials also retry and
 * aren't benign, so they stand out without failing every open order. A rejected request stops, and so
 * does anything unexpected, because retrying a bug for hours would look like waiting.
 */
function toFailure(error: unknown): ApplicationFailure {
  if (error instanceof ApplicationFailure) return error;
  if (!(error instanceof SystemHttpError)) {
    return ApplicationFailure.create({ type: "UnexpectedActivityError", message: error instanceof Error ? error.message : String(error), nonRetryable: true });
  }
  const system = error.system === "oracle" ? "Oracle" : "Foundry";
  if (error.status === 429) {
    return ApplicationFailure.create({ type: `${system}Throttled`, category: "BENIGN", message: error.message, nextRetryDelay: (error.retryAfterSec ?? 5) * 1000 });
  }
  if (error.status === 401 || error.status === 403) return ApplicationFailure.create({ type: `${system}AccessDenied`, message: error.message });
  // 409 is Foundry's stale-object conflict, which a fresh read and write resolves.
  if (error.status === 408 || error.status === 409 || error.status === 425) return ApplicationFailure.create({ type: `${system}Unreachable`, message: error.message });
  if (error.status >= 400 && error.status < 500) return ApplicationFailure.create({ type: `${system}RejectedRequest`, message: error.message, nonRetryable: true });
  return ApplicationFailure.create({ type: `${system}Unreachable`, message: error.message });
}

const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    throw toFailure(error);
  }
};

const notYet = (type: string, message: string) => ApplicationFailure.create({ type, category: "BENIGN", message });

/** Lines that must be shipped: canceled and zero-quantity lines are left out. */
export function activeLines(order: OracleOrderView): OrderLine[] {
  if (isCanceled(order.status)) return [];
  return order.lines
    .filter((line) => line.quantity > 0 && !isCanceled(line.status))
    .map((line) => ({ sourceLineId: line.sourceLineId, quantity: line.quantity }));
}

/**
 * An order is covered when its shipment lines cover every ordered quantity. One order line can split
 * into several shipment lines, so row counts prove nothing. A line whose rows are all canceled needs nothing more.
 */
export function shipmentCoverage(lines: OrderLine[], rows: OracleShipment[]) {
  const stillNeeded = lines.filter((line) => {
    const mine = rows.filter((row) => row.SourceLineId === line.sourceLineId);
    return !(mine.length > 0 && mine.every((row) => isCanceled(row.LineStatus)));
  });
  const active = rows.filter((row) => !isCanceled(row.LineStatus) && row.OrderedQuantity > 0);
  const result = coverage(stillNeeded, active.map((row) => ({ sourceLineId: row.SourceLineId, quantity: row.OrderedQuantity })));
  return { covered: stillNeeded.length === 0 || result.status === "complete", found: result.visibleQuantity, expected: result.orderedQuantity };
}

/** What must change for Foundry to match Oracle. Foundry holding a newer version is not a difference. */
export function compareRows(oracleRows: OracleShipment[], foundryRows: OracleShipment[]) {
  const held = new Map(foundryRows.map((row) => [row.ShipmentLine, row]));
  const oracleIds = new Set(oracleRows.map((row) => row.ShipmentLine));
  const toWrite: OracleShipment[] = [];
  const differences: RowDifferences = { missing: 0, older: 0, changed: 0, extra: 0 };
  for (const row of oracleRows) {
    const current = held.get(row.ShipmentLine);
    if (!current) {
      differences.missing += 1;
      toWrite.push(row);
    } else if (current.LastUpdateDate < row.LastUpdateDate) {
      differences.older += 1;
      toWrite.push(row);
    } else if (current.LastUpdateDate === row.LastUpdateDate && shipmentContent(current) !== shipmentContent(row)) {
      differences.changed += 1;
      toWrite.push(row);
    }
  }
  // Deleting is the one thing a retry can't undo, so an empty Oracle answer never removes anything.
  const toRemove = oracleRows.length === 0 ? [] : foundryRows.filter((row) => !oracleIds.has(row.ShipmentLine)).map((row) => row.ShipmentLine);
  differences.extra = toRemove.length;
  return { toWrite, toRemove, differences, inSync: toWrite.length === 0 && toRemove.length === 0 };
}

const coverageMessage = (state: { found: number; expected: number }) => `found quantity ${state.found} of ${state.expected}`;

export function createActivities(deps: ActivityDeps) {
  return {
    /** Retries until Oracle has the order and it is submitted. This covers a lost response. */
    async findSubmittedOrder({ orderKey }: { orderKey: string }): Promise<OrderReference> {
      const order = await guarded(() => deps.oracle.findOrder(orderKey));
      if (!order) throw notYet("OrderNotInOracleYet", `Oracle has no order ${orderKey} yet`);
      if (!order.submitted && !isCanceled(order.status)) throw notYet("OrderNotSubmittedYet", `Order ${order.orderNumber} is not submitted in Oracle`);
      return { orderKey, orderNumber: order.orderNumber, lines: activeLines(order) };
    },

    /** One poll, normally one Oracle read. Fails with a retryable error, which is how polling happens. */
    async checkShipmentCoverage({ order, refreshEvery }: { order: OrderReference; refreshEvery: number }): Promise<CoverageResult> {
      let lines = order.lines;
      if (refreshEvery > 0 && Context.current().info.attempt % refreshEvery === 0) {
        const fresh = await guarded(() => deps.oracle.findOrder(order.orderKey));
        if (fresh) lines = activeLines(fresh);
        if (lines.length === 0) return { status: "canceled", lines };
      }
      const rows = await guarded(() => deps.oracle.listShipmentLines(order.orderNumber));
      const state = shipmentCoverage(lines, rows);
      if (!state.covered) throw notYet("ShipmentCoverageIncomplete", coverageMessage(state));
      return { status: "covered", lines };
    },

    /**
     * The core of the design. It reads both systems now and writes only what differs, so a retry never
     * writes old data, and running it twice is safe. Rows stay inside this activity: only counts return.
     */
    async reconcileOrder({ order }: { order: OrderReference }): Promise<ReconcileResult> {
      const fresh = await guarded(() => deps.oracle.findOrder(order.orderKey));
      const lines = fresh ? activeLines(fresh) : order.lines;
      const canceled = fresh !== null && lines.length === 0;
      const [oracleRows, foundryRows] = await guarded(() => Promise.all([deps.oracle.listShipmentLines(order.orderNumber), deps.foundry.readShipmentLines(order.orderNumber)]));
      if (!canceled) {
        const state = shipmentCoverage(lines, oracleRows);
        if (!state.covered) throw notYet("ShipmentCoverageIncomplete", coverageMessage(state));
      }
      const { toWrite, toRemove, differences, inSync } = compareRows(oracleRows, foundryRows);
      if (toWrite.length > 0) await guarded(() => deps.foundry.writeShipmentLines(toWrite));
      if (toRemove.length > 0) await guarded(() => deps.foundry.removeShipmentLines(toRemove));
      if (canceled) return { outcome: "canceled", lines: oracleRows.length, differences };
      return { outcome: inSync ? "in-sync" : "wrote", lines: oracleRows.length, differences };
    },

    /** For people and audit. A failure here never changes the delivery result. */
    async recordDeliveryStatus(entry: { orderKey: string; orderNumber?: string; stage: string; message: string }): Promise<void> {
      await deps.events?.record({ ...entry, at: new Date().toISOString() }).catch(() => undefined);
      const { orderNumber } = entry;
      if (orderNumber) await guarded(() => deps.foundry.recordDeliveryStatus({ orderNumber, stage: entry.stage, message: entry.message }));
    },

    /** Finds approved orders with no final status, and starts their workflows. */
    async sweepMissedOrders({ lookbackMs, limit }: { lookbackMs: number; limit: number }): Promise<RecoveryResult> {
      const { recovery } = deps;
      if (!recovery) throw ApplicationFailure.nonRetryable("This worker has no recovery sweep configured", "RecoveryNotConfigured");
      const keys = await guarded(() => recovery.index.listOrdersNeedingDelivery({ since: Date.now() - lookbackMs, limit }));
      // One order that can't start must not cost the others their turn. The next sweep tries it again.
      const settled = await Promise.allSettled(keys.map((key) => recovery.start(key)));
      const count = (outcome: string) => settled.filter((entry) => entry.status === "fulfilled" && entry.value === outcome).length;
      return { checked: keys.length, started: count("started"), running: count("running"), stopped: count("stopped"), capped: count("capped"), failed: settled.filter((entry) => entry.status === "rejected").length };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
