import type { Profile, SnapshotKind } from "@shift4/contracts";
import type { Clock } from "../lab/clock.js";

export function startSchedules(options: {
  clock: Clock;
  origin: number;
  profile: Profile;
  epoch: () => number;
  run: (kind: SnapshotKind, at: number) => Promise<void>;
}): void {
  const token = options.epoch();
  const chains = new Map<SnapshotKind, Promise<void>>();
  const arm = (kind: SnapshotKind, interval: number) => {
    const kick = (from: number) => {
      options.clock.schedule(from + interval, async () => {
        if (options.epoch() !== token) return;
        const previous = chains.get(kind) ?? Promise.resolve();
        const current = previous.then(() => options.run(kind, from + interval));
        chains.set(kind, current.then(() => undefined, () => undefined));
        await current;
        if (options.epoch() !== token) return;
        kick(from + interval);
      });
    };
    kick(options.origin);
  };
  arm("orders", options.profile.orderSnapshotIntervalMs);
  arm("shipment-lines", options.profile.shipmentSnapshotIntervalMs);
}
