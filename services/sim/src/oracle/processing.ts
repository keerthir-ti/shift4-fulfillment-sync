import type { Profile } from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";
import type { ReferenceData } from "@shift4/contracts";
import type { OracleStore, ShipmentRecord } from "./store.js";

/** Shipment rows are created only by this timer, never by a read. */
export function armFulfillment(
  store: OracleStore,
  clock: Clock,
  profile: Profile,
  reference: ReferenceData,
  epoch: () => number,
  headerId: string,
  onReady: (shipment: ShipmentRecord) => void,
): void {
  const token = epoch();
  const submittedAt = clock.now();
  const plans = store.armPlans(headerId, submittedAt, reference, profile.oracleProcessingMs);
  for (const plan of plans) {
    clock.schedule(plan.readyAt, () => {
      if (epoch() !== token) return;
      const shipment = store.materializePlan(plan.id, clock.now());
      if (shipment) onReady(shipment);
    });
  }
}
