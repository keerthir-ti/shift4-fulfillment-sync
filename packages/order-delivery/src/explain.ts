import type { Client } from "@temporalio/client";
import { compareRows, activeLines, shipmentCoverage } from "./activities";
import { describeOrderDelivery, type DeliveryStatusView } from "./client";
import type { FoundryFulfillmentStore, OracleOrderReader } from "./system-adapters";
import type { RowDifferences } from "./types";

export type OrderExplanation = {
  orderKey: string;
  oracle: { found: boolean; orderNumber?: string; submitted?: boolean; status?: string; expectedQuantity?: number; coveredQuantity?: number };
  foundry: { lines: number; differences?: RowDifferences; matchesOracle?: boolean };
  workflow: DeliveryStatusView | null;
  summary: string;
  nextAction: string;
};

/**
 * Answers "why isn't this order in Fulfillment Manager?" without opening Oracle. It's read-only, so it's
 * safe to run at any time, and it reads both systems directly instead of trusting a stored status.
 */
export async function explainOrderDelivery(options: { orderKey: string; oracle: OracleOrderReader; foundry: FoundryFulfillmentStore; client?: Client }): Promise<OrderExplanation> {
  const { orderKey, oracle, foundry, client } = options;
  const workflow = client ? await describeOrderDelivery(client, orderKey).catch(() => null) : null;
  const order = await oracle.findOrder(orderKey);
  if (!order) {
    return {
      orderKey,
      oracle: { found: false },
      foundry: { lines: 0 },
      workflow,
      summary: "Oracle has no order with this source number.",
      nextAction: "Check whether the submit reached Oracle, then approve the order again.",
    };
  }
  const [oracleRows, foundryRows] = await Promise.all([oracle.listShipmentLines(order.orderNumber), foundry.readShipmentLines(order.orderNumber)]);
  const lines = activeLines(order);
  const state = shipmentCoverage(lines, oracleRows);
  const comparison = compareRows(oracleRows, foundryRows);
  const base = {
    orderKey,
    oracle: { found: true, orderNumber: order.orderNumber, submitted: order.submitted, status: order.status, expectedQuantity: state.expected, coveredQuantity: state.found },
    foundry: { lines: foundryRows.length, differences: comparison.differences, matchesOracle: comparison.inSync },
    workflow,
  };
  const running = workflow?.status === "RUNNING";
  if (!order.submitted) return { ...base, summary: "The order isn't submitted in Oracle.", nextAction: "Approve the order, or resubmit it if the earlier submit failed." };
  if (lines.length === 0) return { ...base, summary: "The order is canceled in Oracle, so there is nothing to deliver.", nextAction: "None." };
  if (!state.covered) {
    return {
      ...base,
      summary: `Oracle hasn't created all shipment lines: found quantity ${state.found} of ${state.expected}.`,
      nextAction: running ? "The workflow is still checking. If it stays overdue, look at the order's holds and orchestration in Oracle." : "Start the workflow again, or let the recovery sweep do it.",
    };
  }
  if (comparison.inSync) return { ...base, summary: "Oracle and Foundry match, so the order is in Fulfillment Manager.", nextAction: "None." };
  return {
    ...base,
    summary: "Oracle has the shipment lines, but Foundry doesn't match yet.",
    nextAction: running ? `The workflow is working on it${workflow?.lastFailure ? `. Last failure: ${workflow.lastFailure}` : "."}` : "Start the workflow again, or let the recovery sweep do it.",
  };
}
