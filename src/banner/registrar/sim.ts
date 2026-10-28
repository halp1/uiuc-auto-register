// Simulated registrar: applies a registration batch to SimBanner. Never touches real Banner.

import type { Registrar } from "../../core/contracts";
import type { RegisterRequest, RegisterResult, RegisterRowResult } from "../../core/types";
import { classifyMessages } from "../classify";
import type { SimBanner } from "../sim/state";

export const SIM_MESSAGES = {
  closed: "Closed Section",
  timeConflict: (crn: string) => `Time conflict with CRN ${crn}`,
  prereq: "Prerequisite and Test Score error",
  notOpen: "Registration is not open at this time",
  duplicate: "Duplicate Course Reference Number",
} as const;

export class SimRegistrar implements Registrar {
  readonly kind = "simulated" as const;

  constructor(
    private sim: SimBanner,
    private options: { latencyMs?: number; now?: () => number } = {},
  ) {}

  async register(request: RegisterRequest, signal?: AbortSignal): Promise<RegisterResult> {
    const now = this.options.now ?? Date.now;
    const started = now();
    if (this.options.latencyMs) await Bun.sleep(this.options.latencyMs);
    if (signal?.aborted) {
      return { outcome: "aborted", rows: [], classification: null, message: "Cancelled before submit", ms: now() - started };
    }
    const { term, addCrns } = request;
    const schedule = new Set(this.sim.schedule(term));
    const rows: RegisterRowResult[] = addCrns.map(crn => ({ crn, ok: false, message: null }));

    const scripted = this.sim.takeScripted(addCrns);
    if (scripted) {
      const target = scripted.crn ?? addCrns[0]!;
      for (const row of rows) if (row.crn === target || scripted.crn === null) row.message = scripted.message;
    } else {
      for (const row of rows) {
        if (schedule.has(row.crn)) row.message = SIM_MESSAGES.duplicate;
        else if ((this.sim.peek(term, row.crn)?.available ?? 0) <= 0) row.message = SIM_MESSAGES.closed;
      }
    }

    const messages = rows.map(row => row.message ?? "").filter(Boolean);
    if (messages.length) {
      // Atomic: nothing from the batch is added when any row fails.
      return {
        outcome: "failed",
        rows,
        classification: classifyMessages(messages),
        message: [...new Set(messages)].join("; "),
        ms: now() - started,
      };
    }

    for (const row of rows) {
      this.sim.take(term, row.crn);
      row.ok = true;
    }
    this.sim.addToSchedule(term, addCrns);
    if (request.dropCrn && this.sim.removeFromSchedule(term, request.dropCrn)) {
      this.sim.release(term, request.dropCrn);
      rows.push({ crn: request.dropCrn, ok: true, message: "Dropped" });
    }
    this.sim.commit();
    return { outcome: "success", rows, classification: null, message: null, ms: now() - started };
  }
}
