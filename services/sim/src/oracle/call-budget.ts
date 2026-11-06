import type { Clock } from "../lab/clock.js";

/**
 * One allowance for every Oracle REST caller: the connector, the app and the workers.
 * Calls spend from it, it refills steadily, and an empty budget answers 429 with Retry-After.
 * The real limit is unknown, so this models the behaviour and not Shift4's number.
 */
export class OracleCallBudget {
  private available: number;
  private refilledAt: number;

  constructor(
    private readonly callsPerMinute: number,
    private readonly clock: Clock,
  ) {
    this.available = callsPerMinute;
    this.refilledAt = clock.now();
  }

  /** Returns 0 when the call may go ahead, otherwise the whole seconds until one can. */
  spend(): number {
    const now = this.clock.now();
    const perMs = this.callsPerMinute / 60_000;
    this.available = Math.min(this.callsPerMinute, this.available + (now - this.refilledAt) * perMs);
    this.refilledAt = now;
    if (this.available >= 1) {
      this.available -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.available) / perMs / 1000));
  }
}
