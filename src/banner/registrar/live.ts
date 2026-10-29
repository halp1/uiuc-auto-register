// Live registration. Every gate is re-checked on every call:
//   config.mode === "live", settings.liveEnabled, settings.liveTerm === request.term.
// Flow: snapshot schedule -> authorize interceptor for this exact batch -> addCRNRegistrationItems ->
// preSubmitCheck -> submitRegistration/batch -> de-authorize -> re-read schedule -> postSubmitDiff.

import { classifyMessages } from "../classify";
import type { Registrar } from "../../core/contracts";
import type { Clock } from "../../core/clock";
import type { Config } from "../../core/config";
import type { Store } from "../../core/db";
import type { RegisterRequest, RegisterResult, RegisterRowResult, Settings } from "../../core/types";
import { chooseAction, postSubmitDiff, preSubmitCheck, type RegistrationModel } from "../guard";
import { BannerSessionError, type BannerReadApi, type BannerWriteApi } from "./types";

export class LiveNotAllowed extends Error {
  constructor(readonly reason: "not_live_mode" | "live_disabled" | "term_mismatch") {
    super(`Live registration refused: ${reason}`);
    this.name = "LiveNotAllowed";
  }
}

export function liveGate(config: Pick<Config, "mode">, settings: Pick<Settings, "liveEnabled" | "liveTerm">, term: string | null): LiveNotAllowed | null {
  if (config.mode !== "live") return new LiveNotAllowed("not_live_mode");
  if (!settings.liveEnabled) return new LiveNotAllowed("live_disabled");
  if (!settings.liveTerm || (term !== null && settings.liveTerm !== term)) return new LiveNotAllowed("term_mismatch");
  return null;
}

export interface LiveRegistrarDeps {
  config: Config;
  settings: () => Settings;
  store: Store;
  clock: Clock;
  api: BannerWriteApi;
}

export class LiveRegistrar implements Registrar {
  readonly kind = "live" as const;
  private busy = false;

  /** `term` is the term this registrar will be used for; pass null to only check mode and switch. */
  constructor(
    private readonly deps: LiveRegistrarDeps,
    term: string | null = deps.settings().liveTerm,
  ) {
    const refused = liveGate(deps.config, deps.settings(), term);
    if (refused) throw refused;
  }

  async register(request: RegisterRequest, signal?: AbortSignal): Promise<RegisterResult> {
    const t0 = this.deps.clock.now();
    const done = (partial: Omit<RegisterResult, "ms">): RegisterResult => ({ ...partial, ms: this.deps.clock.now() - t0 });
    const refused = liveGate(this.deps.config, this.deps.settings(), request.term);
    if (refused) return done({ outcome: "aborted", rows: [], classification: "permanent", message: refused.message });
    const settings = this.deps.settings();
    if (request.dropCrn && !settings.swapsUnlocked) {
      return done({ outcome: "aborted", rows: [], classification: "permanent", message: "Swaps are locked" });
    }
    if (request.addCrns.length === 0 || new Set(request.addCrns).size !== request.addCrns.length) {
      return done({ outcome: "aborted", rows: [], classification: "permanent", message: "Invalid add CRN list" });
    }
    if (this.busy) return done({ outcome: "failed", rows: [], classification: "transient", message: "Another batch is in flight" });
    this.busy = true;
    const api = this.deps.api;
    let before: string[];
    let beforeStrategies: string[];
    try {
      if (signal?.aborted) throw new BannerSessionError("aborted");
      await api.ensureWarm(request.term);
      const read = await api.readScheduleDetailed(request.term);
      before = read.crns;
      beforeStrategies = read.strategies;
      this.deps.store.addScheduleSnapshot(request.term, before, "live_before");
    } catch (error) {
      this.busy = false;
      const reason = error instanceof BannerSessionError ? error.reason : "unexpected_error";
      return done({ outcome: "failed", rows: [], classification: "transient", message: `Could not prepare: ${reason}` });
    }
    // A CRN that was registered at the last trusted read and vanished without us submitting means the
    // reader is unreliable (or the schedule changed outside the app). Stop before any write.
    const last = lastTrustedSnapshot(this.deps.store, request.term);
    const vanished = last ? last.filter(crn => !before.includes(crn)) : [];
    if (vanished.length) {
      this.busy = false;
      return done({
        outcome: "aborted",
        rows: [],
        classification: "unknown",
        message: `Schedule guard: CRNs ${vanished.join(", ")} from the last schedule read are missing now; nothing was submitted. Run a test in Settings to refresh.`,
      });
    }
    if (request.dropCrn && !before.includes(request.dropCrn)) {
      this.busy = false;
      return done({ outcome: "aborted", rows: [], classification: "permanent", message: `Swap drop CRN ${request.dropCrn} is not on the schedule` });
    }

    let result: Omit<RegisterResult, "ms">;
    let submitted = false;
    try {
      result = await api.withAuthorizedBatch({ term: request.term, addCrns: request.addCrns, dropCrn: request.dropCrn }, async () => {
        const rows = await api.addCrnItems(request.term, request.addCrns);
        const unexpected = rows.filter(row => !request.addCrns.includes(row.crn));
        if (unexpected.length) {
          return { outcome: "aborted" as const, rows: [], classification: "permanent" as const, message: `Banner returned unrequested CRNs ${unexpected.map(r => r.crn || "?").join(", ")}` };
        }
        const failed = rows.filter(row => !row.success);
        if (failed.length || rows.length === 0) {
          const messages = failed.map(row => row.message ?? "Add failed");
          return {
            outcome: "failed" as const,
            rows: request.addCrns.map(crn => {
              const row = rows.find(r => r.crn === crn);
              return { crn, ok: Boolean(row?.success), message: row?.message ?? (row ? null : "Not returned by Banner") };
            }),
            classification: classifyMessages(messages.length ? messages : ["Add failed"]),
            message: messages.join("; ") || "Banner did not return the CRNs",
          };
        }
        const models: RegistrationModel[] = [];
        for (const crn of request.addCrns) {
          const model = rows.find(r => r.crn === crn)?.model;
          const code = model ? chooseAction(model, "add") : null;
          if (!model || !code) return { outcome: "aborted" as const, rows: [], classification: "permanent" as const, message: `No unambiguous add action for ${crn}` };
          models.push({ ...model, selectedAction: code });
        }
        if (request.dropCrn) {
          const working = await api.workingSet(request.term);
          const model = working.find(m => m.courseReferenceNumber === request.dropCrn);
          const code = model ? chooseAction(model, "drop") : null;
          if (!model || !code) return { outcome: "aborted" as const, rows: [], classification: "permanent" as const, message: `No unambiguous drop action for ${request.dropCrn}` };
          models.push({ ...model, selectedAction: code });
        }
        const pre = preSubmitCheck(models, request, { swapsUnlocked: this.deps.settings().swapsUnlocked });
        if (!pre.ok) return { outcome: "aborted" as const, rows: [], classification: "permanent" as const, message: `Pre-submit guard: ${pre.reason}` };
        // Gates once more right before the only irreversible call.
        const late = liveGate(this.deps.config, this.deps.settings(), request.term);
        if (late) return { outcome: "aborted" as const, rows: [], classification: "permanent" as const, message: late.message };
        submitted = true;
        const submitRows = await api.submitBatch(models);
        const addRows: RegisterRowResult[] = request.addCrns.map(crn => {
          const row = submitRows.find(r => r.crn === crn);
          return { crn, ok: Boolean(row?.ok), message: row?.message ?? (row ? null : "Not returned by Banner") };
        });
        const allOk = addRows.every(row => row.ok);
        const messages = addRows.filter(row => !row.ok).map(row => row.message ?? "Registration failed");
        return {
          outcome: allOk ? ("success" as const) : ("failed" as const),
          rows: addRows,
          // Any accepted row in a failed batch means Banner changed something: never "transient".
          classification: allOk ? null : addRows.some(row => row.ok) ? "unknown" : classifyMessages(messages),
          message: allOk ? `Registered ${request.addCrns.join(", ")}` : messages.join("; "),
        };
      });
    } catch (error) {
      const reason = error instanceof BannerSessionError ? error.reason : "unexpected_error";
      result = { outcome: "failed", rows: [], classification: submitted ? "unknown" : "transient", message: `Registration request failed: ${reason}` };
    }

    // Verify the schedule whenever anything may have reached Banner.
    try {
      const read = await api.readScheduleDetailed(request.term);
      const after = read.crns;
      this.deps.store.addScheduleSnapshot(request.term, after, "live_after");
      // Before and after must come from the same readers, or the diff compares different things.
      if (!beforeStrategies.every(strategy => read.strategies.includes(strategy as never))) {
        return done({ outcome: "aborted", rows: result.rows, classification: "unknown", message: "Schedule guard: could not verify the schedule" });
      }
      const diff = postSubmitDiff(before, after, request);
      if (!diff.ok) {
        return done({ outcome: "aborted", rows: result.rows, classification: "permanent", message: `Schedule guard: lost CRNs ${diff.lost.join(", ")}` });
      }
      const added = request.addCrns.filter(crn => after.includes(crn) && !before.includes(crn));
      const missingAdds = request.addCrns.filter(crn => !after.includes(crn));
      if (added.length > 0 && missingAdds.length > 0) {
        return done({
          outcome: "aborted",
          rows: result.rows,
          classification: "unknown",
          message: `Schedule guard: only part of the bundle was added (added ${added.join(", ")}; missing ${missingAdds.join(", ")})`,
        });
      }
      if (result.outcome === "success") {
        const missing = request.addCrns.filter(crn => !after.includes(crn));
        if (missing.length) {
          return done({ ...result, outcome: "failed", classification: "unknown", message: `Banner reported success but ${missing.join(", ")} is not on the schedule` });
        }
      }
    } catch (error) {
      if (submitted || result.outcome === "success") {
        return done({ outcome: "aborted", rows: result.rows, classification: "unknown", message: "Schedule guard: could not re-read the schedule after submitting" });
      }
    } finally {
      this.busy = false;
    }
    return done(result);
  }
}

/** CRNs from the most recent trusted read (a rehearsal or a post-submit read) for the term. */
export function lastTrustedSnapshot(store: Store, term: string): string[] | null {
  const row = store.db
    .query("SELECT crns FROM schedule_snapshots WHERE term = ? AND source IN ('rehearsal', 'live_after') ORDER BY id DESC LIMIT 1")
    .get(term) as { crns: string } | null;
  return row ? (JSON.parse(row.crns) as string[]) : null;
}

/**
 * Orchestrator hook: re-reads the schedule and compares with the latest "live_before" snapshot.
 * LiveRegistrar already returns "aborted" on lost CRNs; this is a second, independent check.
 */
export function makePostSubmitCheck(deps: { api: BannerReadApi; store: Store }) {
  return async (request: RegisterRequest, result: RegisterResult): Promise<{ ok: boolean; detail: string }> => {
    const before = deps.store.db
      .query("SELECT crns FROM schedule_snapshots WHERE term = ? AND source = 'live_before' ORDER BY id DESC LIMIT 1")
      .get(request.term) as { crns: string } | null;
    if (!before) return { ok: true, detail: "No live snapshot to compare" };
    let after: string[];
    try {
      after = await deps.api.readSchedule(request.term);
    } catch {
      return { ok: false, detail: "Could not re-read the schedule after registering" };
    }
    const diff = postSubmitDiff(JSON.parse(before.crns), after, request);
    if (!diff.ok) return { ok: false, detail: `Schedule guard: lost CRNs ${diff.lost.join(", ")}` };
    if (result.outcome === "success") {
      const missing = request.addCrns.filter(crn => !after.includes(crn));
      if (missing.length) return { ok: false, detail: `Reported success but ${missing.join(", ")} is not on the schedule` };
    }
    return { ok: true, detail: "Schedule intact" };
  };
}

export { makePostSubmitCheck as postSubmitCheck };
