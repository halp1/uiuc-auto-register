import { describe, expect, test } from "bun:test";
import { FakeClock } from "../../src/core/clock";
import { makeConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import { runSwapTest, swapTestGate, SwapTestRefused, type SwapTestRequest } from "../../src/engine/swaptest";
import type { BannerWriteApi } from "../../src/banner/registrar/types";

const cfg = (mode: Config["mode"]): Config => makeConfig(mode, { chromePath: null });
const swap = (term: string, crnA = "11111", crnB = "22222"): SwapTestRequest => ({ term, crnA, crnB });

function trapApi(): { api: BannerWriteApi; calls: string[] } {
  const calls: string[] = [];
  const trap = (name: string) => async () => {
    calls.push(name);
    throw new Error("must not be called");
  };
  return {
    calls,
    api: {
      ensureWarm: trap("ensureWarm"),
      readSchedule: trap("readSchedule"),
      readScheduleDetailed: trap("readScheduleDetailed"),
      eligibility: trap("eligibility"),
      lookupCrn: trap("lookupCrn"),
      blockedWrites: () => 0,
      withAuthorizedBatch: trap("withAuthorizedBatch") as BannerWriteApi["withAuthorizedBatch"],
      addCrnItems: trap("addCrnItems"),
      workingSet: trap("workingSet"),
      submitBatch: trap("submitBatch"),
    },
  };
}

describe("swapTestGate", () => {
  test.each<[string, Config["mode"], string, SwapTestRequest, SwapTestRefused["reason"] | null]>([
    ["fall term in live mode", "live", "120268", swap("120268"), "not_throwaway_term"],
    ["spring term in live mode", "live", "120271", swap("120271"), "not_throwaway_term"],
    ["simulated mode", "simulated", "120270", swap("120270"), "not_live_mode"],
    ["rehearsal mode", "rehearsal", "120270", swap("120270"), "not_live_mode"],
    ["Live enabled for another term", "live", "120271", swap("120270"), "live_not_enabled_for_term"],
    ["the same CRN twice", "live", "120270", swap("120270", "11111", "11111"), "invalid_request"],
    ["a throwaway term with Live enabled for it", "live", "120270", swap("120270"), null],
    ["another throwaway term with Live enabled for it", "live", "120265", swap("120265"), null],
  ])("%s", (_name, mode, liveTerm, req, reason) => {
    expect(swapTestGate(cfg(mode), { liveEnabled: true, liveTerm }, req)?.reason ?? null).toBe(reason);
  });
});

describe("runSwapTest", () => {
  test.each<[Config["mode"], string]>([
    ["live", "120271"],
    ["live", "120268"],
    ["rehearsal", "120270"],
    ["simulated", "120270"],
  ])("throws before touching Banner when refused (%s, %s)", async (mode, term) => {
    const store = new Store(":memory:");
    store.updateSettings({ liveEnabled: true, liveTerm: term });
    const { api, calls } = trapApi();
    await expect(runSwapTest({ config: cfg(mode), settings: () => store.getSettings(), store, clock: new FakeClock(), api }, swap(term))).rejects.toBeInstanceOf(SwapTestRefused);
    expect(calls).toEqual([]);
  });
});
