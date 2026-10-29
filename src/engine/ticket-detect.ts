// Keeps the registration time ticket in sync with Banner's Prepare for Registration page.
// Read-only: it only reads the page through the session. It changes settings.ticketAt, nothing else.

import type { Clock } from "../core/clock";
import type { Events } from "../core/events";
import { termLabel } from "../core/terms";
import type { Settings, SystemStatus, TicketDetectResult } from "../core/types";
import { currentWindow, type TicketParse } from "../banner/ticket";

/** How often to look again while auto detection is on. Tickets are posted weeks ahead and rarely move. */
export const DETECT_EVERY_MS = 12 * 60 * 60 * 1000;
/** First automatic check after startup or a term change. */
export const DETECT_FIRST_DELAY_MS = 60 * 1000;
/** After a failed check. */
export const DETECT_RETRY_MS = 60 * 60 * 1000;
/** Never move the browser off the registration page this close to the ticket. */
export const DETECT_QUIET_BEFORE_MS = 30 * 60 * 1000;
export const DETECT_QUIET_AFTER_MS = 10 * 60 * 1000;

export interface TicketDetectorDeps {
  clock: Clock;
  settings: () => Settings;
  applySettings: (patch: Partial<Settings>) => unknown;
  events: Events;
  /** Null in simulated mode. */
  readTicket: ((term: string) => Promise<TicketParse>) | null;
  ticketPhase: () => SystemStatus["ticket"]["phase"];
}

export class TicketDetectError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TicketDetectError";
  }
}

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export class TicketDetector {
  private timer: { cancel(): void } | null = null;
  private running = false;
  private inFlight: Promise<TicketDetectResult> | null = null;
  private generation = 0;

  constructor(private deps: TicketDetectorDeps) {}

  start(): void {
    if (this.running || !this.deps.readTicket) return;
    this.running = true;
    this.schedule(DETECT_FIRST_DELAY_MS);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.timer?.cancel();
    this.timer = null;
  }

  /** Call after settings change. A new term or turning auto on checks again soon. */
  settingsChanged(before: Settings, after: Settings): void {
    if (!this.running) return;
    if (after.activeTerm !== before.activeTerm || (after.ticketAuto && !before.ticketAuto)) this.schedule(DETECT_FIRST_DELAY_MS);
  }

  private quiet(settings: Settings, now: number): boolean {
    const phase = this.deps.ticketPhase();
    if (phase === "prewarm" || phase === "firing") return true;
    const at = settings.ticketAt ? Date.parse(settings.ticketAt) : NaN;
    return Number.isFinite(at) && now > at - DETECT_QUIET_BEFORE_MS && now < at + DETECT_QUIET_AFTER_MS;
  }

  private schedule(delayMs: number): void {
    const generation = ++this.generation;
    this.timer?.cancel();
    this.timer = this.deps.clock.setTimeout(() => {
      if (generation !== this.generation || !this.running) return;
      void this.autoRun().then(next => {
        if (generation === this.generation && this.running) this.schedule(next);
      });
    }, delayMs);
  }

  /** One automatic check. Returns the delay until the next one. */
  private async autoRun(): Promise<number> {
    const settings = this.deps.settings();
    const term = settings.activeTerm;
    const now = this.deps.clock.now();
    if (!settings.ticketAuto || !term) return DETECT_EVERY_MS;
    if (settings.sessionPausedUntil && settings.sessionPausedUntil > now) return Math.max(DETECT_FIRST_DELAY_MS, settings.sessionPausedUntil - now + DETECT_FIRST_DELAY_MS);
    if (this.quiet(settings, now)) return DETECT_RETRY_MS;
    try {
      await this.detect(term, { manual: false });
      return DETECT_EVERY_MS;
    } catch {
      return DETECT_RETRY_MS;
    }
  }

  /** Read the ticket for a term and apply it when auto detection is on (or when asked by hand). */
  detect(term: string, opts: { manual: boolean }): Promise<TicketDetectResult> {
    if (!this.deps.readTicket) throw new TicketDetectError(409, "Ticket detection needs rehearsal or live mode. Simulated mode never logs in.");
    const settings = this.deps.settings();
    const now = this.deps.clock.now();
    if (settings.sessionPausedUntil && settings.sessionPausedUntil > now) throw new TicketDetectError(409, "The Banner session is paused.");
    if (this.quiet(settings, now)) throw new TicketDetectError(409, "Registration opens soon. The ticket is not checked this close to it.");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(term, opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(term: string, opts: { manual: boolean }): Promise<TicketDetectResult> {
    let parsed: TicketParse;
    try {
      parsed = await this.deps.readTicket!(term);
    } catch (error) {
      const reason = (error as { reason?: string })?.reason ?? "read_failed";
      this.deps.events.emit({
        kind: "info",
        severity: "warning",
        title: "Could not read your time ticket",
        detail: reason,
        payload: { term, reason },
      });
      throw new TicketDetectError(502, `Could not read the time ticket from Banner (${reason}).`);
    }
    const now = this.deps.clock.now();
    const settings = this.deps.settings();
    const result: TicketDetectResult = { term, found: false, ticketAt: null, windows: [], applied: false, checkedAt: now };
    const sameTerm = settings.activeTerm === term;
    const mayApply = sameTerm && (settings.ticketAuto || opts.manual);
    const patch: Partial<Settings> = { ticketCheckedAt: now, ticketCheckedTerm: term };

    if (parsed.status === "found") {
      const window = currentWindow(parsed.windows, now);
      result.windows = parsed.windows;
      result.found = window !== null;
      result.ticketAt = window?.start ?? null;
      if (mayApply && window && window.start !== settings.ticketAt) {
        Object.assign(patch, { ticketAt: window.start, ticketSource: "banner" as const });
        if (opts.manual) patch.ticketAuto = true;
        result.applied = true;
      } else if (mayApply && window && opts.manual) {
        Object.assign(patch, { ticketSource: "banner" as const, ticketAuto: true });
      }
    } else if (parsed.status === "none") {
      // Banner says there is no ticket. A ticket this app took from Banner earlier is no longer right.
      if (mayApply && settings.ticketSource === "banner" && settings.ticketAt) {
        Object.assign(patch, { ticketAt: null, ticketSource: null });
        result.applied = true;
      }
    }
    this.deps.applySettings(patch);

    if (result.applied && result.ticketAt) {
      this.deps.events.emit({
        kind: "info",
        severity: "info",
        title: `Time ticket for ${termLabel(term)}: ${fmt.format(new Date(result.ticketAt))}`,
        detail: "Read from Banner's Prepare for Registration page.",
        payload: { term, ticketAt: result.ticketAt, windows: result.windows },
      });
    } else if (result.applied) {
      this.deps.events.emit({ kind: "info", severity: "info", title: `No time ticket for ${termLabel(term)} on Banner yet`, payload: { term } });
    } else if (parsed.status === "unreadable" && opts.manual) {
      this.deps.events.emit({
        kind: "info",
        severity: "warning",
        title: "Could not find a time ticket on Banner",
        detail: "The Prepare for Registration page did not show a date the app could read. Enter it by hand.",
        payload: { term },
      });
    }
    return result;
  }
}
