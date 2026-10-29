// Rehearsal mode: the real login and schedule read, then a dry run. It holds only a read API,
// so it structurally cannot reach any write path.

import type { Registrar } from "../../core/contracts";
import type { Clock } from "../../core/clock";
import type { Store } from "../../core/db";
import type { RegisterRequest, RegisterResult } from "../../core/types";
import { BannerSessionError, type BannerReadApi } from "./types";

export interface RehearsalRegistrarDeps {
  api: BannerReadApi;
  clock: Clock;
  store?: Store;
}

export class RehearsalRegistrar implements Registrar {
  readonly kind = "rehearsal" as const;

  constructor(private readonly deps: RehearsalRegistrarDeps) {}

  async register(request: RegisterRequest, signal?: AbortSignal): Promise<RegisterResult> {
    const t0 = this.deps.clock.now();
    const done = (partial: Omit<RegisterResult, "ms">): RegisterResult => ({ ...partial, ms: this.deps.clock.now() - t0 });
    try {
      if (signal?.aborted) throw new BannerSessionError("aborted");
      await this.deps.api.ensureWarm(request.term);
      const schedule = await this.deps.api.readSchedule(request.term);
      this.deps.store?.addScheduleSnapshot(request.term, schedule, "rehearsal");
      const already = request.addCrns.filter(crn => schedule.includes(crn));
      if (already.length) {
        return done({ outcome: "aborted", rows: [], classification: "permanent", message: `Already registered for ${already.join(", ")}` });
      }
      if (request.dropCrn && !schedule.includes(request.dropCrn)) {
        return done({ outcome: "aborted", rows: [], classification: "permanent", message: `Swap drop CRN ${request.dropCrn} is not on the schedule` });
      }
      const drop = request.dropCrn ? ` and drop ${request.dropCrn}` : "";
      return done({
        outcome: "dry_run",
        rows: request.addCrns.map(crn => ({ crn, ok: true, message: "Dry run" })),
        classification: null,
        message: `Would register CRNs ${request.addCrns.join(", ")}${drop} (test mode, nothing submitted)`,
      });
    } catch (error) {
      const reason = error instanceof BannerSessionError ? error.reason : "unexpected_error";
      return done({ outcome: "failed", rows: [], classification: "transient", message: `Test could not run: ${reason}` });
    }
  }
}
