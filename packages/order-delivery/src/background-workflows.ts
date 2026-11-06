/** Optional. Temporal Schedules start these, and a deployment can leave either one out. */
import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "./activities";
import { NON_RETRYABLE } from "./delivery-runtime";
import type { AuditResult, RecoveryInput, RecoveryResult } from "./types";

const backgroundActivities = (input: RecoveryInput) =>
  proxyActivities<Activities>({
    startToCloseTimeout: input.settings.attemptTimeoutMs * 4,
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["RecoveryNotConfigured", ...NON_RETRYABLE] },
  });

/** Finds orders whose workflow never ran or didn't finish. */
export async function recoverySweepWorkflow(input: RecoveryInput): Promise<RecoveryResult> {
  return backgroundActivities(input).sweepMissedOrders({ lookbackMs: input.lookbackMs, limit: input.limit });
}

/** Rechecks recently delivered orders, which catches drift after a workflow has ended. */
export async function deliveryAuditWorkflow(input: RecoveryInput): Promise<AuditResult> {
  return backgroundActivities(input).auditDeliveredOrders({ lookbackMs: input.lookbackMs, limit: input.limit });
}
