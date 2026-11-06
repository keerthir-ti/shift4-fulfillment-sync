import { callService, foundryUrl, oracleUrl } from "./clients";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
const SUBMIT_TIMEOUT_MS = 15_000;

export type CreateOrderInput = {
  buyingPartyName: string;
  organizationCode: string;
  productNumber: string;
  quantity: number;
  sourceTransactionNumber?: string;
};

export type FlowResult =
  | { ok: true; orderNumber: string; headerId: string; sourceTransactionNumber: string; outcome: string }
  | { ok: false; outcome: "uncertain" | "validation" | "busy" | "unavailable"; message: string; sourceTransactionNumber?: string; status?: number };

/** The approve flow's one extension point. The app works the same with no hooks. */
export type FlowHooks = {
  onOracleSubmitted?: (event: { orderKey: string; trigger: "approved" | "uncertain" }) => Promise<{ started: boolean; reason?: string }>;
};

/** Off by default, so the baseline reproduction and before-and-after comparisons stay fair. */
async function configuredHooks(): Promise<FlowHooks> {
  if (process.env.FULFILLMENT_SYNC !== "on") return {};
  const { defaultSyncHooks } = await import("./fulfillment-sync");
  return defaultSyncHooks();
}

export async function createOrder(input: CreateOrderInput): Promise<FlowResult> {
  const sourceTransactionNumber = input.sourceTransactionNumber ?? `src-${crypto.randomUUID()}`;
  const created = await callService("oracle", oracleUrl(`${PREFIX}/salesOrders`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      SourceTransactionNumber: sourceTransactionNumber,
      BuyingPartyName: input.buyingPartyName,
      RequestedFulfillmentOrganizationCode: input.organizationCode,
      BusinessUnitName: "Merchant 360",
      SubmittedFlag: false,
    }),
  });
  if (created.status === 504) {
    return {
      ok: false,
      outcome: "uncertain",
      message: created.body.message ?? "Oracle committed the order but the response was lost",
      sourceTransactionNumber,
      status: 504,
    };
  }
  if (created.status === 429) return oracleBusy(sourceTransactionNumber);
  if (created.status >= 400) {
    return { ok: false, outcome: "validation", message: created.body.message ?? "Oracle rejected the order", status: created.status, sourceTransactionNumber };
  }
  const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
  const line = await callService("oracle", lineHref, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ProductNumber: input.productNumber, OrderedQuantity: input.quantity }),
  });
  if (line.status === 429) return oracleBusy(sourceTransactionNumber);
  if (line.status >= 400) {
    return { ok: false, outcome: "validation", message: line.body.message ?? "Oracle rejected the line", status: line.status, sourceTransactionNumber };
  }
  const mirrored = await mirror(created.body, [line.body]);
  if (!mirrored.ok) return mirrored;
  return {
    ok: true,
    orderNumber: created.body.OrderNumber,
    headerId: created.body.HeaderId,
    sourceTransactionNumber,
    outcome: created.body.outcome ?? "created",
  };
}

export async function approveOrder(input: { headerId: string; orderNumber: string }, hooks?: FlowHooks): Promise<FlowResult> {
  const flowHooks = hooks ?? (await configuredHooks());
  const current = await callService("oracle", oracleUrl(`${PREFIX}/salesOrders/${input.headerId}`));
  if (current.status === 429) return oracleBusy(input.orderNumber);
  if (current.status >= 400) return { ok: false, outcome: "validation", message: current.body.message ?? "Order not found", status: current.status };
  const submitHref = current.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
  const lines = await callService("oracle", current.body.links.find((link: { rel: string }) => link.rel === "lines").href as string);
  if (lines.status === 429) return oracleBusy(input.orderNumber);
  if (lines.status >= 400) return { ok: false, outcome: "validation", message: lines.body.message ?? "Order lines could not be read", status: lines.status };
  // A network error or a hang is the same as a lost response: Oracle may have accepted the submit.
  const submitted = await callService("oracle", submitHref, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ SubmittedFlag: true }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  }).catch((error: unknown) => ({ status: 503, body: { message: `Oracle did not confirm the submit: ${error instanceof Error ? error.message : "no response"}` } as Record<string, any> }));
  const orderKey: string = current.body.SourceTransactionNumber;
  // A 5xx or a lost response means Oracle may have accepted it, so the workflow still starts and checks.
  if (submitted.status >= 500) {
    const sync = await flowHooks.onOracleSubmitted?.({ orderKey, trigger: "uncertain" });
    if (sync && !sync.started) await recordNotStarted(current.body.OrderNumber, sync.reason);
    return { ok: false, outcome: "uncertain", message: submitted.body.message ?? "Submit response lost", status: submitted.status };
  }
  if (submitted.status === 429) return oracleBusy(orderKey);
  if (submitted.status >= 400) {
    return { ok: false, outcome: "validation", message: submitted.body.message ?? "Oracle rejected submit", status: submitted.status };
  }
  // The workflow starts before the mirror, so a Foundry failure below can't stop the order reaching the warehouse.
  const sync = await flowHooks.onOracleSubmitted?.({ orderKey, trigger: "approved" });
  const mirrored = await mirror(submitted.body, lines.body.items ?? []);
  if (mirrored.ok && sync && !sync.started) await recordNotStarted(submitted.body.OrderNumber, sync.reason);
  return mirrored;
}

/** Oracle turned the call away because it's busy, so nothing is wrong with the order. */
function oracleBusy(sourceTransactionNumber: string): FlowResult {
  return { ok: false, outcome: "busy", message: "Oracle is busy right now. Please try again shortly.", status: 429, sourceTransactionNumber };
}

async function recordNotStarted(orderNumber: string, reason?: string): Promise<void> {
  await callService("foundry", foundryUrl("/api/v2/ontologies/local/actions/record-fulfillment-sync/apply"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parameters: { orderNumber, stage: "NotStarted", message: `Delivery workflow not started (${reason ?? "unknown error"}). The recovery sweep will retry it.` },
    }),
  }).catch(() => undefined);
}

async function mirror(order: Record<string, any>, lines: Record<string, any>[]): Promise<FlowResult> {
  const applied = await callService("foundry", foundryUrl("/api/v2/ontologies/local/actions/mirror-sales-order/apply"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parameters: {
        orderNumber: order.OrderNumber,
        headerId: order.HeaderId,
        sourceTransactionNumber: order.SourceTransactionNumber,
        buyingPartyName: order.BuyingPartyName,
        organizationCode: order.RequestedFulfillmentOrganizationCode,
        submittedFlag: order.SubmittedFlag,
        lastUpdateDate: order.LastUpdateDate,
        lines: lines.map((line) => ({
          lineId: line.LineId,
          productNumber: line.ProductNumber,
          quantity: line.OrderedQuantity,
          sourceLineId: line.SourceLineId,
        })),
      },
    }),
  });
  if (applied.status >= 400) {
    return { ok: false, outcome: "validation", message: applied.body.message ?? "Foundry rejected the mirror", status: applied.status };
  }
  return {
    ok: true,
    orderNumber: order.OrderNumber,
    headerId: order.HeaderId,
    sourceTransactionNumber: order.SourceTransactionNumber,
    outcome: "mirrored",
  };
}
