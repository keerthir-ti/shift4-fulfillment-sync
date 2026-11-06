import { afterEach, describe, expect, it } from "vitest";
import { send, startStack } from "../helpers/stack.js";

const PREFIX = "/fscmRestApi/resources/11.13.18.05";
let stack: Awaited<ReturnType<typeof startStack>>;

afterEach(async () => {
  await stack?.stop();
});

async function draftAt(at: number, source = "tx-baseline") {
  await stack.clock.advanceTo(at);
  const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
    method: "POST",
    body: JSON.stringify({
      SourceTransactionNumber: source,
      BuyingPartyName: "Synthetic Merchant Ltd",
      RequestedFulfillmentOrganizationCode: "WH-DUB",
      BusinessUnitName: "Merchant 360",
      SubmittedFlag: false,
    }),
  });
  expect(created.status).toBe(201);
  const lineHref = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
  const line = await send(lineHref, {
    method: "POST",
    body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 2 }),
  });
  expect(line.status).toBe(201);
  const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
  const started = Date.now();
  const submitted = await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) });
  expect(submitted.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1000);
  return { created: created.body, submitted: submitted.body };
}

describe("oracle simulator", () => {
  it("accepts a submit immediately and creates shipment 4001 only at second 6", async () => {
    stack = await startStack();
    const { submitted } = await draftAt(1000);
    expect(submitted.OrderNumber).toBe("5001");
    const before = await send(`${stack.oracle.url}${PREFIX}/shipmentLines`);
    expect(before.body.items).toEqual([]);
    await stack.clock.advanceTo(5999);
    const almost = await send(`${stack.oracle.url}${PREFIX}/shipmentLines`);
    expect(almost.body.items).toEqual([]);
    await stack.clock.advanceTo(6000);
    const ready = await send(`${stack.oracle.url}${PREFIX}/shipmentLines`);
    expect(ready.body.items).toEqual([
      expect.objectContaining({
        ShipmentLine: "4001",
        OrderedQuantity: 2,
        OrderNumber: "5001",
        SourceOrderFulfillmentLineId: null,
      }),
    ]);
  });

  it("rejects invalid input, pages shipments, and reuses source identity", async () => {
    stack = await startStack();
    const readOnly = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({ HeaderId: "nope", SubmittedFlag: false, SourceTransactionNumber: "x", BuyingPartyName: "Synthetic Merchant Ltd", RequestedFulfillmentOrganizationCode: "WH-DUB" }),
    });
    expect(readOnly.status).toBe(400);
    const unknown = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({ SubmittedFlag: false, SourceTransactionNumber: "x", BuyingPartyName: "Missing", RequestedFulfillmentOrganizationCode: "WH-DUB" }),
    });
    expect(unknown.status).toBe(400);
    const badQuery = await send(`${stack.oracle.url}${PREFIX}/shipmentLines?q=OrderNumber=1`);
    expect(badQuery.status).toBe(400);

    const first = await draftAt(1000, "same-source");
    const retry = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SubmittedFlag: false,
        SourceTransactionNumber: "same-source",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
      }),
    });
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe("reconciled");
    expect(retry.body.HeaderId).toBe(first.created.HeaderId);

    const second = await draftAt(2000, "other-source");
    expect(second.created.HeaderId).not.toBe(first.created.HeaderId);

    await stack.clock.advanceTo(7000);
    const created = await send(`${stack.oracle.url}${PREFIX}/salesOrders`, {
      method: "POST",
      body: JSON.stringify({
        SubmittedFlag: false,
        SourceTransactionNumber: "many",
        BuyingPartyName: "Synthetic Merchant Ltd",
        RequestedFulfillmentOrganizationCode: "WH-DUB",
      }),
    });
    for (let index = 0; index < 30; index += 1) {
      const href = created.body.links.find((link: { rel: string }) => link.rel === "lines").href as string;
      const line = await send(href, { method: "POST", body: JSON.stringify({ ProductNumber: "POS-ACC", OrderedQuantity: 1 }) });
      expect(line.status).toBe(201);
    }
    const submitHref = created.body.links.find((link: { rel: string }) => link.rel === "submit").href as string;
    expect((await send(submitHref, { method: "POST", body: JSON.stringify({ SubmittedFlag: true }) })).status).toBe(200);
    await stack.clock.advanceTo(12_000);
    const orderNumber = created.body.OrderNumber as string;
    const page = await send(`${stack.oracle.url}${PREFIX}/shipmentLines?limit=25&offset=0&orderNumber=${orderNumber}`);
    expect(page.body.count).toBe(25);
    expect(page.body.hasMore).toBe(true);
    const rest = await send(`${stack.oracle.url}${PREFIX}/shipmentLines?limit=25&offset=25&orderNumber=${orderNumber}`);
    expect(rest.body.hasMore).toBe(false);
    expect(page.body.count + rest.body.count).toBe(30);
  });
});
