export type LabEvent = {
  scenarioId: string;
  service: string;
  eventType: string;
  orderId?: string;
  operationId?: string;
  virtualAt: number;
  recordedAt: number;
  detail?: Record<string, unknown>;
};

export class EventLog {
  private events: LabEvent[] = [];

  constructor(
    private readonly scenarioId: string,
    private readonly service: string,
    private readonly clock: { now(): number },
  ) {}

  record(eventType: string, extra: Partial<Omit<LabEvent, "recordedAt" | "eventType">> = {}): LabEvent {
    const event: LabEvent = {
      scenarioId: extra.scenarioId ?? this.scenarioId,
      service: extra.service ?? this.service,
      eventType,
      orderId: extra.orderId,
      operationId: extra.operationId,
      virtualAt: extra.virtualAt ?? this.clock.now(),
      recordedAt: Date.now(),
      detail: extra.detail,
    };
    this.events.push(event);
    return event;
  }

  all(): LabEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  clear(): void {
    this.events = [];
  }
}
