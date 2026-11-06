"use client";

import { useEffect, useState } from "react";
import { approveOrderAction, createOrderAction } from "../app/actions";
import { Diagnostics } from "./diagnostics";

type OrderItem = { objectKey: string; properties: Record<string, unknown> };
type FulfillmentOrder = { orderNumber: string; warehouse: string; customer: string; status: string; lineCount: number; activeQuantity: number };
type LabState = Parameters<typeof Diagnostics>[0]["lab"];

function syncStage(order: OrderItem): string | undefined {
  return (order.properties.fulfillmentSync as { stage?: string } | undefined)?.stage;
}

export function Operator() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [fulfillment, setFulfillment] = useState<FulfillmentOrder[]>([]);
  const [lab, setLab] = useState<LabState>(null);
  const [message, setMessage] = useState("Create a draft, approve it, then watch the warehouse wait.");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    buyingPartyName: "Synthetic Merchant Ltd",
    organizationCode: "WH-DUB",
    productNumber: "POS-ACC",
    quantity: 2,
  });

  async function refresh() {
    const [orderResponse, fulfillmentResponse, labResponse] = await Promise.all([
      fetch("/api/orders", { cache: "no-store" }),
      fetch("/api/fulfillment", { cache: "no-store" }),
      fetch("/api/lab", { cache: "no-store" }),
    ]);
    if (orderResponse.ok) setOrders((await orderResponse.json()).items ?? []);
    if (fulfillmentResponse.ok) setFulfillment((await fulfillmentResponse.json()).orders ?? []);
    if (labResponse.ok) setLab(await labResponse.json());
    else setLab(null);
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main>
      <header className="top">
        <div>
          <p className="eyebrow">Local reproduction · not a Shift4 tenant</p>
          <h1>Sales order to fulfillment</h1>
        </div>
        <div className="controls">
          <button type="button" onClick={() => void postLab({ action: "reset" }, "Scenario reset.")}>Reset</button>
          <button type="button" onClick={() => void postLab({ action: "profile", name: "accelerated" }, "Using the 60-second snapshot.")}>60s snapshot</button>
          <button type="button" onClick={() => void postLab({ action: "profile", name: "fifteen-minute" }, "Using the 15-minute snapshot preset.")}>15-minute snapshot</button>
        </div>
      </header>
      <p className="message">{message}</p>
      <section className="grid">
        <article className="panel">
          <h2>Sales Order Manager</h2>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              const result = await createOrderAction(form);
              setBusy(false);
              setMessage(result.ok ? `Draft ${result.orderNumber} is in Foundry.` : result.message);
              await refresh();
            }}
          >
            <label>Customer<input value={form.buyingPartyName} onChange={(event) => setForm({ ...form, buyingPartyName: event.target.value })} /></label>
            <label>Warehouse<input value={form.organizationCode} onChange={(event) => setForm({ ...form, organizationCode: event.target.value })} /></label>
            <label>Product<input value={form.productNumber} onChange={(event) => setForm({ ...form, productNumber: event.target.value })} /></label>
            <label>Quantity<input type="number" min={1} value={form.quantity} onChange={(event) => setForm({ ...form, quantity: Number(event.target.value) })} /></label>
            <button type="submit" data-testid="create-order" disabled={busy}>Create draft</button>
          </form>
          <ul className="rows" data-testid="sales-list">
            {orders.map((order) => (
              <li key={order.objectKey} data-testid={`order-${order.properties.orderNumber}`}>
                <div>
                  <strong>{String(order.properties.orderNumber)}</strong>
                  <span>{String(order.properties.buyingPartyName)}</span>
                  <em>{String(order.properties.status ?? order.properties.approvalStatus ?? "")}</em>
                  {syncStage(order) ? <em data-testid={`sync-${order.properties.orderNumber}`}>Sync: {syncStage(order)}</em> : null}
                </div>
                {order.properties.submittedFlag === true ? null : <button
                  type="button"
                  data-testid={`approve-${order.properties.orderNumber}`}
                  onClick={async () => {
                    setBusy(true);
                    const result = await approveOrderAction({
                      headerId: String(order.properties.headerId),
                      orderNumber: String(order.properties.orderNumber),
                    });
                    setBusy(false);
                    setMessage(result.ok ? `Approved ${order.properties.orderNumber}. Oracle will create shipment lines on its own clock.` : result.message);
                    await refresh();
                  }}
                >
                  Approve
                </button>}
              </li>
            ))}
            {orders.length === 0 ? <li className="empty">No sales orders in Foundry.</li> : null}
          </ul>
        </article>
        <article className="panel">
          <h2>Fulfillment Manager</h2>
          <ul className="rows" data-testid="fulfillment-list">
            {fulfillment.map((order) => (
              <li key={`${order.orderNumber}-${order.warehouse}`} data-testid={`fulfillment-${order.orderNumber}`}>
                <div>
                  <strong>Order {order.orderNumber}</strong>
                  <span>{order.customer}</span>
                  <span>{order.warehouse}</span>
                  <em>{order.status}</em>
                  <em>{order.lineCount} lines, qty {order.activeQuantity}</em>
                </div>
              </li>
            ))}
            {fulfillment.length === 0 ? (
              <li className="empty">No shipment lines in Foundry yet. The warehouse list updates only after the scheduled snapshot is indexed.</li>
            ) : null}
          </ul>
        </article>
      </section>
      <Diagnostics lab={lab} />
    </main>
  );

  async function postLab(body: { action: string; name?: string }, success: string) {
    const response = await fetch("/api/lab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setMessage(response.ok ? success : "Lab control failed.");
    await refresh();
  }
}
