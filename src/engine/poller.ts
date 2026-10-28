// Seat poller: reads live seats for armed CRNs on a jittered interval, with backoff and a fallback source.

import type { Bus } from "../core/bus";
import type { Clock } from "../core/clock";
import { SeatSourceError, type PollerApi, type SeatSource } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import type { PollerState, SeatInfo, Settings, SystemStatus } from "../core/types";

export const MIN_INTERVAL_SEC = 10;
export const OVERNIGHT_INTERVAL_SEC = 60;
export const MAX_BACKOFF_MS = 120_000;
export const LOGIN_ERRORS_BEFORE_FALLBACK = 5;
export const PRIMARY_PROBE_EVERY_MS = 30 * 60 * 1000;
export const KICK_DELAY_MS = 100;
const TICKET_NEAR_MS = 30 * 60 * 1000;
const CYCLE_TIMEOUT_MS = 45_000;

const chicagoParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function chicago(ms: number): { date: string; hour: number } {
  const parts = Object.fromEntries(chicagoParts.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** 01:00 to 06:00 America/Chicago. */
export function isOvernight(ms: number): boolean {
  const { hour } = chicago(ms);
  return hour >= 1 && hour < 6;
}

/** True when the ticket opens within 30 minutes of now, or inside tonight's overnight window. */
export function ticketNear(ticketAt: string | null, now: number): boolean {
  if (!ticketAt) return false;
  const at = Date.parse(ticketAt);
  if (!Number.isFinite(at)) return false;
  if (Math.abs(at - now) <= TICKET_NEAR_MS) return true;
  if (!isOvernight(now) || !isOvernight(at)) return false;
  return chicago(at).date === chicago(now).date;
}

/** Base interval in seconds before jitter. */
export function baseIntervalSec(settings: Pick<Settings, "pollIntervalSec" | "overnightSlow" | "ticketAt">, now: number): number {
  const base = Math.max(MIN_INTERVAL_SEC, Number.isFinite(settings.pollIntervalSec) ? settings.pollIntervalSec : MIN_INTERVAL_SEC);
  if (settings.overnightSlow && isOvernight(now) && !ticketNear(settings.ticketAt, now)) return Math.max(base, OVERNIGHT_INTERVAL_SEC);
  return base;
}

/** Interval in ms with symmetric jitter of jitterPct percent. */
export function jitteredIntervalMs(
  settings: Pick<Settings, "pollIntervalSec" | "overnightSlow" | "ticketAt" | "jitterPct">,
  now: number,
  random: () => number = Math.random,
): number {
  const base = baseIntervalSec(settings, now) * 1000;
  const pct = Math.min(50, Math.max(0, settings.jitterPct || 0)) / 100;
  return Math.round(base * (1 + (random() * 2 - 1) * pct));
}

export function backoffMs(errorStreak: number, intervalMs: number, retryAfterMs: number | null): number {
  const exponential = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.max(0, errorStreak - 1));
  return Math.max(exponential, retryAfterMs ?? 0);
}

export interface PollerDeps {
  store: Store;
  events: Events;
  bus: Bus;
  clock: Clock;
  primary: SeatSource;
  fallback: () => SeatSource | null;
  /** Called after every successful cycle with the seats whose `available` changed (may be empty). */
  onSeatsUpdated: (changed: SeatInfo[]) => void;
  settings: () => Settings;
  random?: () => number;
}

export class Poller implements PollerApi {
  private timer: { cancel(): void } | null = null;
  private running = false;
  private cycle: Promise<void> | null = null;
  private kickPending = false;
  private abort: AbortController | null = null;

  private state: PollerState = "idle";
  private usingFallback: SeatSource | null = null;
  private degradedNotified = false;
  private lastProbeAt = 0;
  private errorStreak = 0;
  private loginStreak = 0;
  private inBackoff = false;
  private lastCycleAt: number | null = null;
  private lastCycleMs: number | null = null;
  private nextCycleAt: number | null = null;
  private intervalSec = MIN_INTERVAL_SEC;
  private watched = 0;

  constructor(private deps: PollerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.timer?.cancel();
    this.timer = null;
    this.abort?.abort(new Error("poller stopped"));
    this.nextCycleAt = null;
    await this.cycle?.catch(() => undefined);
  }

  kick(): void {
    if (!this.running) return;
    if (this.cycle) {
      this.kickPending = true;
      return;
    }
    // Respect a server-requested backoff; everything else runs right away.
    if (this.inBackoff && this.nextCycleAt !== null && this.nextCycleAt - this.deps.clock.now() > KICK_DELAY_MS) return;
    this.schedule(KICK_DELAY_MS);
  }

  status(): SystemStatus["poller"] {
    return {
      state: this.state,
      source: (this.usingFallback ?? this.deps.primary).kind,
      intervalSec: this.intervalSec,
      lastCycleAt: this.lastCycleAt,
      nextCycleAt: this.nextCycleAt,
      lastCycleMs: this.lastCycleMs,
      watchedCrns: this.watched,
      errorStreak: this.errorStreak,
    };
  }

  /** True while the fallback (authenticated) source is in use. */
  degraded(): boolean {
    return this.usingFallback !== null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer?.cancel();
    const delay = Math.max(0, ms);
    this.nextCycleAt = this.deps.clock.now() + delay;
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null;
      this.cycle = this.runCycle().finally(() => {
        this.cycle = null;
      });
    }, delay);
  }

  private async runCycle(): Promise<void> {
    const { clock, store } = this.deps;
    const settings = this.deps.settings();
    const now = clock.now();
    this.intervalSec = baseIntervalSec(settings, now);
    const interval = jitteredIntervalMs(settings, now, this.deps.random);
    let next = interval;
    try {
      const term = settings.activeTerm;
      const crns = term ? store.armedCrns(term) : [];
      this.watched = crns.length;
      if (settings.globalPaused) {
        this.state = "paused";
        return;
      }
      if (!term || crns.length === 0) {
        this.state = "idle";
        return;
      }
      next = await this.poll(term, crns, interval);
    } catch (error) {
      console.error("poller cycle failed", error);
    } finally {
      if (this.running) {
        if (this.kickPending && !this.inBackoff) next = Math.min(next, KICK_DELAY_MS);
        this.kickPending = false;
        this.schedule(next);
      }
    }
  }

  /** One fetch. Returns the delay until the next cycle. */
  private async poll(term: string, crns: string[], interval: number): Promise<number> {
    const { clock, store } = this.deps;
    const started = clock.now();
    let source = this.usingFallback ?? this.deps.primary;

    if (this.usingFallback && started - this.lastProbeAt >= PRIMARY_PROBE_EVERY_MS) {
      this.lastProbeAt = started;
      if (await this.probePrimary(term, crns)) source = this.deps.primary;
    }

    this.abort = new AbortController();
    const timeout = clock.setTimeout(() => this.abort?.abort(new Error("cycle timeout")), CYCLE_TIMEOUT_MS);
    try {
      const seats = await source.fetchSeats(term, crns, this.abort.signal);
      this.lastCycleMs = clock.now() - started;
      this.lastCycleAt = clock.now();
      this.errorStreak = 0;
      this.loginStreak = 0;
      this.inBackoff = false;
      this.state = this.usingFallback ? "degraded" : "running";
      this.apply(seats);
      return interval;
    } catch (error) {
      if (!this.running) return interval;
      const sourceError =
        error instanceof SeatSourceError ? error : new SeatSourceError(String((error as Error)?.message ?? error), "network");
      this.lastCycleMs = clock.now() - started;
      this.lastCycleAt = clock.now();
      this.errorStreak++;
      this.loginStreak = sourceError.reason === "login_required" ? this.loginStreak + 1 : 0;
      if (!this.usingFallback && this.loginStreak >= LOGIN_ERRORS_BEFORE_FALLBACK && this.switchToFallback(sourceError)) {
        return KICK_DELAY_MS;
      }
      this.inBackoff = true;
      this.state = "backoff";
      return backoffMs(this.errorStreak, interval, sourceError.retryAfterMs);
    } finally {
      timeout.cancel();
      this.abort = null;
    }
  }

  private switchToFallback(error: SeatSourceError): boolean {
    let fallback: SeatSource | null = null;
    try {
      fallback = this.deps.fallback();
    } catch {
      fallback = null;
    }
    if (!fallback || fallback === this.deps.primary) return false;
    this.usingFallback = fallback;
    this.lastProbeAt = this.deps.clock.now();
    this.errorStreak = 0;
    this.loginStreak = 0;
    this.inBackoff = false;
    this.state = "degraded";
    if (!this.degradedNotified) {
      this.degradedNotified = true;
      this.deps.events.emit({
        kind: "poller_degraded",
        severity: "warning",
        title: "Anonymous seat lookups stopped working",
        detail: `Switched to the logged-in session for seat counts after ${LOGIN_ERRORS_BEFORE_FALLBACK} login redirects (${error.message}).`,
      });
    }
    return true;
  }

  private async probePrimary(term: string, crns: string[]): Promise<boolean> {
    try {
      const seats = await this.deps.primary.fetchSeats(term, crns.slice(0, 1));
      if (seats.length === 0) return false;
      this.usingFallback = null;
      this.degradedNotified = false;
      this.deps.events.emit({
        kind: "info",
        severity: "info",
        title: "Anonymous seat lookups recovered",
        detail: "Seat counts come from the anonymous endpoint again.",
      });
      return true;
    } catch {
      return false;
    }
  }

  private apply(seats: Omit<SeatInfo, "changedAt">[]): void {
    const { store, events, bus } = this.deps;
    const changed: SeatInfo[] = [];
    const crossings: { seat: SeatInfo; opened: boolean }[] = [];
    store.tx(() => {
      for (const seat of seats) {
        const { previous, current } = store.upsertSeat(seat);
        if (previous && previous.available === current.available) continue;
        changed.push(current);
        if (previous && previous.available > 0 !== current.available > 0) crossings.push({ seat: current, opened: current.available > 0 });
      }
    });
    for (const { seat, opened } of crossings) {
      events.emit({
        kind: "seat_changed",
        severity: "info",
        title: opened ? `CRN ${seat.crn} opened (${seat.available} of ${seat.max})` : `CRN ${seat.crn} closed`,
        crns: [seat.crn],
        payload: { term: seat.term, crn: seat.crn, available: seat.available, max: seat.max },
      });
    }
    if (changed.length) bus.publish({ type: "seats", seats: changed });
    try {
      this.deps.onSeatsUpdated(changed);
    } catch (error) {
      console.error("onSeatsUpdated failed", error);
    }
  }
}
