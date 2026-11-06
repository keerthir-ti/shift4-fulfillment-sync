import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceleratedProfile, coverage } from "../../packages/contracts/src/index.js";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>>;
afterEach(async () => {
  await stack?.stop();
});

describe("readiness coverage", () => {
  it("reports partial quantity separately from completed synchronization", async () => {
    stack = await startStack({
      profile: acceleratedProfile({ snapshotIntervalMs: 8_000, extractionMs: 200, indexingMs: 200, oracleProcessingMs: 5_000 }),
      scenarioPaths: [join(process.cwd(), "fixtures/scenarios/staggered.json")],
    });
    await stack.clock.advanceTo(1_000);
    const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SourceTransactionNumber: "split",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
        SubmittedFlag: false,
      }),
    });
    const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
    const line = await send(lineHref, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-SPLIT", OrderedQuantity: 4 }) });
    expect(line.status).toBe(201);
    const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
    expect((await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) })).status).toBe(200);

    await stack.clock.advanceTo(8_400);
    const partialRows = (await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items as { properties: { SourceLineId: string; OrderedQuantity: number } }[];
    const partial = coverage([{ sourceLineId: line.body.SourceLineId, quantity: 4 }], partialRows.map((row) => ({ sourceLineId: row.properties.SourceLineId, quantity: row.properties.OrderedQuantity })));
    expect(partialRows).toHaveLength(1);
    expect(partial.visibleQuantity).toBe(1);
    expect(partial.label).toBe("partially visible");

    await stack.clock.advanceTo(16_400);
    const doneRows = (await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items as { properties: { SourceLineId: string; OrderedQuantity: number } }[];
    const done = coverage([{ sourceLineId: line.body.SourceLineId, quantity: 4 }], doneRows.map((row) => ({ sourceLineId: row.properties.SourceLineId, quantity: row.properties.OrderedQuantity })));
    expect(done.visibleQuantity).toBe(4);
    expect(done.label).toBe("initial synchronization complete");
    expect((await send(`${stack.oracle.url}${PREFIX}/shipmentLines`)).body.items.every((row: { SourceOrderFulfillmentLineId: null }) => row.SourceOrderFulfillmentLineId === null)).toBe(true);
  });
});
