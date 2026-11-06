import { join } from "node:path";
import type { ReferenceData } from "@shift4/contracts";
import { Sqlite } from "../lab/sqlite.js";
import { splitsFor, type SplitPlan } from "./reference-data.js";

export type OrderRecord = {
  headerId: string;
  orderNumber: string;
  sourceTransactionNumber: string;
  buyingPartyName: string;
  organizationCode: string;
  businessUnit: string;
  submittedFlag: boolean;
  status: string;
  lastUpdateMs: number;
  createdAt: number;
};

export type LineRecord = {
  lineId: string;
  headerId: string;
  productNumber: string;
  quantity: number;
  sourceLineId: string;
  status: string;
  lastUpdateMs: number;
};

export type ShipmentRecord = {
  shipmentId: string;
  headerId: string;
  orderNumber: string;
  lineId: string;
  sourceLineId: string;
  quantity: number;
  organizationCode: string;
  productNumber: string;
  buyingPartyName: string;
  sourceOrderFulfillmentLineId: null;
  lineStatus: string;
  lastUpdateMs: number;
};

type PlanRow = {
  id: string;
  header_id: string;
  line_id: string;
  source_line_id: string;
  quantity: number;
  ready_at: number;
  product_number: string;
  organization_code: string;
  order_number: string;
  buying_party_name: string;
  done: number;
};

export class OracleStore {
  private headerSeq = 1;
  private orderSeq = 5001;
  private lineSeq = 1;
  private shipmentSeq = 4001;
  private planSeq = 1;
  private captureSeq = 1;
  /** A full extract reads the same capture for every page, so the last one stays parsed. */
  private openedCapture: { token: string; view: { orders: OrderRecord[]; lines: LineRecord[]; shipments: ShipmentRecord[] } } | null = null;
  readonly db: Sqlite;

  constructor(dataDir: string) {
    this.db = new Sqlite(join(dataDir, "oracle.sqlite"));
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        header_id TEXT PRIMARY KEY,
        order_number TEXT NOT NULL,
        source_transaction_number TEXT NOT NULL UNIQUE,
        buying_party_name TEXT NOT NULL,
        organization_code TEXT NOT NULL,
        business_unit TEXT NOT NULL,
        submitted_flag INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_update_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lines (
        line_id TEXT PRIMARY KEY,
        header_id TEXT NOT NULL,
        product_number TEXT NOT NULL,
        quantity REAL NOT NULL,
        source_line_id TEXT NOT NULL,
        last_update_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        header_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        source_line_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        ready_at INTEGER NOT NULL,
        product_number TEXT NOT NULL,
        organization_code TEXT NOT NULL,
        order_number TEXT NOT NULL,
        buying_party_name TEXT NOT NULL,
        done INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shipments (
        shipment_id TEXT PRIMARY KEY,
        header_id TEXT NOT NULL,
        order_number TEXT NOT NULL,
        line_id TEXT NOT NULL,
        source_line_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        organization_code TEXT NOT NULL,
        product_number TEXT NOT NULL,
        buying_party_name TEXT NOT NULL,
        source_order_fulfillment_line_id TEXT,
        last_update_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS captures (
        token TEXT PRIMARY KEY,
        captured_at INTEGER NOT NULL,
        orders_json TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        shipments_json TEXT NOT NULL
      );
    `);
    this.ensureColumn("lines", "status", "TEXT NOT NULL DEFAULT 'Open'");
    this.ensureColumn("shipments", "line_status", "TEXT NOT NULL DEFAULT 'Ready to Release'");
    this.db.exec("CREATE INDEX IF NOT EXISTS shipments_by_order ON shipments (order_number)");
  }

  /** Lets a data volume created before this column existed keep working. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  reset(): void {
    this.db.exec("DELETE FROM captures; DELETE FROM shipments; DELETE FROM plans; DELETE FROM lines; DELETE FROM orders;");
    this.headerSeq = 1;
    this.orderSeq = 5001;
    this.lineSeq = 1;
    this.shipmentSeq = 4001;
    this.planSeq = 1;
    this.captureSeq = 1;
    this.openedCapture = null;
  }

  /** Adds shipment lines that are already complete, so a snapshot has real rows to page through. */
  seedExistingShipments(count: number, at: number): void {
    this.db.transaction(() => {
      for (let index = 1; index <= count; index += 1) {
        const orderNumber = `EXISTING-${Math.ceil(index / 2)}`;
        this.db.run(
          `INSERT INTO shipments (shipment_id, header_id, order_number, line_id, source_line_id, quantity, organization_code, product_number, buying_party_name, source_order_fulfillment_line_id, line_status, last_update_ms)
           VALUES (?, ?, ?, ?, ?, 1, 'WH-DUB', 'POS-ACC', 'Existing customer', NULL, 'Shipped', ?)`,
          `existing-${index}`,
          `existing-header-${Math.ceil(index / 2)}`,
          orderNumber,
          `existing-line-${index}`,
          `existing-source-${index}`,
          at,
        );
      }
    });
  }

  shipmentsForOrder(orderNumber: string): ShipmentRecord[] {
    return this.db.all<ShipmentRow>("SELECT * FROM shipments WHERE order_number = ? ORDER BY shipment_id", orderNumber).map(mapShipment);
  }

  findBySource(sourceTransactionNumber: string): OrderRecord | undefined {
    const row = this.db.get<OrderRow>("SELECT * FROM orders WHERE source_transaction_number = ?", sourceTransactionNumber);
    return row ? mapOrder(row) : undefined;
  }

  /** Simulator control: the order is canceled in Oracle, with nothing further to ship. */
  cancelOrder(headerId: string, at: number): void {
    this.db.run("UPDATE orders SET status = 'Canceled', last_update_ms = ? WHERE header_id = ?", at, headerId);
    this.db.run("UPDATE lines SET status = 'Canceled', last_update_ms = ? WHERE header_id = ?", at, headerId);
    this.db.run("UPDATE plans SET done = 1 WHERE header_id = ?", headerId);
    this.db.run("UPDATE shipments SET line_status = 'Canceled', last_update_ms = ? WHERE header_id = ?", at, headerId);
  }

  /** Simulator control: Oracle moves a shipment line to a new status. */
  setShipmentStatus(shipmentId: string, status: string, at: number): boolean {
    const exists = this.db.get<{ shipment_id: string }>("SELECT shipment_id FROM shipments WHERE shipment_id = ?", shipmentId);
    if (!exists) return false;
    this.db.run("UPDATE shipments SET line_status = ?, last_update_ms = ? WHERE shipment_id = ?", status, at, shipmentId);
    return true;
  }

  /** Simulator control: this shipment line ships from another warehouse. */
  setShipmentOrganization(shipmentId: string, organizationCode: string, at: number): void {
    this.db.run("UPDATE shipments SET organization_code = ?, last_update_ms = ? WHERE shipment_id = ?", organizationCode, at, shipmentId);
  }

  findOrder(headerId: string): OrderRecord | undefined {
    const row = this.db.get<OrderRow>("SELECT * FROM orders WHERE header_id = ?", headerId);
    return row ? mapOrder(row) : undefined;
  }

  createOrder(input: {
    sourceTransactionNumber: string;
    buyingPartyName: string;
    organizationCode: string;
    businessUnit: string;
    at: number;
  }): OrderRecord {
    const headerId = `H-${this.headerSeq++}`;
    const orderNumber = String(this.orderSeq++);
    this.db.run(
      `INSERT INTO orders (
        header_id, order_number, source_transaction_number, buying_party_name, organization_code,
        business_unit, submitted_flag, status, last_update_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'Draft', ?, ?)`,
      headerId,
      orderNumber,
      input.sourceTransactionNumber,
      input.buyingPartyName,
      input.organizationCode,
      input.businessUnit,
      input.at,
      input.at,
    );
    return this.findOrder(headerId)!;
  }

  addLine(headerId: string, productNumber: string, quantity: number, at: number): LineRecord {
    const lineId = `L-${this.lineSeq++}`;
    this.db.run(
      `INSERT INTO lines (line_id, header_id, product_number, quantity, source_line_id, last_update_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      lineId,
      headerId,
      productNumber,
      quantity,
      lineId,
      at,
    );
    this.touch(headerId, at);
    return this.lines(headerId).find((line) => line.lineId === lineId)!;
  }

  lines(headerId: string): LineRecord[] {
    return this.db
      .all<LineRow>("SELECT * FROM lines WHERE header_id = ? ORDER BY line_id", headerId)
      .map(mapLine);
  }

  markSubmitted(headerId: string, at: number): OrderRecord {
    this.db.run("UPDATE orders SET submitted_flag = 1, status = 'Submitted', last_update_ms = ? WHERE header_id = ?", at, headerId);
    return this.findOrder(headerId)!;
  }

  touch(headerId: string, at: number): void {
    this.db.run("UPDATE orders SET last_update_ms = ? WHERE header_id = ?", at, headerId);
  }

  armPlans(headerId: string, submittedAt: number, reference: ReferenceData, processingMs: number): { id: string; readyAt: number }[] {
    const order = this.findOrder(headerId)!;
    const armed: { id: string; readyAt: number }[] = [];
    for (const line of this.lines(headerId)) {
      const item = reference.items.find((candidate) => candidate.productNumber === line.productNumber);
      const splits: SplitPlan[] = splitsFor(item, line.quantity, processingMs);
      const total = splits.reduce((sum, split) => sum + split.quantity, 0);
      if (total !== line.quantity) {
        throw new Error(`Split quantities ${total} do not match ordered quantity ${line.quantity} for ${line.productNumber}`);
      }
      for (const split of splits) {
        const id = `P-${this.planSeq++}`;
        const readyAt = submittedAt + split.readyOffsetMs;
        this.db.run(
          `INSERT INTO plans (
            id, header_id, line_id, source_line_id, quantity, ready_at, product_number,
            organization_code, order_number, buying_party_name, done
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          id,
          headerId,
          line.lineId,
          line.sourceLineId,
          split.quantity,
          readyAt,
          line.productNumber,
          order.organizationCode,
          order.orderNumber,
          order.buyingPartyName,
        );
        armed.push({ id, readyAt });
      }
    }
    return armed;
  }

  materializePlan(planId: string, at: number): ShipmentRecord | undefined {
    const plan = this.db.get<PlanRow>("SELECT * FROM plans WHERE id = ?", planId);
    if (!plan || plan.done) return undefined;
    const shipmentId = String(this.shipmentSeq++);
    this.db.run(
      `INSERT INTO shipments (
        shipment_id, header_id, order_number, line_id, source_line_id, quantity, organization_code,
        product_number, buying_party_name, source_order_fulfillment_line_id, last_update_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      shipmentId,
      plan.header_id,
      plan.order_number,
      plan.line_id,
      plan.source_line_id,
      plan.quantity,
      plan.organization_code,
      plan.product_number,
      plan.buying_party_name,
      at,
    );
    this.db.run("UPDATE plans SET done = 1 WHERE id = ?", planId);
    return this.shipments().find((shipment) => shipment.shipmentId === shipmentId);
  }

  orders(): OrderRecord[] {
    return this.db.all<OrderRow>("SELECT * FROM orders ORDER BY order_number").map(mapOrder);
  }

  allLines(): LineRecord[] {
    return this.db.all<LineRow>("SELECT * FROM lines ORDER BY line_id").map(mapLine);
  }

  shipments(): ShipmentRecord[] {
    return this.db.all<ShipmentRow>("SELECT * FROM shipments ORDER BY shipment_id").map(mapShipment);
  }

  /**
   * Simulator-only frozen view. Oracle Fusion and CData do not issue this token.
   * It keeps a multi-page extract from observing rows created while pages are read.
   */
  openCapture(capturedAt: number): string {
    const token = `cap-${this.captureSeq++}`;
    this.db.run(
      "INSERT INTO captures (token, captured_at, orders_json, lines_json, shipments_json) VALUES (?, ?, ?, ?, ?)",
      token,
      capturedAt,
      JSON.stringify(this.orders()),
      JSON.stringify(this.allLines()),
      JSON.stringify(this.shipments()),
    );
    return token;
  }

  capture(token: string): { orders: OrderRecord[]; lines: LineRecord[]; shipments: ShipmentRecord[] } | undefined {
    if (this.openedCapture?.token === token) return this.openedCapture.view;
    const row = this.db.get<{ orders_json: string; lines_json: string; shipments_json: string }>(
      "SELECT orders_json, lines_json, shipments_json FROM captures WHERE token = ?",
      token,
    );
    if (!row) return undefined;
    const view = {
      orders: JSON.parse(row.orders_json) as OrderRecord[],
      lines: JSON.parse(row.lines_json) as LineRecord[],
      shipments: JSON.parse(row.shipments_json) as ShipmentRecord[],
    };
    this.openedCapture = { token, view };
    return view;
  }

  close(): void {
    this.db.close();
  }
}

type OrderRow = {
  header_id: string;
  order_number: string;
  source_transaction_number: string;
  buying_party_name: string;
  organization_code: string;
  business_unit: string;
  submitted_flag: number;
  status: string;
  last_update_ms: number;
  created_at: number;
};

type LineRow = {
  line_id: string;
  header_id: string;
  product_number: string;
  quantity: number;
  source_line_id: string;
  status: string;
  last_update_ms: number;
};

type ShipmentRow = {
  shipment_id: string;
  header_id: string;
  order_number: string;
  line_id: string;
  source_line_id: string;
  quantity: number;
  organization_code: string;
  product_number: string;
  buying_party_name: string;
  source_order_fulfillment_line_id: string | null;
  line_status: string;
  last_update_ms: number;
};

function mapOrder(row: OrderRow): OrderRecord {
  return {
    headerId: row.header_id,
    orderNumber: row.order_number,
    sourceTransactionNumber: row.source_transaction_number,
    buyingPartyName: row.buying_party_name,
    organizationCode: row.organization_code,
    businessUnit: row.business_unit,
    submittedFlag: row.submitted_flag === 1,
    status: row.status,
    lastUpdateMs: row.last_update_ms,
    createdAt: row.created_at,
  };
}

function mapLine(row: LineRow): LineRecord {
  return {
    lineId: row.line_id,
    headerId: row.header_id,
    productNumber: row.product_number,
    quantity: row.quantity,
    sourceLineId: row.source_line_id,
    status: row.status,
    lastUpdateMs: row.last_update_ms,
  };
}

function mapShipment(row: ShipmentRow): ShipmentRecord {
  return {
    shipmentId: row.shipment_id,
    headerId: row.header_id,
    orderNumber: row.order_number,
    lineId: row.line_id,
    sourceLineId: row.source_line_id,
    quantity: row.quantity,
    organizationCode: row.organization_code,
    productNumber: row.product_number,
    buyingPartyName: row.buying_party_name,
    sourceOrderFulfillmentLineId: null,
    lineStatus: row.line_status,
    lastUpdateMs: row.last_update_ms,
  };
}
