// Registration time ticket: warm the session early, then hammer evaluate for the first 90 s after opening.

import type { Clock } from "../core/clock";
import type { OrchestratorApi, PollerApi, TicketApi } from "../core/contracts";
import type { Events } from "../core/events";
import { termLabel } from "../core/terms";
import type { Settings, SystemStatus } from "../core/types";

export const PREWARM_LEAD_MS = 10 * 60 * 1000;
export const FIRING_WINDOW_MS = 90_000;
export const FIRING_TICK_MS = 1000;

type Phase = SystemStatus["ticket"]["phase"];

export interface TicketDeps {
  clock: Clock;
  settings: () => Settings;
  /** Log in ahead of the ticket (no-op in simulated mode). */
  ensureWarm: (term: string) => Promise<void>;
  orchestrator: Pick<OrchestratorApi, "evaluate">;
  poller: Pick<PollerApi, "kick">;
  events: Events;
}

export class TicketScheduler implements TicketApi {
  private phase: Phase = "none";
  private at: string | null = null;
  private timer: { cancel(): void } | null = null;
  private running = false;
  private firingUntil = 0;
  /** Bumped on every reschedule so stale callbacks do nothing. */
  private generation = 0;

  constructor(private deps: TicketDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reschedule();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.timer?.cancel();
    this.timer = null;
  }

  /** True during the 90 s after the ticket opens. The orchestrator skips transient cooldowns then. */
  firing(): boolean {
    return this.phase === "firing";
  }

  status(): SystemStatus["ticket"] {
    return { at: this.at, phase: this.phase };
  }

  reschedule(): void {
    const generation = ++this.generation;
    this.timer?.cancel();
    this.timer = null;
    const settings = this.deps.settings();
    this.at = settings.ticketAt;
    const ticket = settings.ticketAt ? Date.parse(settings.ticketAt) : NaN;
    if (!Number.isFinite(ticket)) {
      this.phase = "none";
      return;
    }
    const now = this.deps.clock.now();
    if (now >= ticket + FIRING_WINDOW_MS) {
      this.phase = "done";
      return;
    }
    if (!this.running) {
      this.phase = "waiting";
      return;
    }
    if (now >= ticket) {
      this.fire(generation, ticket);
      return;
    }
    if (now >= ticket - PREWARM_LEAD_MS) {
      this.prewarm(generation, ticket);
      return;
    }
    this.phase = "waiting";
    this.timer = this.deps.clock.setTimeout(() => {
      if (generation === this.generation) this.prewarm(generation, ticket);
    }, ticket - PREWARM_LEAD_MS - now);
  }

  private prewarm(generation: number, ticket: number): void {
    this.phase = "prewarm";
    const term = this.deps.settings().activeTerm;
    if (term) {
      this.deps.events.emit({
        kind: "info",
        severity: "info",
        title: `Registration opens soon for ${termLabel(term)}`,
        detail: "Logging in ahead of the time ticket.",
      });
      this.deps.ensureWarm(term).catch(error => {
        this.deps.events.emit({
          kind: "session_error",
          severity: "critical",
          title: "Could not log in ahead of the time ticket",
          detail: String((error as Error)?.message ?? error),
        });
      });
    }
    this.timer?.cancel();
    this.timer = this.deps.clock.setTimeout(() => {
      if (generation === this.generation) this.fire(generation, ticket);
    }, Math.max(0, ticket - this.deps.clock.now()));
  }

  private fire(generation: number, ticket: number): void {
    this.phase = "firing";
    this.firingUntil = ticket + FIRING_WINDOW_MS;
    const tick = () => {
      if (generation !== this.generation) return;
      if (this.deps.clock.now() >= this.firingUntil) {
        this.phase = "done";
        this.timer = null;
        return;
      }
      try {
        this.deps.poller.kick();
        this.deps.orchestrator.evaluate("ticket");
      } catch (error) {
        console.error("ticket tick failed", error);
      }
      this.timer = this.deps.clock.setTimeout(tick, FIRING_TICK_MS);
    };
    tick();
  }
}
