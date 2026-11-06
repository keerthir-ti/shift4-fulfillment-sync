export interface Clock {
  now(): number;
  schedule(at: number, run: () => void | Promise<void>): void;
}

type Job = { at: number; seq: number; run: () => Promise<void> };

export class ManualClock implements Clock {
  private current: number;
  private seq = 0;
  private queue: Job[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(at: number, run: () => void | Promise<void>): void {
    this.queue.push({
      at,
      seq: this.seq++,
      run: async () => {
        await run();
      },
    });
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (targetMs < this.current) {
      throw new Error(`ManualClock cannot move backwards from ${this.current} to ${targetMs}`);
    }
    for (;;) {
      let best = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const job = this.queue[index];
        if (job.at > targetMs) continue;
        if (
          best === -1 ||
          job.at < this.queue[best].at ||
          (job.at === this.queue[best].at && job.seq < this.queue[best].seq)
        ) {
          best = index;
        }
      }
      if (best === -1) break;
      const [job] = this.queue.splice(best, 1);
      this.current = job.at;
      await job.run();
    }
    this.current = targetMs;
  }
}

export class WallClock implements Clock {
  private timers = new Set<NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  schedule(at: number, run: () => void | Promise<void>): void {
    const delay = Math.max(0, at - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void Promise.resolve(run()).catch((error: unknown) => {
        console.error("scheduled task failed", error);
      });
    }, delay);
    this.timers.add(timer);
  }

  clear(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
