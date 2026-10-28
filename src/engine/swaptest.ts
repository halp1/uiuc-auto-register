// Swap proof on a throwaway (Winter or Summer) term, live mode only:
//   1. add CRN A
//   2. one batch: add B (closed) + drop A
//   3. pass iff A is still registered afterwards (Banner rejected the batch as a whole)
// Only after a pass may the student unlock swaps for real terms.

import type { Clock } from "../core/clock";
import type { Config } from "../core/config";
import type { Store } from "../core/db";
import { isTermCode, isThrowawayTerm } from "../core/terms";
import type { Settings } from "../core/types";
import { chooseAction, postSubmitDiff, preSubmitCheck, type RegistrationModel } from "../banner/guard";
import { BannerSessionError, type BannerWriteApi } from "../banner/registrar/types";

export interface SwapTestRequest {
  term: string;
  crnA: string; // an open section to add first
  crnB: string; // a closed section
}

export interface SwapTestReport {
  ok: boolean;
  passed: boolean;
  term: string;
  steps: { name: string; ok: boolean; detail: string | null }[];
  finalSchedule: string[] | null;
}

export class SwapTestRefused extends Error {
  constructor(readonly reason: "not_live_mode" | "not_throwaway_term" | "invalid_request" | "live_not_enabled_for_term") {
    super(`Swap test refused: ${reason}`);
    this.name = "SwapTestRefused";
  }
}

export function swapTestGate(config: Pick<Config, "mode">, settings: Pick<Settings, "liveEnabled" | "liveTerm">, req: SwapTestRequest): SwapTestRefused | null {
  if (config.mode !== "live") return new SwapTestRefused("not_live_mode");
  if (!isTermCode(req.term) || !/^\d{5}$/.test(req.crnA) || !/^\d{5}$/.test(req.crnB) || req.crnA === req.crnB) return new SwapTestRefused("invalid_request");
  if (!isThrowawayTerm(req.term)) return new SwapTestRefused("not_throwaway_term");
  if (!settings.liveEnabled || settings.liveTerm !== req.term) return new SwapTestRefused("live_not_enabled_for_term");
  return null;
}

export interface SwapTestDeps {
  config: Config;
  settings: () => Settings;
  store: Store;
  clock: Clock;
  api: BannerWriteApi;
}

export async function runSwapTest(deps: SwapTestDeps, req: SwapTestRequest): Promise<SwapTestReport> {
  const refused = swapTestGate(deps.config, deps.settings(), req);
  if (refused) throw refused;
  const { api, store } = deps;
  const report: SwapTestReport = { ok: false, passed: false, term: req.term, steps: [], finalSchedule: null };
  const step = (name: string, ok: boolean, detail: string | null = null) => report.steps.push({ name, ok, detail });
  const recheck = () => {
    const again = swapTestGate(deps.config, deps.settings(), req);
    if (again) throw again;
  };

  try {
    await api.ensureWarm(req.term);
    const before = await api.readSchedule(req.term);
    store.addScheduleSnapshot(req.term, before, "swaptest_before");
    if (before.includes(req.crnB)) throw new BannerSessionError("crn_b_already_registered");
    step("read_schedule", true, `${before.length} CRNs`);

    // 1. add A (unless it is already there)
    if (!before.includes(req.crnA)) {
      recheck();
      const addA = { term: req.term, bundleId: 0, addCrns: [req.crnA], dropCrn: null };
      await api.withAuthorizedBatch(addA, async () => {
        const rows = await api.addCrnItems(req.term, [req.crnA]);
        const row = rows.length === 1 ? rows[0] : undefined;
        const code = row?.success && row.model && row.crn === req.crnA ? chooseAction(row.model, "add") : null;
        if (!row?.model || !code) throw new BannerSessionError("add_a_not_staged");
        const models = [{ ...row.model, selectedAction: code }];
        const pre = preSubmitCheck(models, addA, { swapsUnlocked: false });
        if (!pre.ok) throw new BannerSessionError("add_a_guard");
        await api.submitBatch(models);
      });
    }
    const withA = await api.readSchedule(req.term);
    if (!withA.includes(req.crnA) || !postSubmitDiff(before, withA, { dropCrn: null }).ok) throw new BannerSessionError("add_a_failed");
    step("add_a", true, req.crnA);

    // 2. add B (closed) + drop A in one batch
    recheck();
    const swap = { term: req.term, bundleId: 0, addCrns: [req.crnB], dropCrn: req.crnA };
    let rowsDetail = "";
    await api.withAuthorizedBatch(swap, async () => {
      const rows = await api.addCrnItems(req.term, [req.crnB]);
      const row = rows.length === 1 && rows[0]!.crn === req.crnB ? rows[0]! : undefined;
      if (!row) throw new BannerSessionError("add_b_unexpected_rows");
      if (!row.success || !row.model) {
        // Banner refused to stage B at all: A was never at risk, but the batch path was not exercised.
        rowsDetail = `B not staged: ${row.message ?? "no model"}`;
        return;
      }
      const working: RegistrationModel[] = await api.workingSet(req.term);
      const modelA = working.find(m => m.courseReferenceNumber === req.crnA);
      const addCode = chooseAction(row.model, "add");
      const dropCode = modelA ? chooseAction(modelA, "drop") : null;
      if (!addCode || !modelA || !dropCode) throw new BannerSessionError("swap_actions_ambiguous");
      const models = [
        { ...row.model, selectedAction: addCode },
        { ...modelA, selectedAction: dropCode },
      ];
      const pre = preSubmitCheck(models, swap, { swapsUnlocked: true });
      if (!pre.ok) throw new BannerSessionError("swap_guard");
      const submitRows = await api.submitBatch(models);
      rowsDetail = submitRows.map(r => `${r.crn}:${r.ok ? "ok" : r.message ?? "error"}`).join(", ");
    });
    step("swap_batch", true, rowsDetail || null);

    // 3. verify
    const after = await api.readSchedule(req.term);
    store.addScheduleSnapshot(req.term, after, "swaptest_after");
    report.finalSchedule = after;
    const keptA = after.includes(req.crnA);
    const gotB = after.includes(req.crnB);
    report.passed = keptA && !gotB && !rowsDetail.startsWith("B not staged");
    step("verify", report.passed, keptA ? (gotB ? "B was added (it was not closed)" : "A kept") : "A was dropped");
    report.ok = true;
  } catch (error) {
    if (error instanceof SwapTestRefused) throw error;
    step("error", false, error instanceof BannerSessionError ? error.reason : "unexpected_error");
  }
  return report;
}
