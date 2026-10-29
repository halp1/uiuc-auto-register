// Decides when to register: watches fully open bundles, runs one registration at a time, manages approvals.

import type { Bus } from "../core/bus";
import type { Clock } from "../core/clock";
import type { ControlApi, OrchestratorApi, Registrar } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import { termLabel } from "../core/terms";
import type {
  Approval,
  Bundle,
  FailureClass,
  RegisterRequest,
  RegisterResult,
  SeatInfo,
  Settings,
  WantedCourse,
} from "../core/types";
import { classifyMessages } from "../banner/classify";
import { courseForCrn, sectionsByCrn } from "../catalog/store";
import { hasClosedCrn, isFullyOpen, openBundles, type SeatLookup } from "./planner";
import { planConflicts } from "./schedule";

export const REMIND_AFTER_MS = 5 * 60 * 1000;
export const TRANSIENT_COOLDOWN_MS = 30_000;
/** Registration attempts are held until this close to the ticket time. */
const TICKET_HOLD_LEAD_MS = 1000;

export interface ApprovalHooks {
  approvalCreated(approval: Approval): void;
  approvalResolved(approval: Approval, resultText: string): void;
  approvalReminder(approval: Approval): void;
}

export interface OrchestratorDeps {
  store: Store;
  events: Events;
  bus: Bus;
  clock: Clock;
  registrar: () => Registrar;
  settings: () => Settings;
  updateSettings: (patch: Partial<Settings>) => unknown;
  notifier?: Partial<ApprovalHooks>;
  /** Live mode: verifies the schedule after a submit. ok:false trips the guard. */
  postSubmitCheck?: (request: RegisterRequest, result: RegisterResult) => Promise<{ ok: boolean; detail: string }>;
  /** True while the ticket scheduler is in its firing window (no cooldowns for "not open" failures). */
  firing?: () => boolean;
}

type AttemptOutcome = "registered" | "next" | "stop_course" | "halt";

export class Orchestrator implements OrchestratorApi, ControlApi {
  private lock: Promise<unknown> = Promise.resolve();
  private evalQueued = false;
  private stopped = false;
  private guard: { at: number; detail: string } | null = null;
  /** Bundles that should not prompt or dry-run again until they close and reopen. */
  private suppressed = new Set<number>();
  /** Bundles announced as open while paused, so the announcement is not repeated. */
  private announced = new Set<number>();
  private cooldownUntil = new Map<number, number>();
  private transientStreak = new Map<number, number>();
  private cooldownTimer: { cancel(): void } | null = null;
  private approvalTimer: { cancel(): void } | null = null;

  constructor(private deps: OrchestratorDeps) {
    this.recover();
    this.scheduleApprovalTimer();
  }

  // ---------- public API ----------

  evaluate(reason: string): void {
    if (this.stopped || this.evalQueued) return;
    this.evalQueued = true;
    void this.withLock(async () => {
      this.evalQueued = false;
      if (this.stopped) return;
      await this.runEvaluate(reason);
      this.scheduleApprovalTimer();
    });
  }

  /** Resolves once every queued evaluation and registration has finished (tests and shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.lock;
      await current.catch(() => undefined);
      if (current === this.lock && !this.evalQueued) return;
    }
  }

  approve(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }> {
    return this.withLock(async () => {
      const approval = this.deps.store.getApproval(approvalId);
      if (!approval) return { ok: false, detail: "That approval no longer exists." };
      if (approval.state !== "pending") return { ok: false, detail: `Already ${approval.state}.` };
      const blocked = this.haltReason();
      if (blocked) return { ok: false, detail: blocked };
      const ctx = this.context(approval);
      if (!ctx) {
        this.resolve(approval, "expired", "Expired, course or bundle removed");
        return { ok: false, detail: "The course or bundle was removed." };
      }
      const seats = this.seatLookup(ctx.course.term);
      if (!isFullyOpen(ctx.bundle.crns, seats)) {
        this.resolve(approval, "expired", "Expired, seat closed");
        return { ok: false, detail: "A seat in this bundle closed again." };
      }
      if (!this.deps.store.resolveApproval(approval.id, "approved")) return { ok: false, detail: "Already resolved." };
      this.publishApprovals();
      const outcome = await this.attempt(ctx.course, ctx.bundle, `approved via ${via}`);
      const text = this.attemptText(ctx.course, outcome);
      this.deps.notifier?.approvalResolved?.({ ...approval, state: "approved", resolvedAt: this.deps.clock.now() }, text);
      if (outcome.result !== "registered") this.evaluate("after approval");
      return { ok: outcome.result === "registered", detail: text };
    });
  }

  skip(approvalId: number, via: string): Promise<{ ok: boolean; detail: string }> {
    return this.withLock(async () => {
      const approval = this.deps.store.getApproval(approvalId);
      if (!approval) return { ok: false, detail: "That approval no longer exists." };
      if (approval.state !== "pending") return { ok: false, detail: `Already ${approval.state}.` };
      this.suppressed.add(approval.bundleId);
      this.resolve(approval, "skipped", `Skipped via ${via}`);
      return { ok: true, detail: "Skipped. It will ask again if the seat closes and reopens." };
    });
  }

  tripGuard(detail: string): void {
    const at = this.deps.clock.now();
    this.guard = { at, detail };
    try {
      this.deps.updateSettings({ globalPaused: true });
    } catch (error) {
      console.error("tripGuard: could not pause", error);
    }
    this.deps.events.emit({
      kind: "guard_tripped",
      severity: "critical",
      title: "Safety guard stopped all registration",
      detail,
    });
    this.publishWanted();
  }

  guardState(): { at: number; detail: string } | null {
    return this.guard;
  }

  /** Clears the guard. Registration stays paused until the student resumes. */
  clearGuard(): void {
    if (!this.guard) return;
    this.guard = null;
    this.deps.events.emit({ kind: "control", severity: "info", title: "Safety guard cleared", detail: "Resume to start registering again." });
  }

  pauseAll(via: string): void {
    this.deps.updateSettings({ globalPaused: true });
    this.deps.events.emit({ kind: "control", severity: "info", title: "Paused", detail: `Paused via ${via}` });
  }

  resumeAll(via: string): void {
    this.deps.updateSettings({ globalPaused: false });
    this.deps.events.emit({
      kind: "control",
      severity: "info",
      title: "Resumed",
      detail: this.guard ? `Resumed via ${via}. The safety guard is still tripped; clear it in the dashboard.` : `Resumed via ${via}`,
    });
    this.evaluate("resume");
  }

  statusText(): string {
    const settings = this.deps.settings();
    const lines: string[] = [];
    const term = settings.activeTerm;
    lines.push(`Term: ${term ? termLabel(term) : "none selected"}`);
    lines.push(settings.globalPaused ? "Registration: paused" : "Registration: running");
    if (this.guard) lines.push(`Guard tripped: ${this.guard.detail}`);
    if (term) {
      const seats = this.seatLookup(term);
      for (const course of this.deps.store.listWanted(term)) {
        const open = course.bundles.filter(bundle => isFullyOpen(bundle.crns, seats)).length;
        const state = course.state === "watching" ? (course.armed ? "watching" : "disarmed") : course.state;
        lines.push(`${course.subject} ${course.number}: ${state}, ${open} of ${course.bundles.length} bundles open`);
      }
    }
    const pending = this.deps.store.pendingApprovals();
    if (pending.length) lines.push(`Waiting for approval: ${pending.map(approval => approval.label).join(", ")}`);
    return lines.join("\n");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cooldownTimer?.cancel();
    this.approvalTimer?.cancel();
    await this.lock.catch(() => undefined);
  }

  // ---------- internals ----------

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(error => console.error("orchestrator task failed", error));
    return run;
  }

  /** Reset bundle states left over from a crash or restart. */
  private recover(): void {
    const { store } = this.deps;
    for (const course of store.listWanted()) {
      for (const bundle of course.bundles) {
        if (bundle.state === "registering") store.setBundleState(bundle.id, "watching");
        if (bundle.state === "pending_approval" && !store.pendingApprovalForBundle(bundle.id)) store.setBundleState(bundle.id, "watching");
      }
    }
  }

  private haltReason(): string | null {
    if (this.guard) return "The safety guard is tripped. Clear it in the dashboard first.";
    if (this.deps.settings().globalPaused) return "Registration is paused.";
    return null;
  }

  private seatLookup(term: string): SeatLookup {
    const map = new Map<string, SeatInfo>(this.deps.store.listSeats(term).map(seat => [seat.crn, seat]));
    return crn => map.get(crn) ?? null;
  }

  private context(approval: Approval): { course: WantedCourse; bundle: Bundle } | null {
    const course = this.deps.store.getWanted(approval.courseId);
    const bundle = course?.bundles.find(entry => entry.id === approval.bundleId);
    return course && bundle ? { course, bundle } : null;
  }

  private ticketHeld(settings: Settings): boolean {
    if (!settings.ticketAt) return false;
    const at = Date.parse(settings.ticketAt);
    return Number.isFinite(at) && this.deps.clock.now() < at - TICKET_HOLD_LEAD_MS;
  }

  label(course: Pick<WantedCourse, "term" | "subject" | "number">, crns: string[]): string {
    const parts = crns.map(crn => {
      const known = courseForCrn(this.deps.store, course.term, crn);
      return known && known.subject === course.subject && known.number === course.number && known.section ? known.section : crn;
    });
    return `${course.subject} ${course.number} ${parts.join(" + ")}`;
  }

  private async runEvaluate(reason: string): Promise<void> {
    const { store } = this.deps;
    const settings = this.deps.settings();
    const term = settings.activeTerm;
    if (!term) return;
    const seats = this.seatLookup(term);
    const courses = store.listWanted(term);
    let changed = false;

    // Pending approvals: expire when a seat closes or the course stops being eligible.
    for (const approval of store.pendingApprovals()) {
      const ctx = this.context(approval);
      if (!ctx) {
        this.resolve(approval, "expired", "Expired, course or bundle removed");
        continue;
      }
      if (ctx.course.term !== term) continue;
      if (!ctx.course.armed || ctx.course.state !== "watching") {
        this.resolve(approval, "expired", "Expired, course disarmed");
      } else if (hasClosedCrn(ctx.bundle.crns, seats)) {
        this.resolve(approval, "expired", "Expired, seat closed");
      }
    }

    // Closing a bundle re-enables prompts, dry runs, and announcements for it.
    for (const course of courses) {
      for (const bundle of course.bundles) {
        if (!hasClosedCrn(bundle.crns, seats)) continue;
        this.suppressed.delete(bundle.id);
        this.announced.delete(bundle.id);
        this.transientStreak.delete(bundle.id);
      }
    }

    // Display state: open vs watching.
    for (const course of courses) {
      if (!course.armed || course.state !== "watching") continue;
      for (const bundle of course.bundles) {
        if (bundle.state !== "watching" && bundle.state !== "open") continue;
        const next = isFullyOpen(bundle.crns, seats) ? "open" : "watching";
        if (next !== bundle.state) {
          store.setBundleState(bundle.id, next);
          bundle.state = next;
          changed = true;
        }
      }
    }

    const halted = this.haltReason();
    const held = this.ticketHeld(settings);
    const now = this.deps.clock.now();

    for (const course of courses) {
      if (this.stopped) break;
      if (!course.armed || course.state !== "watching") continue;
      if (course.bundles.some(bundle => store.pendingApprovalForBundle(bundle.id))) continue;
      const blockers = course.planId !== null ? this.planBlockers(course) : null;
      const candidates = openBundles(course, seats, ["watching", "open"]).filter(
        bundle =>
          !this.suppressed.has(bundle.id) &&
          (this.cooldownUntil.get(bundle.id) ?? 0) <= now &&
          !(blockers && this.conflictsWithBlockers(course, bundle, blockers)),
      );
      if (!candidates.length) continue;

      if (halted || held) {
        const first = candidates[0]!;
        if (!this.announced.has(first.id)) {
          this.announced.add(first.id);
          this.deps.events.emit({
            kind: "bundle_opened",
            severity: "warning",
            title: `${this.label(course, first.crns)} is open`,
            detail: halted ? `Not registering: ${halted}` : `Waiting for your registration time (${settings.ticketAt}).`,
            courseId: course.id,
            bundleId: first.id,
            crns: first.crns,
          });
        }
        continue;
      }

      if (settings.approvalMode === "approve") {
        this.createApproval(course, candidates[0]!, settings);
        changed = true;
        continue;
      }

      for (const bundle of candidates) {
        const outcome = await this.attempt(course, bundle, `auto (${reason})`);
        changed = true;
        if (outcome.result === "halt") {
          this.finish(changed);
          return;
        }
        if (outcome.result !== "next") break;
        if (this.haltReason()) break;
      }
    }
    this.finish(changed);
  }

  /**
   * CRNs a plan-targeted course must fit around: the registered bundles of other same-term courses
   * and the latest known schedule. Read fresh so a registration earlier in this pass counts.
   */
  private planBlockers(course: WantedCourse): string[] {
    const { store } = this.deps;
    const crns = new Set<string>(store.latestSchedule(course.term)?.crns ?? []);
    for (const other of store.listWanted(course.term)) {
      if (other.id === course.id || other.state !== "registered") continue;
      for (const bundle of other.bundles) if (bundle.state === "registered") bundle.crns.forEach(crn => crns.add(crn));
    }
    if (course.swapDropCrn && this.deps.settings().swapsUnlocked) crns.delete(course.swapDropCrn);
    return [...crns];
  }

  /** Filter only: a plan bundle that would clash with something already on the schedule is skipped. */
  private conflictsWithBlockers(course: WantedCourse, bundle: Bundle, blockers: string[]): boolean {
    const others = blockers.filter(crn => !bundle.crns.includes(crn));
    if (!others.length) return false;
    const known = sectionsByCrn(this.deps.store, course.term, [...bundle.crns, ...others]);
    const pick = (crns: string[]) => crns.map(crn => known.get(crn)).filter((section): section is NonNullable<typeof section> => Boolean(section));
    return planConflicts(pick(bundle.crns), pick(others)).length > 0;
  }

  private finish(changed: boolean): void {
    if (changed) {
      this.publishWanted();
      this.publishApprovals();
    }
    this.scheduleCooldownTimer();
  }

  private createApproval(course: WantedCourse, bundle: Bundle, settings: Settings): void {
    const { store, events, clock } = this.deps;
    const now = clock.now();
    const label = this.label(course, bundle.crns);
    const approval = store.createApproval({
      bundleId: bundle.id,
      courseId: course.id,
      crns: bundle.crns,
      label,
      createdAt: now,
      remindAt: now + REMIND_AFTER_MS,
      autoAt: settings.approvalAutoAfterMin !== null && settings.approvalAutoAfterMin !== undefined
        ? now + Math.max(0, settings.approvalAutoAfterMin) * 60_000
        : null,
    });
    store.setBundleState(bundle.id, "pending_approval");
    events.emit({
      kind: "bundle_opened",
      severity: "info",
      title: `${label} is open`,
      courseId: course.id,
      bundleId: bundle.id,
      crns: bundle.crns,
    });
    events.emit({
      kind: "approval_needed",
      severity: "warning",
      title: `Register for ${label}?`,
      detail: approval.autoAt ? `Registers automatically in ${settings.approvalAutoAfterMin} min unless skipped.` : null,
      courseId: course.id,
      bundleId: bundle.id,
      crns: bundle.crns,
      payload: { approvalId: approval.id },
    });
    this.hook("approvalCreated", approval);
    this.scheduleApprovalTimer();
  }

  private resolve(approval: Approval, state: "expired" | "skipped", text: string): void {
    const { store, events } = this.deps;
    if (!store.resolveApproval(approval.id, state)) return;
    const bundle = store.getBundle(approval.bundleId);
    if (bundle && bundle.state === "pending_approval") store.setBundleState(bundle.id, "watching");
    const resolved = store.getApproval(approval.id) ?? { ...approval, state };
    events.emit({
      kind: "approval_resolved",
      severity: "info",
      title: `${approval.label}: ${text}`,
      courseId: approval.courseId,
      bundleId: approval.bundleId,
      crns: approval.crns,
      payload: { approvalId: approval.id, state },
    });
    this.deps.notifier?.approvalResolved?.(resolved, text);
    this.publishApprovals();
    this.publishWanted();
  }

  private hook(name: "approvalCreated" | "approvalReminder", approval: Approval): void {
    try {
      this.deps.notifier?.[name]?.(approval);
    } catch (error) {
      console.error(`notifier ${name} failed`, error);
    }
  }

  private async attempt(
    course: WantedCourse,
    bundle: Bundle,
    via: string,
  ): Promise<{ result: AttemptOutcome; message: string | null; outcome: RegisterResult["outcome"] | "error" }> {
    const { store, events, clock } = this.deps;
    const settings = this.deps.settings();
    const label = this.label(course, bundle.crns);
    const halted = this.haltReason();
    if (halted) return { result: "halt", message: halted, outcome: "aborted" };

    const registrar = this.deps.registrar();
    const request: RegisterRequest = {
      term: course.term,
      bundleId: bundle.id,
      addCrns: [...bundle.crns],
      dropCrn: settings.swapsUnlocked ? course.swapDropCrn : null,
    };
    store.setBundleState(bundle.id, "registering");
    this.publishWanted();

    const started = clock.now();
    let result: RegisterResult;
    try {
      result = await registrar.register(request);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      result = { outcome: "failed", rows: [], classification: "unknown", message, ms: clock.now() - started };
    }
    const messages = [...result.rows.map(row => row.message ?? ""), result.message ?? ""].filter(text => text.trim());
    const classification: FailureClass | null =
      result.outcome === "failed" ? result.classification ?? classifyMessages(messages) : null;
    store.addAttempt({
      bundleId: bundle.id,
      mode: registrar.kind,
      request,
      response: result,
      outcome: result.outcome,
      classification,
      ms: result.ms,
    });

    if ((result.outcome === "success" || result.outcome === "failed") && this.deps.postSubmitCheck) {
      let check: { ok: boolean; detail: string };
      try {
        check = await this.deps.postSubmitCheck(request, result);
      } catch (error) {
        check = { ok: false, detail: `Post-submit check failed: ${String((error as Error)?.message ?? error)}` };
      }
      if (!check.ok) {
        // Never move on to another bundle after a failed verification.
        if (result.outcome === "success") this.markRegistered(course, bundle, label, result, request);
        else store.setBundleState(bundle.id, "blocked", `Schedule check failed: ${check.detail}`);
        this.tripGuard(check.detail);
        return { result: "halt", message: check.detail, outcome: result.outcome };
      }
    }

    const reasonText = result.message ?? (messages.length ? [...new Set(messages)].join("; ") : null);
    switch (result.outcome) {
      case "success":
        this.markRegistered(course, bundle, label, result, request);
        return { result: "registered", message: null, outcome: "success" };
      case "dry_run":
        store.setBundleState(bundle.id, "watching");
        this.suppressed.add(bundle.id);
        events.emit({
          kind: "attempt",
          severity: "info",
          title: `Test mode: would register ${label}`,
          detail: `${via}. CRNs ${request.addCrns.join(", ")}${request.dropCrn ? `, dropping ${request.dropCrn}` : ""}. ${reasonText ?? ""}`.trim(),
          courseId: course.id,
          bundleId: bundle.id,
          crns: bundle.crns,
          payload: { result },
        });
        return { result: "stop_course", message: reasonText, outcome: "dry_run" };
      case "aborted":
        store.setBundleState(bundle.id, "watching");
        this.tripGuard(reasonText ?? `Registration for ${label} was refused by the safety guard.`);
        return { result: "halt", message: reasonText, outcome: "aborted" };
      case "failed":
      default: {
        const message = reasonText ?? "Banner rejected the registration without a message.";
        // A failed result where any row went through means the schedule may have changed. Same for
        // anything unclassified (timeouts after submit, unknown Banner text): stop everything.
        const partial = result.rows.some(row => row.ok);
        if (classification === "unknown" || classification === null || partial) {
          const detail = `Unclear result for ${label}: ${message}${
            partial ? ` (accepted: ${result.rows.filter(row => row.ok).map(row => row.crn).join(", ")})` : ""
          }. Check your schedule in Banner, then clear the guard.`;
          store.setBundleState(bundle.id, "blocked", `Unclear result: ${message}`);
          events.emit({
            kind: "registration_failed",
            severity: "critical",
            title: `${label}: unclear registration result`,
            detail: `${via}. ${message}`,
            courseId: course.id,
            bundleId: bundle.id,
            crns: bundle.crns,
            payload: { result, classification, partial },
          });
          this.tripGuard(detail);
          return { result: "halt", message: detail, outcome: "failed" };
        }
        if (classification === "transient") {
          store.setBundleState(bundle.id, "watching");
          const streak = (this.transientStreak.get(bundle.id) ?? 0) + 1;
          this.transientStreak.set(bundle.id, streak);
          if (!this.deps.firing?.()) this.cooldownUntil.set(bundle.id, clock.now() + TRANSIENT_COOLDOWN_MS);
          events.emit({
            kind: streak >= 2 ? "registration_failed" : "attempt",
            severity: streak >= 2 ? "warning" : "info",
            title: `${label} not added: ${message}`,
            detail: `${via}. Still watching${streak >= 2 ? ` (failed ${streak} times in a row)` : ""}.`,
            courseId: course.id,
            bundleId: bundle.id,
            crns: bundle.crns,
            payload: { result, classification },
          });
        } else {
          store.setBundleState(bundle.id, "blocked", message);
          events.emit({
            kind: "registration_failed",
            severity: "critical",
            title: `${label} blocked: ${message}`,
            detail: `${via}. This bundle needs your attention before it is tried again.`,
            courseId: course.id,
            bundleId: bundle.id,
            crns: bundle.crns,
            payload: { result, classification },
          });
          const fresh = store.getWanted(course.id);
          if (fresh && fresh.bundles.length && fresh.bundles.every(entry => entry.state === "blocked")) {
            store.setCourseState(course.id, "blocked");
          }
        }
        return { result: "next", message, outcome: "failed" };
      }
    }
  }

  private markRegistered(course: WantedCourse, bundle: Bundle, label: string, result: RegisterResult, request: RegisterRequest): void {
    const { store, events } = this.deps;
    store.setBundleState(bundle.id, "registered");
    store.setCourseState(course.id, "registered");
    store.updateWanted(course.id, { armed: false });
    this.cooldownUntil.delete(bundle.id);
    this.transientStreak.delete(bundle.id);
    // Any other approvals for this course are moot now.
    for (const approval of store.pendingApprovals()) {
      if (approval.courseId === course.id) this.resolve(approval, "expired", "Expired, course registered");
    }
    events.emit({
      kind: "registered",
      severity: "success",
      title: `Registered for ${label}`,
      detail: `${request.dropCrn ? `Dropped ${request.dropCrn}. ` : ""}Took ${result.ms} ms.`,
      courseId: course.id,
      bundleId: bundle.id,
      crns: bundle.crns,
      payload: { result },
    });
  }

  private attemptText(course: WantedCourse, outcome: { result: AttemptOutcome; message: string | null; outcome: string }): string {
    switch (outcome.result) {
      case "registered":
        return `Registered for ${course.subject} ${course.number}`;
      case "stop_course":
        return outcome.outcome === "dry_run" ? "Test mode, nothing was submitted" : outcome.message ?? "Done";
      case "halt":
        return `Stopped: ${outcome.message ?? "registration halted"}`;
      default:
        return `Failed: ${outcome.message ?? "unknown error"}`;
    }
  }

  private scheduleCooldownTimer(): void {
    this.cooldownTimer?.cancel();
    this.cooldownTimer = null;
    const now = this.deps.clock.now();
    let next = Infinity;
    for (const [bundleId, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(bundleId);
      else next = Math.min(next, until);
    }
    if (next === Infinity || this.stopped) return;
    this.cooldownTimer = this.deps.clock.setTimeout(() => {
      this.cooldownTimer = null;
      this.evaluate("cooldown");
    }, next - now + 1);
  }

  private scheduleApprovalTimer(): void {
    this.approvalTimer?.cancel();
    this.approvalTimer = null;
    if (this.stopped) return;
    // While halted, auto approvals cannot run, so they set no timer (a due one would refire at once).
    // Every evaluate reschedules, which covers resume.
    const halted = this.haltReason() !== null;
    let next = Infinity;
    for (const approval of this.deps.store.pendingApprovals()) {
      if (approval.remindAt !== null) next = Math.min(next, approval.remindAt);
      if (approval.autoAt !== null && !halted) next = Math.min(next, approval.autoAt);
    }
    if (next === Infinity) return;
    this.approvalTimer = this.deps.clock.setTimeout(() => {
      this.approvalTimer = null;
      void this.withLock(() => this.processDueApprovals());
    }, Math.max(0, next - this.deps.clock.now()));
  }

  private async processDueApprovals(): Promise<void> {
    const { store, clock } = this.deps;
    const now = clock.now();
    for (const approval of store.pendingApprovals()) {
      if (approval.autoAt !== null && approval.autoAt <= now) {
        if (this.haltReason()) continue;
        const ctx = this.context(approval);
        if (!ctx) {
          this.resolve(approval, "expired", "Expired, course or bundle removed");
          continue;
        }
        if (!isFullyOpen(ctx.bundle.crns, this.seatLookup(ctx.course.term))) {
          this.resolve(approval, "expired", "Expired, seat closed");
          continue;
        }
        if (!store.resolveApproval(approval.id, "auto")) continue;
        this.publishApprovals();
        const outcome = await this.attempt(ctx.course, ctx.bundle, "auto after approval timeout");
        this.deps.notifier?.approvalResolved?.({ ...approval, state: "auto", resolvedAt: clock.now() }, this.attemptText(ctx.course, outcome));
        this.publishWanted();
        if (outcome.result !== "registered") this.evaluate("after auto approval");
        continue;
      }
      if (approval.remindAt !== null && approval.remindAt <= now) {
        store.clearApprovalReminder(approval.id);
        this.hook("approvalReminder", { ...approval, remindAt: null });
      }
    }
    this.scheduleApprovalTimer();
  }

  private publishWanted(): void {
    const term = this.deps.settings().activeTerm;
    this.deps.bus.publish({ type: "wanted", wanted: this.deps.store.listWanted(term ?? undefined) });
  }

  private publishApprovals(): void {
    this.deps.bus.publish({ type: "approvals", approvals: this.deps.store.pendingApprovals() });
  }
}
