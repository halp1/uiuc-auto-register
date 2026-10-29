// Interfaces between modules. Each module owner implements one side; src/index.ts wires them.

import type { Approval, AppEvent, RegisterRequest, RegisterResult, SeatInfo, SessionState, Term, TicketParse } from "./types";

/** Live seat counts for specific CRNs. */
export interface SeatSource {
  readonly kind: "anonymous" | "authenticated" | "simulated";
  /**
   * Fetch current seat counts. Must not throw for individual CRN failures; omit those CRNs instead.
   * Throws SeatSourceError when the source as a whole is unusable (login redirect, HTTP 5xx, 429).
   */
  fetchSeats(term: string, crns: string[], signal?: AbortSignal): Promise<Omit<SeatInfo, "changedAt">[]>;
}

export class SeatSourceError extends Error {
  constructor(
    message: string,
    readonly reason: "login_required" | "rate_limited" | "server_error" | "network" | "parse",
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "SeatSourceError";
  }
}

/** Performs (or simulates) a registration batch. */
export interface Registrar {
  readonly kind: "simulated" | "rehearsal" | "live";
  register(request: RegisterRequest, signal?: AbortSignal): Promise<RegisterResult>;
}

export interface RehearsalReport {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  steps: { name: string; ok: boolean; detail: string | null; ms: number }[];
  term: string;
  eligibility: { allowed: boolean; messages: string[] } | null;
  schedule: string[] | null; // CRNs currently registered for the term
  crnChecks: { crn: string; exists: boolean; title: string | null }[];
  blockedWrites: number; // write requests the interceptor refused (should be 0)
  /** Which schedule reader produced `schedule`. Live only trusts rehearsals from the current reader. */
  reader?: string;
  /** Set when the term is not open yet but Banner shows a future time ticket (ISO). */
  opensAt?: string | null;
  /** The term whose schedule was read: `term`, or another open term when `term` is not open yet. */
  readerTerm?: string | null;
}

/** Owns the logged-in Banner browser session. Only the auth module implements this. */
export interface SessionManager {
  state(): SessionState;
  /** Log in if needed. Resolves when the registration page is ready. */
  ensureWarm(term: string): Promise<void>;
  /** Close the browser and forget the session. */
  goCold(reason: string): Promise<void>;
  /** Read currently registered CRNs for a term (read-only). */
  readSchedule(term: string): Promise<string[]>;
  /** Read-only: the time ticket shown on Prepare for Registration for a term. */
  readTicket(term: string): Promise<TicketParse>;
  /** Full read-only rehearsal of the live path. */
  rehearse(term: string, crns: string[], opts?: { otherTerms?: string[]; knownTicketAt?: string | null }): Promise<RehearsalReport>;
  /** Authenticated seat source used as fallback when the anonymous endpoint stops working. */
  authenticatedSeatSource(): SeatSource;
  dispose(): Promise<void>;
}

export interface CatalogService {
  terms(): Promise<Term[]>;
  sync(term: string, opts?: { force?: boolean }): Promise<{ courses: number }>;
  syncing(): boolean;
}

/** Notification channels. Implemented by src/notify. */
export interface Notifier {
  /** Called for every emitted event; routes according to settings. Never throws. */
  handle(event: AppEvent): void;
  /** Approval lifecycle hooks, so channels with buttons can post and later edit their messages. */
  approvalCreated(approval: Approval): void;
  approvalResolved(approval: Approval, resultText: string): void;
  approvalReminder(approval: Approval): void;
  test(channel: "discord" | "push" | "webhook"): Promise<{ ok: boolean; detail: string }>;
  /** Re-read settings (token changed etc.). */
  reload(): Promise<void>;
  dispose(): Promise<void>;
}

// ---------- engine components (implemented in src/engine, wired in src/app.ts) ----------

export interface PollerApi {
  start(): void;
  stop(): Promise<void>;
  /** Run a cycle soon (e.g. after arming a course). */
  kick(): void;
  status(): import("./types").SystemStatus["poller"];
}

export interface OrchestratorApi {
  /** Evaluate bundles after seats or wanted courses changed. Idempotent. */
  evaluate(reason: string): void;
  approve(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }>;
  skip(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }>;
  /** Called by the post-submit guard (or anything) to halt all registration. */
  tripGuard(detail: string): void;
  guardState(): { at: number; detail: string } | null;
  clearGuard(): void;
  stop(): Promise<void>;
}

export interface TicketApi {
  start(): void;
  stop(): void;
  /** Settings changed (ticket time, term). */
  reschedule(): void;
  status(): import("./types").SystemStatus["ticket"];
}

/** Fake Banner used in simulated mode and tests. */
export interface SimBannerApi {
  setSeats(term: string, crn: string, available: number, max?: number): void;
  /** Next registration attempt for this CRN (or any CRN when crn is null) fails with this Banner message. */
  scriptError(crn: string | null, message: string): void;
  setSchedule(term: string, crns: string[]): void;
  schedule(term: string): string[];
  state(): { seats: SeatInfo[]; schedule: Record<string, string[]>; scripted: { crn: string | null; message: string }[] };
  reset(): void;
}

/** What notification channels may call back into (Discord buttons, slash commands, push actions). */
export interface ControlApi {
  approve(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }>;
  skip(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }>;
  pauseAll(via: string): void;
  resumeAll(via: string): void;
  statusText(): string;
}
