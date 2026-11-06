"use server";

import { approveOrder, createOrder, type CreateOrderInput, type FlowResult } from "../lib/flow";

/** A system being down is an answer for the user, not a crash that leaves the screen waiting. */
async function reportingOutages(action: () => Promise<FlowResult>): Promise<FlowResult> {
  try {
    return await action();
  } catch (error) {
    return { ok: false, outcome: "unavailable", message: `A system is unavailable, so nothing was confirmed. Please try again shortly. (${error instanceof Error ? error.message : "unknown error"})` };
  }
}

export async function createOrderAction(input: CreateOrderInput) {
  return reportingOutages(() => createOrder(input));
}

export async function approveOrderAction(input: { headerId: string; orderNumber: string }) {
  return reportingOutages(() => approveOrder(input));
}
