/** Injectable time source so timing logic can be tested with a fake clock. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Manually advanced clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;

  constructor(start = Date.UTC(2026, 10, 2, 15, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const handle = this.setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        handle.cancel();
        reject(signal.reason);
      }, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return { cancel: () => { this.timers = this.timers.filter(timer => timer.id !== id); } };
  }

  /** Advance time, firing due timers in order and letting microtasks settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    this.t = end;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}
