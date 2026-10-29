import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { SeatSourceError, type SeatSource } from "../../src/core/contracts";
import { Store, defaultSettings } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { SeatInfo, Settings, StreamMessage } from "../../src/core/types";
import { baseIntervalSec, isOvernight, jitteredIntervalMs, Poller, ticketNear } from "../../src/engine/poller";

const T = "120271";
// 2026-11-02 09:00 America/Chicago (CST, UTC-6).
const MORNING = Date.UTC(2026, 10, 2, 15, 0, 0);
// 2026-11-03 02:00 America/Chicago.
const NIGHT = Date.UTC(2026, 10, 3, 8, 0, 0);
const chicagoIso = (y: number, m: number, d: number, h: number, min = 0) => new Date(Date.UTC(y, m - 1, d, h + 6, min)).toISOString();

class ScriptedSource implements SeatSource {
  calls: number[] = [];
  seats = new Map<string, number>();
  error: SeatSourceError | null = null;
  constructor(
    readonly kind: SeatSource["kind"],
    private clock: FakeClock,
  ) {}
  async fetchSeats(term: string, crns: string[]): Promise<Omit<SeatInfo, "changedAt">[]> {
    this.calls.push(this.clock.now());
    if (this.error) throw this.error;
    return crns.map(crn => ({ term, crn, available: this.seats.get(crn) ?? 0, max: 30, enrolled: 30 - (this.seats.get(crn) ?? 0), checkedAt: this.clock.now() }));
  }
}

function setup(opts: { start?: number; settings?: Partial<Settings>; fallback?: boolean; arm?: boolean } = {}) {
  const clock = new FakeClock(opts.start ?? MORNING);
  const store = new Store(":memory:");
  const bus = new Bus();
  const events = new Events(store, bus);
  let settings: Settings = { ...defaultSettings(), activeTerm: T, jitterPct: 0, ...opts.settings };
  const course = store.createWanted({ term: T, subject: "CS", number: "225", title: "Data Structures", kind: "bundles" });
  store.setBundles(course.id, [{ crns: ["59777", "31225"] }]);
  if (opts.arm !== false) store.updateWanted(course.id, { armed: true });
  const primary = new ScriptedSource("anonymous", clock);
  const fallback = new ScriptedSource("authenticated", clock);
  const updates: SeatInfo[][] = [];
  const messages: StreamMessage[] = [];
  bus.subscribe(message => messages.push(message));
  const poller = new Poller({
    store,
    events,
    bus,
    clock,
    primary,
    fallback: () => (opts.fallback === false ? null : fallback),
    onSeatsUpdated: changed => updates.push(changed),
    settings: () => settings,
    random: () => 0.5,
  });
  return {
    clock,
    store,
    poller,
    primary,
    fallback,
    updates,
    messages,
    course,
    setSettings: (patch: Partial<Settings>) => (settings = { ...settings, ...patch }),
    gaps: (calls: number[]) => calls.slice(1).map((t, i) => t - calls[i]!),
  };
}

describe("timing helpers", () => {
  test("jitter is symmetric around the base and clamped to 50%", () => {
    const s = { ...defaultSettings(), pollIntervalSec: 10, jitterPct: 20 };
    expect(jitteredIntervalMs(s, MORNING, () => 0)).toBe(8000);
    expect(jitteredIntervalMs(s, MORNING, () => 0.999999)).toBe(12000);
    expect(jitteredIntervalMs({ ...s, jitterPct: 90 }, MORNING, () => 0)).toBe(5000);
  });

  test.each([
    ["09:00", MORNING, false],
    ["01:00", Date.UTC(2026, 10, 3, 7, 0), true],
    ["02:00", NIGHT, true],
    ["06:00", Date.UTC(2026, 10, 3, 12, 0), false],
  ])("isOvernight at %s Chicago is %p", (_label, ms, expected) => {
    expect(isOvernight(ms)).toBe(expected);
  });

  test.each([
    ["tonight inside the overnight window", chicagoIso(2026, 11, 3, 4), NIGHT, true],
    ["after the overnight window ends", chicagoIso(2026, 11, 3, 6, 20), NIGHT, false],
    ["within 30 min in the daytime", chicagoIso(2026, 11, 2, 9, 20), MORNING, true],
    ["tomorrow night", chicagoIso(2026, 11, 4, 2), NIGHT, false],
  ])("ticketNear: %s", (_label, ticketAt, now, expected) => {
    expect(ticketNear(ticketAt, now)).toBe(expected);
  });

  test.each([
    ["floors at 10 s", { pollIntervalSec: 2 }, MORNING, 10],
    ["slows to 60 s overnight", {}, NIGHT, 60],
    ["overnightSlow off", { overnightSlow: false }, NIGHT, 10],
    ["ticket tonight keeps the fast interval", { ticketAt: chicagoIso(2026, 11, 3, 5, 30) }, NIGHT, 10],
  ] as [string, Partial<Settings>, number, number][])("baseIntervalSec %s", (_label, patch, now, expected) => {
    expect(baseIntervalSec({ ...defaultSettings(), ...patch }, now)).toBe(expected);
  });
});

describe("Poller", () => {
  test("polls armed CRNs at the interval and reports status", async () => {
    const t = setup();
    t.poller.start();
    await t.clock.advance(35_000);
    expect(t.gaps(t.primary.calls)).toEqual([10_000, 10_000, 10_000]);
    const status = t.poller.status();
    expect(status).toMatchObject({ state: "running", source: "anonymous", intervalSec: 10, watchedCrns: 2, errorStreak: 0 });
    expect(status.nextCycleAt).toBe(MORNING + 40_000);
    await t.poller.stop();
  });

  test("overnight slows to 60 s unless the ticket is tonight", async () => {
    const slow = setup({ start: NIGHT });
    slow.poller.start();
    await slow.clock.advance(130_000);
    expect(slow.gaps(slow.primary.calls)).toEqual([60_000, 60_000]);
    expect(slow.poller.status().intervalSec).toBe(60);
    await slow.poller.stop();

    const fast = setup({ start: NIGHT, settings: { ticketAt: chicagoIso(2026, 11, 3, 5) } });
    fast.poller.start();
    await fast.clock.advance(30_000);
    expect(fast.gaps(fast.primary.calls)).toEqual([10_000, 10_000, 10_000]);
    await fast.poller.stop();
  });

  test("idle without armed CRNs, paused when globally paused", async () => {
    const t = setup({ arm: false });
    t.poller.start();
    await t.clock.advance(25_000);
    expect(t.primary.calls).toEqual([]);
    expect(t.poller.status().state).toBe("idle");
    t.store.updateWanted(t.course.id, { armed: true });
    t.setSettings({ globalPaused: true });
    await t.clock.advance(10_000);
    expect(t.poller.status().state).toBe("paused");
    expect(t.primary.calls).toEqual([]);
    t.setSettings({ globalPaused: false });
    t.poller.kick();
    await t.clock.advance(200);
    expect(t.primary.calls.length).toBe(1);
    await t.poller.stop();
  });

  test("exponential backoff capped at 120 s, honoring Retry-After", async () => {
    const t = setup();
    t.primary.error = new SeatSourceError("down", "server_error");
    t.poller.start();
    await t.clock.advance(600_000);
    expect(t.gaps(t.primary.calls).slice(0, 6)).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
    expect(t.poller.status().state).toBe("backoff");
    await t.poller.stop();

    const r = setup();
    r.primary.error = new SeatSourceError("429", "rate_limited", 300_000);
    r.poller.start();
    await r.clock.advance(400_000);
    expect(r.gaps(r.primary.calls)[0]).toBe(300_000);
    // Kick does not override a server-requested backoff.
    r.poller.kick();
    await r.clock.advance(200);
    expect(r.primary.calls.length).toBe(2);
    await r.poller.stop();
  });

  test("recovers from backoff after a success", async () => {
    const t = setup();
    t.primary.error = new SeatSourceError("down", "network");
    t.poller.start();
    await t.clock.advance(1_000);
    t.primary.error = null;
    await t.clock.advance(10_000);
    expect(t.poller.status()).toMatchObject({ state: "running", errorStreak: 0 });
    await t.poller.stop();
  });

  test("falls back after 5 login errors, emits poller_degraded once, probes primary every 30 min", async () => {
    const t = setup();
    t.primary.error = new SeatSourceError("redirect", "login_required");
    t.poller.start();
    await t.clock.advance(400_000);
    expect(t.primary.calls.length).toBe(5);
    expect(t.fallback.calls.length).toBeGreaterThan(5);
    expect(t.poller.status()).toMatchObject({ state: "degraded", source: "authenticated" });
    const degraded = t.store.listEvents().filter(event => event.kind === "poller_degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0]!.severity).toBe("warning");

    // Still failing at the 30-minute probe: stays on fallback.
    await t.clock.advance(30 * 60_000);
    expect(t.primary.calls.length).toBe(6);
    expect(t.poller.status().source).toBe("authenticated");

    // Primary healthy again: next probe switches back.
    t.primary.error = null;
    await t.clock.advance(30 * 60_000 + 10_000);
    expect(t.poller.status()).toMatchObject({ state: "running", source: "anonymous" });
    const before = t.primary.calls.length;
    await t.clock.advance(20_000);
    expect(t.primary.calls.length).toBe(before + 2);
    await t.poller.stop();
  });

  test("without a fallback keeps backing off", async () => {
    const t = setup({ fallback: false });
    t.primary.error = new SeatSourceError("redirect", "login_required");
    t.poller.start();
    await t.clock.advance(600_000);
    expect(t.poller.status().state).toBe("backoff");
    expect(t.store.listEvents().some(event => event.kind === "poller_degraded")).toBe(false);
    await t.poller.stop();
  });

  test("upserts seats, emits seat_changed only on 0 <-> >0 crossings, publishes changed seats", async () => {
    const t = setup();
    t.poller.start();
    await t.clock.advance(1_000);
    expect(t.store.getSeat(T, "59777")?.available).toBe(0);
    expect(t.updates[0]!.length).toBe(2); // first readings count as changed

    t.primary.seats.set("59777", 2);
    await t.clock.advance(10_000);
    t.primary.seats.set("59777", 1);
    await t.clock.advance(10_000);
    await t.clock.advance(10_000); // no change
    t.primary.seats.set("59777", 0);
    await t.clock.advance(10_000);

    const changes = t.store.listEvents().filter(event => event.kind === "seat_changed").reverse();
    expect(changes.map(event => event.payload)).toEqual([
      { term: T, crn: "59777", available: 2, max: 30 },
      { term: T, crn: "59777", available: 0, max: 30 },
    ]);
    expect(t.updates.map(changed => changed.map(seat => `${seat.crn}:${seat.available}`))).toEqual([
      ["59777:0", "31225:0"],
      ["59777:2"],
      ["59777:1"],
      [],
      ["59777:0"],
    ]);
    const seatMessages = t.messages.filter(message => message.type === "seats");
    expect(seatMessages.length).toBe(4);
    expect(t.store.getSeat(T, "59777")?.checkedAt).toBe(t.poller.status().lastCycleAt!);
    await t.poller.stop();
  });
});
