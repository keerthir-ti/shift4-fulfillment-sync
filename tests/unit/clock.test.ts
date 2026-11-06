import { describe, expect, it } from "vitest";
import { ManualClock } from "../../services/sim/src/lab/clock.js";

describe("ManualClock", () => {
  it("runs due work in chronological order, including work scheduled by due work", async () => {
    const clock = new ManualClock(0);
    const seen: string[] = [];
    clock.schedule(64, () => {
      seen.push("after");
    });
    clock.schedule(60, () => {
      seen.push("capture");
      clock.schedule(62, () => {
        seen.push("commit");
        clock.schedule(63, () => {
          seen.push("index");
        });
      });
    });
    clock.schedule(6, () => {
      seen.push("readiness");
    });

    await clock.advanceTo(63);

    expect(seen).toEqual(["readiness", "capture", "commit", "index"]);
    expect(clock.now()).toBe(63);

    await clock.advanceTo(64);
    expect(seen).toEqual(["readiness", "capture", "commit", "index", "after"]);
  });
});
