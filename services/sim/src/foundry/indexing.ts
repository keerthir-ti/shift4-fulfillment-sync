import type { Clock } from "../lab/clock.js";
import type { FoundryStore } from "./store.js";

export function scheduleIndex(
  store: FoundryStore,
  clock: Clock,
  epoch: () => number,
  generationId: string,
  at: number,
  onIndexed: () => void,
  options: { append?: boolean } = {},
): void {
  const token = epoch();
  clock.schedule(at, () => {
    if (epoch() !== token) return;
    store.publish(generationId, clock.now(), options);
    onIndexed();
  });
}
