import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceleratedProfile, shipmentSnapshotRow, type OracleShipment } from "../../packages/contracts/src/index.js";
import { send, startStack } from "../helpers/stack.js";

let stack: Awaited<ReturnType<typeof startStack>>;
const ACTION = "/api/v2/ontologies/local/actions/sync-shipment-lines/apply";

const line = (id: string, over: Partial<OracleShipment> = {}): OracleShipment => ({
  ShipmentLine: id,
  OrderNumber: "5001",
  SourceLineId: "L-1",
  SourceOrderFulfillmentLineId: null,
  OrderedQuantity: 2,
  ProductNumber: "POS-ACC",
  RequestedFulfillmentOrganizationCode: "WH-DUB",
  BuyingPartyName: "Synthetic Merchant Ltd",
  LineStatus: "Ready to Release",
  LastUpdateDate: 1_000,
  ...over,
});
const write = (rows: OracleShipment[]) => send(`${stack.foundry.url}${ACTION}`, { method: "POST", body: JSON.stringify({ parameters: { rows } }) });
const indexed = async () => (await send(`${stack.foundry.url}/lab/query/ShipmentLine`)).body.items as { objectKey: string; properties: Record<string, unknown> }[];
const snapshot = (capturedAt: number, rows: OracleShipment[]) =>
  send(`${stack.foundry.url}/lab/backing-generations`, {
    method: "POST",
    body: JSON.stringify({ kind: "shipment-lines", capturedAt, immediate: true, objectTypes: ["ShipmentLine"], rows: rows.map(shipmentSnapshotRow) }),
  });

beforeEach(async () => {
  stack = await startStack({ profile: acceleratedProfile({ snapshotIntervalMs: 3_600_000 }) });
  await stack.clock.advanceTo(10_000);
});
afterEach(async () => {
  await stack.stop();
});

describe("workflow write", () => {
  it("is visible at once, and repeating the same version changes nothing", async () => {
    expect((await write([line("4001")])).body).toMatchObject({ applied: 1, skipped: 0 });
    expect((await indexed()).map((row) => row.objectKey)).toEqual(["shipment-line:4001"]);
    expect((await write([line("4001")])).body).toMatchObject({ applied: 0, skipped: 1 });
  });

  it("checks each row on its own, so one older row can't block a new one", async () => {
    await write([line("4001", { LineStatus: "Staged", LastUpdateDate: 2_000 })]);
    expect((await write([line("4001", { LastUpdateDate: 1_000 }), line("4002")])).body).toMatchObject({ applied: 1, skipped: 1 });
    const rows = await indexed();
    expect(rows.map((row) => row.objectKey)).toEqual(["shipment-line:4001", "shipment-line:4002"]);
    expect(rows[0].properties.LineStatus).toBe("Staged");
  });

  it("rejects a row that can't be correlated to an order", async () => {
    const response = await write([line("4001", { OrderNumber: "" })]);
    expect(response.status).toBe(400);
    expect(await indexed()).toEqual([]);
  });
});

const REMOVE = "/api/v2/ontologies/local/actions/remove-shipment-lines/apply";

describe("Foundry's edit rules", () => {
  it("keeps the row when a snapshot doesn't hold it, because an Action created the object", async () => {
    await write([line("4001")]);
    await stack.clock.advanceTo(20_000);
    await snapshot(15_000, []);
    expect((await indexed()).map((row) => row.objectKey)).toEqual(["shipment-line:4001"]);
  });

  it("removes the row only through the delete action, and a later snapshot doesn't undo that", async () => {
    await write([line("4001")]);
    await send(`${stack.foundry.url}${REMOVE}`, { method: "POST", body: JSON.stringify({ parameters: { shipmentLines: ["4001"] } }) });
    expect(await indexed()).toEqual([]);
    await stack.clock.advanceTo(20_000);
    await snapshot(15_000, [line("4001")]);
    expect(await indexed()).toEqual([]);
  });

  it("lands on the same row with no duplicate, and a change Oracle made after the edit wins", async () => {
    await write([line("4001")]);
    await stack.clock.advanceTo(20_000);
    await snapshot(15_000, [line("4001")]);
    expect(await indexed()).toHaveLength(1);
    await snapshot(16_000, [line("4001", { LineStatus: "Staged", LastUpdateDate: 15_500 })]);
    const rows = await indexed();
    expect(rows).toHaveLength(1);
    expect(rows[0].properties.LineStatus).toBe("Staged");
  });

  it("keeps the edit when a snapshot holds a value Oracle changed before the edit", async () => {
    await write([line("4001", { LineStatus: "Staged", LastUpdateDate: 5_000 })]);
    await snapshot(4_000, [line("4001", { LastUpdateDate: 3_000 })]);
    expect((await indexed())[0].properties.LineStatus).toBe("Staged");
  });

  it("shows the clock risk: with Foundry's clock ahead, a real Oracle change stays hidden from the snapshot", async () => {
    await send(`${stack.foundry.url}/lab/faults`, { method: "POST", body: JSON.stringify({ mode: "edit-clock-offset", offsetMs: 60_000 }) });
    await write([line("4001")]);
    await stack.clock.advanceTo(20_000);
    await snapshot(19_000, [line("4001", { LineStatus: "Staged", LastUpdateDate: 15_000 })]);
    expect((await indexed())[0].properties.LineStatus).toBe("Ready to Release");
  });

  it("writes a row whose content changed under the same version", async () => {
    await write([line("4001")]);
    expect((await write([line("4001", { LineStatus: "Staged" })])).body).toMatchObject({ applied: 1, skipped: 0 });
    expect((await indexed())[0].properties.LineStatus).toBe("Staged");
  });
});

describe("Foundry search", () => {
  it("filters objects, which the read-back depends on", async () => {
    await write([line("4001"), line("4002", { OrderNumber: "5002" })]);
    const found = await send(`${stack.foundry.url}/api/v2/ontologies/local/objects/ShipmentLine/search`, {
      method: "POST",
      body: JSON.stringify({ where: { type: "eq", field: "OrderNumber", value: "5002" } }),
    });
    expect(found.body.data.map((row: { ShipmentLine: string }) => row.ShipmentLine)).toEqual(["4002"]);
  });
});
