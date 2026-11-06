/**
 * The delivery path. Runs in Temporal's deterministic sandbox, so all I/O is in activities, and
 * history holds only keys and counts. The plumbing is in delivery-runtime.ts.
 */
import { isCancellation, sleep } from "@temporalio/workflow";
import { describeDifferences, startDeliveryRun } from "./delivery-runtime";
import type { DeliveryResult, OrderDeliveryInput } from "./types";

export { checkNow, getDeliveryProgress } from "./delivery-runtime";
export { deliveryAuditWorkflow, recoverySweepWorkflow } from "./background-workflows";

const CANCELED = "The order was canceled in Oracle.";

export async function deliverOrderToFulfillment(input: OrderDeliveryInput): Promise<DeliveryResult> {
  const run = startDeliveryRun(input);
  try {
    // 1. Wait for Oracle to hold the submitted order. Trusting Oracle makes a lost response harmless.
    run.setStage("AwaitingSubmittedOrder");
    const found = await run.checkOracle();
    run.orderFound(found.order);
    if (found.status === "canceled") return await run.finish("CanceledInOracle", CANCELED);

    // 2. Wait for shipment lines to cover every ordered quantity.
    run.setStage("AwaitingShipmentCoverage");
    const covered = await run.checkOracle(found.order);
    if (covered.status === "canceled") return await run.finish("CanceledInOracle", CANCELED);
    run.linesCovered();

    // 3. Compare both systems, write only the differences, and repeat until they match.
    run.setStage("Reconciling");
    const settled = await run.reconcileUntilSettled(covered.order);
    if (settled.outcome === "canceled") return await run.finish("CanceledInOracle", CANCELED);
    if (settled.outcome === "wrote") return await run.finish("ActionRequired", describeDifferences(settled));
    await run.markVerified(settled);

    // 4. Check once more, which catches a change made around the time of the write.
    if (input.settings.settleWatchMs === 0) return run.delivered(settled);
    await sleep(input.settings.settleWatchMs);
    try {
      const rechecked = await run.reconcileUntilSettled(covered.order);
      if (rechecked.outcome === "canceled") return await run.finish("CanceledInOracle", CANCELED);
      if (rechecked.outcome === "wrote") return await run.finish("ActionRequired", describeDifferences(rechecked));
      return run.delivered(rechecked);
    } catch (error) {
      if (isCancellation(error)) throw error;
      // The order is already delivered, and the snapshot and audit still correct it.
      return run.delivered(settled);
    }
  } catch (error) {
    return await run.fail(error);
  } finally {
    run.close();
  }
}
