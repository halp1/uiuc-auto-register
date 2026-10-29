import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { makeConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { RegisterRequest, Settings } from "../../src/core/types";
import { BannerSessionManager } from "../../src/banner/session";
import { LiveNotAllowed, LiveRegistrar, makePostSubmitCheck } from "../../src/banner/registrar/live";
import { RehearsalRegistrar } from "../../src/banner/registrar/rehearsal";
import { BannerSessionError, type AddItemRow, type BannerReadApi, type BannerWriteApi, type ScheduleStrategy, type SubmitRow } from "../../src/banner/registrar/types";
import type { RegistrationModel } from "../../src/banner/guard";

const TERM = "120271";
const ACTIONS = [
  { courseRegistrationStatus: "RW", description: "**Web Registered**" },
  { courseRegistrationStatus: "DW", description: "Web Drop" },
];
const model = (crn: string): RegistrationModel => ({ courseReferenceNumber: crn, term: TERM, registrationActions: ACTIONS, selectedAction: null });
const request = (addCrns: string[], dropCrn: string | null = null): RegisterRequest => ({ term: TERM, bundleId: 1, addCrns, dropCrn });

function cfg(mode: Config["mode"]): Config {
  return makeConfig(mode, { chromePath: null });
}

function env(mode: Config["mode"] = "live", patch: Partial<Settings> = { liveEnabled: true, liveTerm: TERM }) {
  const store = new Store(":memory:");
  store.updateSettings(patch);
  return { store, config: cfg(mode), clock: new FakeClock(), settings: () => store.getSettings() };
}

/** A fake Banner with a schedule; records every call. */
function fakeApi(opts: { schedule?: string[]; strategies?: () => ScheduleStrategy[]; afterSubmit?: (schedule: string[], models: RegistrationModel[]) => string[]; addRows?: (crns: string[]) => AddItemRow[]; submitRows?: (models: RegistrationModel[]) => SubmitRow[] } = {}) {
  let schedule = [...(opts.schedule ?? ["11111", "22222"])];
  const calls: string[] = [];
  let authorized: unknown = null;
  const submitted: RegistrationModel[][] = [];
  const api: BannerWriteApi = {
    ensureWarm: async () => void calls.push("ensureWarm"),
    readSchedule: async () => (calls.push("readSchedule"), [...schedule]),
    readScheduleDetailed: async () => (calls.push("readSchedule"), { crns: [...schedule], strategies: opts.strategies?.() ?? ["summary"] }),
    eligibility: async () => ({ allowed: true, messages: [] }),
    lookupCrn: async (_t, crn) => ({ crn, exists: true, title: null }),
    blockedWrites: () => 0,
    withAuthorizedBatch: async (batch, fn) => {
      calls.push("authorize");
      authorized = batch;
      try {
        return await fn();
      } finally {
        authorized = null;
        calls.push("deauthorize");
      }
    },
    addCrnItems: async (_t, crns) => {
      calls.push(`add:${crns.join(",")}`);
      if (!authorized) throw new Error("not authorized");
      return opts.addRows ? opts.addRows(crns) : crns.map(crn => ({ crn, success: true, message: null, model: model(crn) }));
    },
    workingSet: async () => schedule.map(model),
    submitBatch: async models => {
      calls.push("submit");
      if (!authorized) throw new Error("not authorized");
      submitted.push(models);
      schedule = opts.afterSubmit ? opts.afterSubmit(schedule, models) : [...schedule, ...models.filter(m => m.selectedAction === "RW").map(m => m.courseReferenceNumber)];
      return opts.submitRows ? opts.submitRows(models) : models.map(m => ({ crn: m.courseReferenceNumber, ok: true, message: "Registered", statusDescription: "Registered" }));
    },
  };
  return { api, calls, submitted, schedule: () => schedule };
}

describe("LiveRegistrar gating", () => {
  test.each<[string, Config["mode"], Partial<Settings>, Partial<Config>, string | null | undefined, LiveNotAllowed["reason"]]>([
    ["simulated mode", "simulated", { liveEnabled: true, liveTerm: TERM }, {}, undefined, "not_live_mode"],
    ["rehearsal mode", "rehearsal", { liveEnabled: true, liveTerm: TERM }, {}, undefined, "not_live_mode"],
    ["saved mode is not live", "live", { liveEnabled: true, liveTerm: TERM, mode: "rehearsal" }, {}, undefined, "not_live_mode"],
    ["hot reload", "live", { liveEnabled: true, liveTerm: TERM }, { hotReload: true }, undefined, "not_live_mode"],
    ["Live switched off", "live", { liveEnabled: false, liveTerm: TERM }, {}, undefined, "live_disabled"],
    ["no live term", "live", { liveEnabled: true, liveTerm: null }, {}, undefined, "term_mismatch"],
    ["a different term", "live", { liveEnabled: true, liveTerm: TERM }, {}, "120268", "term_mismatch"],
  ])("constructor refuses: %s", (_name, mode, patch, configPatch, term, reason) => {
    const e = env(mode, patch);
    const config = { ...e.config, ...configPatch };
    let error: unknown;
    try {
      new LiveRegistrar({ ...e, config, api: fakeApi().api }, term);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LiveNotAllowed);
    expect((error as LiveNotAllowed).reason).toBe(reason);
  });

  test.each<[string, Partial<Settings>, RegisterRequest]>([
    ["mode switched mid-run", { mode: "simulated" }, request(["31187"])],
    ["Live switched off", { liveEnabled: false }, request(["31187"])],
    ["live term changed", { liveTerm: "120268" }, request(["31187"])],
    ["a drop while swaps are locked", {}, request(["31187"], "22222")],
  ])("register aborts before any Banner call: %s", async (_name, patch, req) => {
    const e = env();
    const fake = fakeApi();
    const live = new LiveRegistrar({ ...e, api: fake.api });
    e.store.updateSettings(patch);
    expect((await live.register(req)).outcome).toBe("aborted");
    expect(fake.calls).toEqual([]);
  });
});

describe("LiveRegistrar flow", () => {
  test("snapshots, authorizes, adds, submits, de-authorizes, verifies", async () => {
    const e = env();
    const fake = fakeApi();
    const result = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187", "31225"]));
    expect(result.outcome).toBe("success");
    expect(fake.calls).toEqual(["ensureWarm", "readSchedule", "authorize", "add:31187,31225", "submit", "deauthorize", "readSchedule"]);
    expect(fake.submitted[0]!.map(m => [m.courseReferenceNumber, m.selectedAction])).toEqual([["31187", "RW"], ["31225", "RW"]]);
    expect(e.store.latestSchedule(TERM)!.crns).toEqual(["11111", "22222", "31187", "31225"]);
  });

  test("a lost CRN after submit aborts and names the lost CRN", async () => {
    const e = env();
    const fake = fakeApi({ afterSubmit: () => ["11111", "31187"] });
    const result = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(result.outcome).toBe("aborted");
    expect(result.message).toContain("22222");
  });

  test.each<[string, (crns: string[]) => AddItemRow[]]>([
    ["an unrequested model from addCRNRegistrationItems", crns => [...crns, "22222"].map(crn => ({ crn, success: true, message: null, model: model(crn) }))],
    [
      "an ambiguous add action",
      crns => crns.map(crn => ({ crn, success: true, message: null, model: { ...model(crn), registrationActions: [...ACTIONS, { courseRegistrationStatus: "RA", description: "Add pending approval" }] } })),
    ],
  ])("%s aborts before submit and de-authorizes", async (_name, addRows) => {
    const e = env();
    const fake = fakeApi({ addRows });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("aborted");
    expect(fake.calls).not.toContain("submit");
    expect(fake.calls).toContain("deauthorize");
  });

  test("add failure returns failed with classification and no submit", async () => {
    const e = env();
    const fake = fakeApi({ addRows: crns => crns.map(crn => ({ crn, success: false, message: "Closed Section", model: null })) });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("failed");
    expect(r.classification).toBe("transient");
    expect(fake.calls).not.toContain("submit");
  });

  test("row errors from submit are reported per CRN", async () => {
    const e = env();
    const fake = fakeApi({
      afterSubmit: s => s,
      submitRows: models => models.map(m => ({ crn: m.courseReferenceNumber, ok: false, message: "Prerequisite and Test Score error", statusDescription: null })),
    });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("failed");
    expect(r.classification).toBe("permanent");
    expect(r.rows).toEqual([{ crn: "31187", ok: false, message: "Prerequisite and Test Score error" }]);
  });

  test("swap with swaps unlocked drops only the named CRN", async () => {
    const e = env("live", { liveEnabled: true, liveTerm: TERM, swapsUnlocked: true });
    const fake = fakeApi({ afterSubmit: s => [...s.filter(c => c !== "22222"), "31187"] });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"], "22222"));
    expect(r.outcome).toBe("success");
    expect(fake.submitted[0]!.map(m => [m.courseReferenceNumber, m.selectedAction])).toEqual([["31187", "RW"], ["22222", "DW"]]);
  });

  test("postSubmitCheck compares against the live snapshot", async () => {
    const e = env();
    const fake = fakeApi();
    await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    const success = { outcome: "success" as const, rows: [], classification: null, message: null, ms: 0 };
    expect((await makePostSubmitCheck({ api: fake.api, store: e.store })(request(["31187"]), success)).ok).toBe(true);
    const losing = { ...fake.api, readSchedule: async () => ["31187"] };
    const bad = await makePostSubmitCheck({ api: losing, store: e.store })(request(["31187"]), success);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("11111");
    expect(bad.detail).toContain("22222");
  });
});

describe("LiveRegistrar schedule guards", () => {
  test("aborts before any write when a CRN from the last trusted snapshot vanished", async () => {
    const e = env();
    e.store.addScheduleSnapshot(TERM, ["11111", "22222", "33333"], "rehearsal");
    const fake = fakeApi();
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("aborted");
    expect(r.message).toContain("33333");
    expect(fake.calls).not.toContain("authorize");
    expect(fake.calls).not.toContain("submit");
  });

  test("a matching or smaller last snapshot proceeds; only rehearsal and live_after count", async () => {
    const e = env();
    e.store.addScheduleSnapshot(TERM, ["11111"], "rehearsal");
    e.store.addScheduleSnapshot(TERM, ["11111", "99999"], "live_before");
    const fake = fakeApi();
    expect((await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]))).outcome).toBe("success");
  });

  test("the post-submit read using different strategies cannot verify", async () => {
    const e = env();
    let reads = 0;
    const fake = fakeApi({ strategies: () => (reads++ === 0 ? ["summary", "calendar"] : ["summary"]) });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("aborted");
    expect(r.classification).toBe("unknown");
  });

  test.each<[string, (s: string[]) => string[], "aborted" | "failed"]>([
    // 31187 lands on the schedule but 31225 does not: a partial bundle.
    ["a partially added bundle aborts", s => [...s, "31187"], "aborted"],
    // The schedule is unchanged, so this is not a partial add, but Banner accepted a row.
    ["a failed submit with any accepted row", s => s, "failed"],
  ])("%s with unknown, never transient", async (_name, afterSubmit, outcome) => {
    const e = env();
    const fake = fakeApi({
      afterSubmit,
      submitRows: models => models.map(m => ({ crn: m.courseReferenceNumber, ok: m.courseReferenceNumber === "31187", message: m.courseReferenceNumber === "31187" ? "Registered" : "Closed Section", statusDescription: null })),
    });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187", "31225"]));
    expect(r.outcome).toBe(outcome);
    expect(r.classification).toBe("unknown");
  });
});

describe("RehearsalRegistrar", () => {
  test("dry run never invokes a write path", async () => {
    const e = env("rehearsal", {});
    const fake = fakeApi();
    // Hand it the full object to prove it does not reach for write methods even when present.
    const r = await new RehearsalRegistrar({ api: fake.api as BannerReadApi, clock: e.clock, store: e.store }).register(request(["31187", "31225"]));
    expect(r.outcome).toBe("dry_run");
    expect(r.rows.map(row => row.crn)).toEqual(["31187", "31225"]);
    expect(fake.calls).toEqual(["ensureWarm", "readSchedule"]);
    expect(fake.submitted).toEqual([]);
  });

  test("read-only API object has no write methods, and writeApi refuses outside live mode", () => {
    const e = env("rehearsal", {});
    const manager = new BannerSessionManager({ config: e.config, events: new Events(e.store, new Bus()), store: e.store, clock: e.clock, settings: e.settings, credentials: () => null });
    const api = manager.readApi() as unknown as Record<string, unknown>;
    for (const name of ["withAuthorizedBatch", "addCrnItems", "submitBatch", "workingSet"]) expect(api[name]).toBeUndefined();
    expect(() => manager.writeApi()).toThrow("not_live");
  });

  test("a session failure is reported, not thrown", async () => {
    const e = env("rehearsal", {});
    const api: BannerReadApi = {
      ...fakeApi().api,
      ensureWarm: async () => {
        throw new BannerSessionError("missing_credentials");
      },
    };
    const r = await new RehearsalRegistrar({ api, clock: e.clock }).register(request(["31187"]));
    expect(r.outcome).toBe("failed");
    expect(r.message).toContain("missing_credentials");
  });
});
