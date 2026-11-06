"use client";

type LabEvent = {
  service: string;
  eventType: string;
  orderId?: string;
  virtualAt: number;
  recordedAt: number;
};

type LabState = {
  simulator?: boolean;
  oracle?: { status: string; shipments: { ShipmentLine: string; OrderNumber: string; OrderedQuantity: number }[] };
  foundry?: { status: string; syncStatus: string; items: { objectKey: string; properties: Record<string, unknown> }[] };
  schedule?: {
    profile?: string;
    note?: string;
    nextShipmentSnapshotAt?: number | null;
    shipmentIntervalMs?: number;
    extractionMs?: number;
    indexingMs?: number;
    status?: string;
  };
  events?: LabEvent[];
};

export function Diagnostics({ lab }: { lab: LabState | null }) {
  if (!lab) {
    return (
      <section className="panel lab" data-testid="lab-panel">
        <h2>Lab timeline</h2>
        <p className="unknown">Simulator state unknown. This panel does not call a missing response ready.</p>
      </section>
    );
  }
  const oracleIds = new Set((lab.oracle?.shipments ?? []).map((row) => row.ShipmentLine));
  const indexedIds = new Set((lab.foundry?.items ?? []).map((row) => String(row.properties.ShipmentLine)));
  const waiting = [...oracleIds].filter((id) => !indexedIds.has(id));
  const nextAt = lab.schedule?.nextShipmentSnapshotAt;
  const remaining = typeof nextAt === "number" ? Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)) : null;
  return (
    <section className="panel lab" data-testid="lab-panel">
      <header className="panel-head">
        <h2>Lab timeline</h2>
        <span className="tag">simulator · {lab.schedule?.profile ?? "unknown profile"}</span>
      </header>
      <p className="note">{lab.schedule?.note}</p>
      {waiting.length > 0 ? (
        <p className="gap" data-testid="gap-banner">
          Oracle is ready ({waiting.join(", ")}). Fulfillment Manager is still empty. Next snapshot
          {remaining === null ? " time is unknown." : ` in ${remaining}s.`}
        </p>
      ) : null}
      <div className="meters">
        <Meter label="Oracle shipments" value={lab.oracle?.status === "unknown" ? "unknown" : String(lab.oracle?.shipments.length ?? 0)} />
        <Meter label="Foundry indexed" value={lab.foundry?.status === "unknown" ? "unknown" : String(lab.foundry?.items.length ?? 0)} />
        <Meter label="Sync" value={lab.foundry?.syncStatus ?? "unknown"} />
        <Meter label="Snapshot every" value={lab.schedule?.shipmentIntervalMs ? `${lab.schedule.shipmentIntervalMs / 1000}s` : "unknown"} />
      </div>
      <ol className="timeline">
        {(lab.events ?? []).slice(-8).map((event, index) => (
          <li key={`${event.recordedAt}-${index}`}>
            <span>{event.service}</span>
            <strong>{event.eventType}</strong>
            <em>{event.orderId ?? ""}</em>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
