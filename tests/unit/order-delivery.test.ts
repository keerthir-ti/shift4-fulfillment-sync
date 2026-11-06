import { describe, expect, it } from "vitest";
import { fulfillmentOrders, parseTimestamp, shipmentSnapshotRow, type OracleShipment } from "../../packages/contracts/src/index.js";
import { activeLines, compareRows, createActivities, shipmentCoverage } from "../../packages/order-delivery/src/activities.js";
import { createLogEventSink } from "../../packages/order-delivery/src/events.js";
import { DEFAULT_DELIVERY_SETTINGS, deliverySettingsFromEnv } from "../../packages/order-delivery/src/types.js";

const row = (id: string, sourceLineId: string, quantity: number, over: Partial<OracleShipment> = {}): OracleShipment => ({
  ShipmentLine: id,
  OrderNumber: "5001",
  SourceLineId: sourceLineId,
  SourceOrderFulfillmentLineId: null,
  OrderedQuantity: quantity,
  ProductNumber: "POS-ACC",
  RequestedFulfillmentOrganizationCode: "WH-DUB",
  BuyingPartyName: "Synthetic Merchant Ltd",
  LineStatus: "Ready to Release",
  LastUpdateDate: 100,
  ...over,
});

describe("shipmentCoverage", () => {
  const lines = [{ sourceLineId: "L-1", quantity: 4 }];

  it("adds split shipment lines together, and a row alone proves nothing", () => {
    expect(shipmentCoverage(lines, [row("1", "L-1", 1)])).toMatchObject({ covered: false, found: 1, expected: 4 });
    expect(shipmentCoverage(lines, [row("1", "L-1", 1), row("2", "L-1", 3)])).toMatchObject({ covered: true, found: 4 });
  });

  it("settles a line whose shipment lines are all canceled, without counting canceled quantity", () => {
    expect(shipmentCoverage(lines, [row("1", "L-1", 4, { LineStatus: "Canceled" })]).covered).toBe(true);
    expect(shipmentCoverage(lines, [row("1", "L-1", 3, { LineStatus: "Canceled" }), row("2", "L-1", 1)]).covered).toBe(false);
  });

  it("covers shipment lines from any warehouse", () => {
    const two = [{ sourceLineId: "L-1", quantity: 1 }, { sourceLineId: "L-2", quantity: 1 }];
    expect(shipmentCoverage(two, [row("1", "L-1", 1), row("2", "L-2", 1, { RequestedFulfillmentOrganizationCode: "WH-EAST" })]).covered).toBe(true);
  });
});

describe("activeLines", () => {
  const order = { headerId: "H-1", orderNumber: "5001", submitted: true, status: "Submitted" };

  it("leaves out canceled and zero-quantity lines", () => {
    const lines = [{ sourceLineId: "a", quantity: 2, status: "Open" }, { sourceLineId: "b", quantity: 0, status: "Open" }, { sourceLineId: "c", quantity: 1, status: "Canceled" }];
    expect(activeLines({ ...order, lines })).toEqual([{ sourceLineId: "a", quantity: 2 }]);
  });

  it("returns nothing for a canceled order", () => {
    expect(activeLines({ ...order, status: "Canceled", lines: [{ sourceLineId: "a", quantity: 2, status: "Open" }] })).toEqual([]);
  });
});

describe("compareRows", () => {
  const rows = [row("1", "L-1", 1, { LastUpdateDate: 100 }), row("2", "L-2", 1, { LastUpdateDate: 200 })];

  it("matches only when Foundry holds every line at that version or newer", () => {
    expect(compareRows(rows, [row("1", "L-1", 1, { LastUpdateDate: 100 }), row("2", "L-2", 1, { LastUpdateDate: 300 })]).inSync).toBe(true);
    expect(compareRows(rows, [rows[0]])).toMatchObject({ inSync: false, differences: { missing: 1, older: 0 } });
    expect(compareRows(rows, [row("1", "L-1", 1, { LastUpdateDate: 99 }), rows[1]])).toMatchObject({ inSync: false, differences: { missing: 0, older: 1 } });
  });

  it("writes only what differs", () => {
    expect(compareRows(rows, [rows[0]]).toWrite.map((item) => item.ShipmentLine)).toEqual(["2"]);
  });

  it("notices changed content under the same version", () => {
    expect(compareRows([rows[0]], [{ ...rows[0], LineStatus: "Staged" }])).toMatchObject({ inSync: false, differences: { changed: 1 } });
  });

  it("finds rows Foundry holds that Oracle no longer has", () => {
    expect(compareRows([rows[0]], rows)).toMatchObject({ inSync: false, toRemove: ["2"], differences: { extra: 1 } });
  });
});

describe("removing rows", () => {
  it("never deletes on an empty Oracle answer, because a retry couldn't undo it", () => {
    const held = row("1", "L-1", 1);
    expect(compareRows([], [held])).toMatchObject({ toRemove: [], differences: { extra: 0 } });
  });
});

describe("sweep", () => {
  it("still starts the other orders when one can't start, and reports the failure", async () => {
    const unused = {} as never;
    const activities = createActivities({
      oracle: unused,
      foundry: unused,
      recovery: {
        index: { listOrdersNeedingDelivery: async () => ["good", "bad", "also-good"] },
        start: async (key) => {
          if (key === "bad") throw new Error("Temporal said no");
          return "started";
        },
      },
    });
    expect(await activities.sweepMissedOrders({ lookbackMs: 1, limit: 3 })).toEqual({ checked: 3, started: 2, running: 0, stopped: 0, capped: 0, failed: 1 });
  });
});

describe("parseTimestamp", () => {
  it("accepts epoch milliseconds and Oracle's date text", () => {
    expect(parseTimestamp(1_000)).toBe(1_000);
    expect(parseTimestamp("2026-11-05T10:00:00+00:00")).toBe(Date.UTC(2026, 10, 5, 10));
  });

  it("refuses anything else, so a bad date can't pass a version check", () => {
    for (const bad of ["yesterday", null, undefined, Number.NaN]) expect(() => parseTimestamp(bad)).toThrow("usable timestamp");
  });
});

describe("fulfillmentOrders", () => {
  const properties = (shipment: OracleShipment) => shipment as unknown as Record<string, unknown>;

  it("groups by order and warehouse, at the least advanced status", () => {
    const orders = fulfillmentOrders([
      properties(row("1", "L-1", 1, { LineStatus: "Staged" })),
      properties(row("2", "L-2", 2)),
      properties(row("3", "L-3", 1, { RequestedFulfillmentOrganizationCode: "WH-EAST", LineStatus: "Shipped" })),
    ]);
    expect(orders).toEqual([
      { orderNumber: "5001", warehouse: "WH-DUB", customer: "Synthetic Merchant Ltd", status: "Ready to Release", lineCount: 2, activeQuantity: 3 },
      { orderNumber: "5001", warehouse: "WH-EAST", customer: "Synthetic Merchant Ltd", status: "Shipped", lineCount: 1, activeQuantity: 1 },
    ]);
  });

  it("shows Canceled only when every line is canceled", () => {
    expect(fulfillmentOrders([properties(row("1", "L-1", 1, { LineStatus: "Canceled" }))])[0]).toMatchObject({ status: "Canceled", activeQuantity: 0 });
  });
});

describe("delivery events", () => {
  it("marks Overdue and ActionRequired as alerts, and logs every stage", async () => {
    const lines: string[] = [];
    const sink = createLogEventSink({ log: (line) => lines.push(line) });
    await sink.record({ orderKey: "k", stage: "DeliveryVerified", message: "ok", at: "t" });
    await sink.record({ orderKey: "k", stage: "Overdue", message: "late", at: "t" });
    expect(lines.map((line) => JSON.parse(line).alert)).toEqual([false, true]);
  });
});

describe("shared row builder", () => {
  it("produces the key and version that both write paths rely on", () => {
    expect(shipmentSnapshotRow(row("4001", "L-1", 2))).toMatchObject({ objectType: "ShipmentLine", objectKey: "shipment-line:4001", sourceTimestamp: 100 });
  });
});

describe("settings", () => {
  it("uses the defaults, and every value can be overridden without code", () => {
    expect(deliverySettingsFromEnv({})).toEqual({ ...DEFAULT_DELIVERY_SETTINGS, oracleTaskQueue: "oracle-reads" });
    expect(deliverySettingsFromEnv({ SYNC_OVERDUE_AFTER_MS: "1000" }).overdueAfterMs).toBe(1000);
  });
});
