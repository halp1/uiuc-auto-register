import { describe, expect, test } from "bun:test";
import { FakeClock } from "../../src/core/clock";
import { makeConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import { runSwapTest, swapTestGate, SwapTestRefused } from "../../src/engine/swaptest";
import type { BannerWriteApi } from "../../src/banner/registrar/types";

const cfg = (mode: Config["mode"]): Config => (makeConfig(mode, { chromePath: null }));

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
      withAuthorizedBatch: trap("withAuthorizedBatch") as any,
      addCrnItems: trap("addCrnItems"),
      workingSet: trap("workingSet"),
      submitBatch: trap("submitBatch"),
    },
  };
}

describe("swap test gating", () => {
  const live = { liveEnabled: true, liveTerm: "120270" };

  test("refuses fall and spring terms even in live mode", () => {
    for (const term of ["120268", "120271"]) {
      expect(swapTestGate(cfg("live"), { liveEnabled: true, liveTerm: term }, { term, crnA: "11111", crnB: "22222" })?.reason).toBe("not_throwaway_term");
    }
  });

  test("refuses simulated and rehearsal modes", () => {
    for (const mode of ["simulated", "rehearsal"] as const) {
      expect(swapTestGate(cfg(mode), live, { term: "120270", crnA: "11111", crnB: "22222" })?.reason).toBe("not_live_mode");
    }
  });

  test("refuses when Live is not enabled for that term, or the request is malformed", () => {
    expect(swapTestGate(cfg("live"), { liveEnabled: true, liveTerm: "120271" }, { term: "120270", crnA: "11111", crnB: "22222" })?.reason).toBe("live_not_enabled_for_term");
    expect(swapTestGate(cfg("live"), live, { term: "120270", crnA: "11111", crnB: "11111" })?.reason).toBe("invalid_request");
    expect(swapTestGate(cfg("live"), live, { term: "120270", crnA: "11111", crnB: "22222" })).toBeNull();
    expect(swapTestGate(cfg("live"), { liveEnabled: true, liveTerm: "120265" }, { term: "120265", crnA: "11111", crnB: "22222" })).toBeNull();
  });

  test("runSwapTest throws before touching Banner when refused", async () => {
    for (const [mode, term] of [["live", "120271"], ["live", "120268"], ["rehearsal", "120270"], ["simulated", "120270"]] as const) {
      const store = new Store(":memory:");
      store.updateSettings({ liveEnabled: true, liveTerm: term });
      const { api, calls } = trapApi();
      await expect(runSwapTest({ config: cfg(mode), settings: () => store.getSettings(), store, clock: new FakeClock(), api }, { term, crnA: "11111", crnB: "22222" })).rejects.toBeInstanceOf(SwapTestRefused);
      expect(calls).toEqual([]);
    }
  });
});
