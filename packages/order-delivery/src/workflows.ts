/**
 * Runs in Temporal's deterministic sandbox: only control flow here, and all I/O is in activities.
 * History holds keys and counts, and customer rows stay inside the activities.
 */
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  defineQuery,
  defineSignal,
  isCancellation,
  metricMeter,
  proxyActivities,
  setCurrentDetails,
  setHandler,
  sleep,
  TimeoutFailure,
  upsertSearchAttributes,
} from "@temporalio/workflow";
import type { Activities } from "./activities";
import { DELIVERY_OVERDUE, DELIVERY_STAGE } from "./search-attributes";
import type { AuditResult, DeliveryProgress, DeliveryResult, DeliveryStage, DeliveryTimings, OrderDeliveryInput, OrderReference, ReconcileResult, RecoveryInput, RecoveryResult } from "./types";

export const getDeliveryProgress = defineQuery<DeliveryProgress>("getDeliveryProgress");
/** Check now instead of waiting out the backoff, for an Oracle event or an operator. It's only a hint: Oracle's data stays the truth. */
export const checkNow = defineSignal("checkNow");

const NON_RETRYABLE = ["OracleRejectedRequest", "FoundryRejectedRequest", "UnexpectedActivityError"];

function explain(error: unknown): string {
  if (error instanceof ActivityFailure) {
    if (error.cause instanceof TimeoutFailure) {
      // The last attempt's failure is only on the raw proto.
      const last = error.cause.cause?.message ?? error.cause.failure?.cause?.message;
      return `Deadline passed during ${error.activityType}${last ? `. Last result: ${last}` : ""}`;
    }
    return error.cause?.message ?? error.message;
  }
  if (error instanceof ApplicationFailure) return error.message;
  return error instanceof Error ? error.message : String(error);
}

const describeDifferences = ({ differences }: ReconcileResult) =>
  `Foundry differs from Oracle: ${differences.missing} missing, ${differences.older} older, ${differences.changed} changed, ${differences.extra} extra, ${differences.orders} fulfillment orders to correct.`;

export async function deliverOrderToFulfillment(input: OrderDeliveryInput): Promise<DeliveryResult> {
  const { orderKey, settings } = input;
  const stages: DeliveryStage[] = [];
  let stage: DeliveryStage = "AwaitingSubmittedOrder";
  let orderNumber: string | undefined;
  let reason: string | undefined;
  let overdue = false;
  let passes = 0;
  setHandler(getDeliveryProgress, () => ({ stage, stages, overdue, orderNumber, reason }));

  const startedAt = Date.now();
  let coveredAt: number | undefined;
  let verifiedAt: number | undefined;
  const timings = (): DeliveryTimings => ({
    awaitingOracleMs: coveredAt === undefined ? undefined : coveredAt - startedAt,
    reconcilingMs: coveredAt === undefined || verifiedAt === undefined ? undefined : verifiedAt - coveredAt,
    totalMs: (verifiedAt ?? Date.now()) - startedAt,
  });
  const showDetails = () => setCurrentDetails(`**${stage}**${overdue ? " (overdue)" : ""}${orderNumber ? `\n\nOrder ${orderNumber}` : ""}${reason ? `\n\n${reason}` : ""}`);
  const setStage = (next: DeliveryStage) => {
    stage = next;
    stages.push(next);
    upsertSearchAttributes([{ key: DELIVERY_STAGE, value: next }]);
    showDetails();
  };
  const outcomes = metricMeter.createCounter("order_delivery_outcomes", "1", "Orders finished, by status");
  const totalTime = metricMeter.createHistogram("order_delivery_total_ms", "int", "ms", "Start until delivery was verified");
  const oracleTime = metricMeter.createHistogram("order_delivery_oracle_wait_ms", "int", "ms", "Start until Oracle's lines covered the order");

  const deadlineAt = Date.now() + settings.deadlineMs;
  const polling = () =>
    proxyActivities<Activities>({
      taskQueue: settings.oracleTaskQueue,
      startToCloseTimeout: settings.attemptTimeoutMs,
      scheduleToCloseTimeout: Math.max(1, deadlineAt - Date.now()),
      retry: {
        initialInterval: settings.pollInitialMs,
        backoffCoefficient: settings.pollBackoff,
        maximumInterval: settings.pollMaxMs,
        nonRetryableErrorTypes: NON_RETRYABLE,
      },
    });
  const reconciling = proxyActivities<Activities>({
    taskQueue: settings.oracleTaskQueue,
    startToCloseTimeout: settings.attemptTimeoutMs,
    scheduleToCloseTimeout: settings.reconcileWindowMs,
    retry: { initialInterval: settings.pollInitialMs, backoffCoefficient: 2, maximumInterval: settings.pollMaxMs, nonRetryableErrorTypes: NON_RETRYABLE },
  });
  const notes = proxyActivities<Activities>({ startToCloseTimeout: settings.attemptTimeoutMs, retry: { initialInterval: settings.pollInitialMs, maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE } });

  /** Status notes help people but must never decide the outcome, so their failures are ignored. */
  const note = async (noted: string, message: string) => {
    await notes.recordDeliveryStatus({ orderKey, orderNumber, stage: noted, message }).catch(() => undefined);
  };

  // A signal cancels the current wait, which skips the backoff and checks Oracle straight away.
  let currentWait: CancellationScope | undefined;
  let woken = false;
  setHandler(checkNow, () => {
    if (!currentWait) return;
    woken = true;
    currentWait.cancel();
  });
  const wakeable = async <T>(call: () => Promise<T>): Promise<T> => {
    for (;;) {
      const scope = new CancellationScope();
      currentWait = scope;
      try {
        return await scope.run(call);
      } catch (error) {
        if (!(woken && isCancellation(error))) throw error;
        woken = false;
      } finally {
        currentWait = undefined;
      }
    }
  };

  // Overdue is a flag beside the stage, so you can still see where the order is stuck.
  const watchdog = new CancellationScope();
  const watching = watchdog
    .run(async () => {
      await sleep(settings.overdueAfterMs);
      overdue = true;
      upsertSearchAttributes([{ key: DELIVERY_OVERDUE, value: true }]);
      showDetails();
      await note("Overdue", `Past the overdue threshold while in ${stage}. Still working.`);
    })
    // A flag must never decide the outcome, so nothing here can fail the workflow.
    .catch(() => undefined);
  const stopWatchdog = async () => {
    watchdog.cancel();
    await watching;
  };

  const finish = async (status: "CanceledInOracle" | "ActionRequired", message: string): Promise<DeliveryResult> => {
    await stopWatchdog();
    reason = message;
    setStage(status);
    await note(status, message);
    outcomes.add(1, { status });
    return { status, orderKey, orderNumber, reason, reconcilePasses: passes, wentOverdue: overdue, stages, timings: timings() };
  };

  /** Repeats until Foundry matches. One pass writes the differences, and the next verifies them. */
  const reconcileUntilSettled = async (order: OrderReference): Promise<ReconcileResult> => {
    let last: ReconcileResult | undefined;
    for (let pass = 1; pass <= settings.maxReconcilePasses; pass += 1) {
      passes += 1;
      last = await reconciling.reconcileOrder({ order });
      if (last.outcome !== "wrote") return last;
      if (pass < settings.maxReconcilePasses) await sleep(settings.verifyDelayMs);
    }
    return last!;
  };

  try {
    setStage("AwaitingSubmittedOrder");
    const order = await wakeable(() => polling().findSubmittedOrder({ orderKey }));
    orderNumber = order.orderNumber;
    if (order.lines.length === 0) return await finish("CanceledInOracle", "The order has no lines to ship.");

    setStage("AwaitingShipmentCoverage");
    const coverage = await wakeable(() => polling().checkShipmentCoverage({ order, refreshEvery: settings.orderRefreshEvery }));
    if (coverage.status === "canceled") return await finish("CanceledInOracle", "The order was canceled in Oracle.");
    coveredAt = Date.now();
    oracleTime.record(coveredAt - startedAt);

    setStage("Reconciling");
    const settled = await reconcileUntilSettled(order);
    if (settled.outcome === "canceled") return await finish("CanceledInOracle", "The order was canceled in Oracle.");
    if (settled.outcome === "wrote") return await finish("ActionRequired", describeDifferences(settled));

    await stopWatchdog();
    verifiedAt = Date.now();
    totalTime.record(verifiedAt - startedAt);
    setStage("DeliveryVerified");
    await note("DeliveryVerified", `Verified ${settled.lines} shipment lines in Foundry.`);

    // A short watch catches a change Foundry's edit-time rule could hide, such as one made around the write.
    let verified = settled;
    if (settings.settleWatchMs > 0) {
      await sleep(settings.settleWatchMs);
      try {
        const rechecked = await reconcileUntilSettled(order);
        if (rechecked.outcome === "canceled") return await finish("CanceledInOracle", "The order was canceled in Oracle after delivery.");
        if (rechecked.outcome === "wrote") return await finish("ActionRequired", describeDifferences(rechecked));
        verified = rechecked;
      } catch (error) {
        // The order is already delivered, and the snapshot still corrects it.
        if (isCancellation(error)) throw error;
      }
    }
    outcomes.add(1, { status: "DeliveryVerified" });
    return { status: "DeliveryVerified", orderKey, orderNumber, linesVerified: verified.lines, reconcilePasses: passes, wentOverdue: overdue, stages, timings: timings() };
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(async () => {
        reason = "Stopped by an operator.";
        setStage("OperatorStopped");
        await note("OperatorStopped", reason);
      });
      throw error;
    }
    return await finish("ActionRequired", explain(error));
  } finally {
    watchdog.cancel();
  }
}

/** Started by a Temporal Schedule. Finds orders whose workflow never ran or didn't finish. */
export async function recoverySweepWorkflow(input: RecoveryInput): Promise<RecoveryResult> {
  const sweep = proxyActivities<Activities>({
    startToCloseTimeout: input.settings.attemptTimeoutMs * 4,
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["RecoveryNotConfigured", ...NON_RETRYABLE] },
  });
  return sweep.sweepMissedOrders({ lookbackMs: input.lookbackMs, limit: input.limit });
}

/** Started by a Temporal Schedule. Rechecks recently delivered orders, which catches drift after a workflow has ended. */
export async function deliveryAuditWorkflow(input: RecoveryInput): Promise<AuditResult> {
  const audit = proxyActivities<Activities>({
    startToCloseTimeout: input.settings.attemptTimeoutMs * 4,
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["RecoveryNotConfigured", ...NON_RETRYABLE] },
  });
  return audit.auditDeliveredOrders({ lookbackMs: input.lookbackMs, limit: input.limit });
}
