import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { Store, defaultSettings } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { Settings } from "../../src/core/types";
import { FIRING_WINDOW_MS, PREWARM_LEAD_MS, TicketScheduler } from "../../src/engine/ticket";

function setup(ticketOffsetMs: number | null, warm: (term: string) => Promise<void> = async () => {}) {
  const clock = new FakeClock();
  const store = new Store(":memory:");
  const events = new Events(store, new Bus());
  let settings: Settings = {
    ...defaultSettings(),
    activeTerm: "120271",
    ticketAt: ticketOffsetMs === null ? null : new Date(clock.now() + ticketOffsetMs).toISOString(),
  };
  const warmed: number[] = [];
  const kicks: number[] = [];
  const evaluations: number[] = [];
  const scheduler = new TicketScheduler({
    clock,
    settings: () => settings,
    ensureWarm: term => {
      warmed.push(clock.now());
      return warm(term);
    },
    orchestrator: { evaluate: () => evaluations.push(clock.now()) },
    poller: { kick: () => kicks.push(clock.now()) },
    events,
  });
  return { clock, store, scheduler, warmed, kicks, evaluations, set: (patch: Partial<Settings>) => (settings = { ...settings, ...patch }) };
}

describe("TicketScheduler", () => {
  test("waiting, prewarm at T-10 min, firing for 90 s every second, then done", async () => {
    const hour = 60 * 60_000;
    const t = setup(hour);
    const start = t.clock.now();
    t.scheduler.start();
    expect(t.scheduler.status().phase).toBe("waiting");
    await t.clock.advance(hour - PREWARM_LEAD_MS - 1);
    expect(t.warmed).toEqual([]);
    await t.clock.advance(1);
    expect(t.scheduler.status().phase).toBe("prewarm");
    expect(t.warmed).toEqual([start + hour - PREWARM_LEAD_MS]);
    await t.clock.advance(PREWARM_LEAD_MS - 1);
    expect(t.evaluations).toEqual([]);
    await t.clock.advance(1);
    expect(t.scheduler.status().phase).toBe("firing");
    expect(t.scheduler.firing()).toBe(true);
    expect(t.evaluations).toEqual([start + hour]);
    await t.clock.advance(FIRING_WINDOW_MS);
    expect(t.scheduler.status().phase).toBe("done");
    expect(t.scheduler.firing()).toBe(false);
    expect(t.evaluations.length).toBe(90);
    expect(t.kicks.length).toBe(90);
    await t.clock.advance(60_000);
    expect(t.evaluations.length).toBe(90);
  });

  test("starting inside the prewarm window warms immediately; past tickets are done", async () => {
    const t = setup(5 * 60_000);
    t.scheduler.start();
    expect(t.scheduler.status().phase).toBe("prewarm");
    expect(t.warmed.length).toBe(1);

    const past = setup(-10 * 60_000);
    past.scheduler.start();
    expect(past.scheduler.status().phase).toBe("done");
  });

  test("warm failure emits a session error but still fires", async () => {
    const t = setup(60_000, async () => {
      throw new Error("TOTP rejected");
    });
    t.scheduler.start();
    await t.clock.advance(60_000);
    expect(t.store.listEvents().some(event => event.kind === "session_error")).toBe(true);
    expect(t.scheduler.status().phase).toBe("firing");
  });

  test("reschedule moves or clears the ticket", async () => {
    const t = setup(60 * 60_000);
    t.scheduler.start();
    t.set({ ticketAt: new Date(t.clock.now() + 2 * 60 * 60_000).toISOString() });
    t.scheduler.reschedule();
    await t.clock.advance(60 * 60_000);
    expect(t.warmed).toEqual([]);
    t.set({ ticketAt: null });
    t.scheduler.reschedule();
    expect(t.scheduler.status()).toEqual({ at: null, phase: "none" });
    await t.clock.advance(3 * 60 * 60_000);
    expect(t.warmed).toEqual([]);
    expect(t.evaluations).toEqual([]);
  });

  test("stop cancels firing", async () => {
    const t = setup(0);
    t.scheduler.start();
    await t.clock.advance(5_000);
    t.scheduler.stop();
    const count = t.evaluations.length;
    await t.clock.advance(10_000);
    expect(t.evaluations.length).toBe(count);
  });
});
