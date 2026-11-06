export type DeliveryStage =
  | "AwaitingSubmittedOrder"
  | "AwaitingShipmentCoverage"
  | "Reconciling"
  | "DeliveryVerified"
  | "CanceledInOracle"
  | "OperatorStopped"
  | "ActionRequired";

/** All timing for one workflow. Every value can be changed without changing code. */
export type DeliverySettings = {
  pollInitialMs: number;
  pollBackoff: number;
  pollMaxMs: number;
  /** Flags the order as overdue. The stage is kept, so you can still see where it is. */
  overdueAfterMs: number;
  /** Time allowed to find the order and see all its lines. */
  deadlineMs: number;
  /** Time allowed for one reconcile pass, which rides out a Foundry outage. */
  reconcileWindowMs: number;
  /** Timeout for one attempt of any activity. */
  attemptTimeoutMs: number;
  /** Re-read the order every N polls to notice a cancellation or changed line. 0 turns this off. */
  orderRefreshEvery: number;
  /** Reconcile passes before asking for help. One writes and the next verifies, so this allows repeats. */
  maxReconcilePasses: number;
  /** Wait between a write and the pass that verifies it. */
  verifyDelayMs: number;
  /** After delivery, reconcile once more after this long, then finish. 0 turns this off. */
  settleWatchMs: number;
  /** Queue for Oracle reads, so one rate limit can cover them. Defaults to the workflow's queue. */
  oracleTaskQueue?: string;
};

/** Starting values until Shift4 supplies real numbers. */
export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  pollInitialMs: 5_000,
  pollBackoff: 1.5,
  pollMaxMs: 60_000,
  overdueAfterMs: 30 * 60_000,
  deadlineMs: 4 * 60 * 60_000,
  reconcileWindowMs: 30 * 60_000,
  attemptTimeoutMs: 30_000,
  orderRefreshEvery: 5,
  maxReconcilePasses: 4,
  verifyDelayMs: 2_000,
  settleWatchMs: 5 * 60_000,
};

const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

export function deliverySettingsFromEnv(env: Record<string, string | undefined> = process.env): DeliverySettings {
  const base = DEFAULT_DELIVERY_SETTINGS;
  return {
    pollInitialMs: number(env.SYNC_POLL_INITIAL_MS, base.pollInitialMs),
    pollBackoff: number(env.SYNC_POLL_BACKOFF, base.pollBackoff),
    pollMaxMs: number(env.SYNC_POLL_MAX_MS, base.pollMaxMs),
    overdueAfterMs: number(env.SYNC_OVERDUE_AFTER_MS, base.overdueAfterMs),
    deadlineMs: number(env.SYNC_DEADLINE_MS, base.deadlineMs),
    reconcileWindowMs: number(env.SYNC_RECONCILE_WINDOW_MS, base.reconcileWindowMs),
    attemptTimeoutMs: number(env.SYNC_ATTEMPT_TIMEOUT_MS, base.attemptTimeoutMs),
    orderRefreshEvery: number(env.SYNC_ORDER_REFRESH_EVERY, base.orderRefreshEvery),
    maxReconcilePasses: number(env.SYNC_MAX_RECONCILE_PASSES, base.maxReconcilePasses),
    verifyDelayMs: number(env.SYNC_VERIFY_DELAY_MS, base.verifyDelayMs),
    settleWatchMs: number(env.SYNC_SETTLE_WATCH_MS, base.settleWatchMs),
    oracleTaskQueue: env.TEMPORAL_ORACLE_TASK_QUEUE ?? "oracle-reads",
  };
}

export type DeliveryTrigger = "approved" | "uncertain" | "recovery" | "audit" | "check-now";

export type OrderDeliveryInput = {
  /** SourceTransactionNumber: known before any Oracle call. */
  orderKey: string;
  trigger: DeliveryTrigger;
  settings: DeliverySettings;
};

export type OrderLine = { sourceLineId: string; quantity: number };

/** What the workflow keeps about an order: identifiers and quantities, and no customer data. */
export type OrderReference = {
  orderKey: string;
  orderNumber: string;
  lines: OrderLine[];
};

export type CoverageResult = { status: "covered" | "canceled"; lines: OrderLine[] };

export type RowDifferences = {
  missing: number;
  older: number;
  changed: number;
  extra: number;
  /** Fulfillment orders to create, correct or remove. */
  orders: number;
};

/** One pass's result. Counts only, so customer rows never enter workflow history. */
export type ReconcileResult = {
  outcome: "in-sync" | "wrote" | "canceled";
  lines: number;
  differences: RowDifferences;
};

export type DeliveryResult = {
  status: "DeliveryVerified" | "CanceledInOracle" | "ActionRequired";
  orderKey: string;
  orderNumber?: string;
  /** Lines verified in Foundry. Only set when the comparison matched. */
  linesVerified?: number;
  reconcilePasses: number;
  wentOverdue: boolean;
  reason?: string;
  stages: DeliveryStage[];
  /** Where the time went, which measures Oracle's real processing time on a real system. */
  timings: DeliveryTimings;
};

export type DeliveryTimings = {
  /** Start until Oracle's lines covered the order. */
  awaitingOracleMs?: number;
  /** Coverage until the first pass that found both systems matching. */
  reconcilingMs?: number;
  /** Start until delivery was verified, or until the workflow ended without it. */
  totalMs: number;
};

export type DeliveryProgress = {
  stage: DeliveryStage;
  stages: DeliveryStage[];
  overdue: boolean;
  orderNumber?: string;
  reason?: string;
};

export type RecoveryInput = {
  lookbackMs: number;
  limit: number;
  settings: DeliverySettings;
};

export type AuditResult = { checked: number; rechecking: number; running: number; failed: number };

export type RecoveryResult = { checked: number; started: number; running: number; stopped: number; capped: number; failed: number };
