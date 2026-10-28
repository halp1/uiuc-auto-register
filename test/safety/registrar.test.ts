import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { loadConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import type { Settings } from "../../src/core/types";
import { LiveNotAllowed, LiveRegistrar, makePostSubmitCheck } from "../../src/banner/registrar/live";
import { RehearsalRegistrar } from "../../src/banner/registrar/rehearsal";
import type { AddItemRow, BannerReadApi, BannerWriteApi, ScheduleStrategy, SubmitRow } from "../../src/banner/registrar/types";
import type { RegistrationModel } from "../../src/banner/guard";

const TERM = "120271";
const ACTIONS = [
  { courseRegistrationStatus: "RW", description: "**Web Registered**" },
  { courseRegistrationStatus: "DW", description: "Web Drop" },
];
const model = (crn: string): RegistrationModel => ({ courseReferenceNumber: crn, term: TERM, registrationActions: ACTIONS, selectedAction: null });
const request = (addCrns: string[], dropCrn: string | null = null) => ({ term: TERM, bundleId: 1, addCrns, dropCrn });

function cfg(mode: Config["mode"]): Config {
  return { ...loadConfig({ NODE_ENV: "test" }), mode };
}

function env(mode: Config["mode"] = "live", patch: Partial<Settings> = { liveEnabled: true, liveTerm: TERM }) {
  const store = new Store(":memory:");
  store.updateSettings(patch);
  void new Bus();
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
    readScheduleDetailed: async () => (calls.push("readSchedule"), { crns: [...schedule], strategies: opts.strategies?.() ?? ["registrationEvents"] }),
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
  test("constructor refuses simulated and rehearsal modes", () => {
    for (const mode of ["simulated", "rehearsal"] as const) {
      const e = env(mode);
      expect(() => new LiveRegistrar({ ...e, api: fakeApi().api })).toThrow(LiveNotAllowed);
    }
  });

  test("constructor refuses when Live is off or the term mismatches", () => {
    const off = env("live", { liveEnabled: false, liveTerm: TERM });
    expect(() => new LiveRegistrar({ ...off, api: fakeApi().api })).toThrow("live_disabled");
    const noTerm = env("live", { liveEnabled: true, liveTerm: null });
    expect(() => new LiveRegistrar({ ...noTerm, api: fakeApi().api })).toThrow("term_mismatch");
    const other = env("live", { liveEnabled: true, liveTerm: TERM });
    expect(() => new LiveRegistrar({ ...other, api: fakeApi().api }, "120268")).toThrow("term_mismatch");
  });

  test("register re-checks the gates on every call", async () => {
    const e = env();
    const fake = fakeApi();
    const live = new LiveRegistrar({ ...e, api: fake.api });
    e.store.updateSettings({ liveEnabled: false });
    const r1 = await live.register(request(["31187"]));
    expect(r1.outcome).toBe("aborted");
    e.store.updateSettings({ liveEnabled: true, liveTerm: "120268" });
    const r2 = await live.register(request(["31187"]));
    expect(r2.outcome).toBe("aborted");
    expect(fake.calls).toEqual([]);
  });

  test("a drop needs swaps unlocked", async () => {
    const e = env();
    const fake = fakeApi();
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"], "22222"));
    expect(r.outcome).toBe("aborted");
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

  test("a lost CRN after submit returns aborted with the schedule guard message", async () => {
    const e = env();
    const fake = fakeApi({ afterSubmit: () => ["11111", "31187"] });
    const result = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(result.outcome).toBe("aborted");
    expect(result.message).toBe("Schedule guard: lost CRNs 22222");
  });

  test("an unexpected model from addCRNRegistrationItems aborts before submit", async () => {
    const e = env();
    const fake = fakeApi({ addRows: crns => [...crns, "22222"].map(crn => ({ crn, success: true, message: null, model: model(crn) })) });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("aborted");
    expect(fake.calls).not.toContain("submit");
  });

  test("an ambiguous add action aborts before submit", async () => {
    const e = env();
    const ambiguous = [...ACTIONS, { courseRegistrationStatus: "RA", description: "Add pending approval" }];
    const fake = fakeApi({ addRows: crns => crns.map(crn => ({ crn, success: true, message: null, model: { ...model(crn), registrationActions: ambiguous } })) });
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
    const check = makePostSubmitCheck({ api: fake.api, store: e.store });
    expect((await check(request(["31187"]), { outcome: "success", rows: [], classification: null, message: null, ms: 0 })).ok).toBe(true);
    const losing = { ...fake.api, readSchedule: async () => ["31187"] };
    const bad = await makePostSubmitCheck({ api: losing, store: e.store })(request(["31187"]), { outcome: "success", rows: [], classification: null, message: null, ms: 0 });
    expect(bad).toEqual({ ok: false, detail: "Schedule guard: lost CRNs 11111, 22222" });
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
    const fake = fakeApi({ strategies: () => (reads++ === 0 ? ["registrationEvents", "classRegistrationReset"] : ["classRegistrationReset"]) });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187"]));
    expect(r.outcome).toBe("aborted");
    expect(r.classification).toBe("unknown");
    expect(r.message).toBe("Schedule guard: could not verify the schedule");
  });

  test("a partially added bundle aborts with unknown", async () => {
    const e = env();
    const fake = fakeApi({
      afterSubmit: s => [...s, "31187"],
      submitRows: models => models.map(m => ({ crn: m.courseReferenceNumber, ok: m.courseReferenceNumber === "31187", message: m.courseReferenceNumber === "31187" ? "Registered" : "Closed Section", statusDescription: null })),
    });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187", "31225"]));
    expect(r.outcome).toBe("aborted");
    expect(r.classification).toBe("unknown");
    expect(r.message).toStartWith("Schedule guard: only part of the bundle was added");
  });

  test("a failed submit with any accepted row is unknown, never transient", async () => {
    const e = env();
    const fake = fakeApi({
      afterSubmit: s => s, // schedule unchanged, so not a partial add
      submitRows: models => models.map(m => ({ crn: m.courseReferenceNumber, ok: m.courseReferenceNumber === "31187", message: "Closed Section", statusDescription: null })),
    });
    const r = await new LiveRegistrar({ ...e, api: fake.api }).register(request(["31187", "31225"]));
    expect(r.outcome).toBe("failed");
    expect(r.classification).toBe("unknown");
  });
});

describe("RehearsalRegistrar", () => {
  test("dry run never invokes a write path", async () => {
    const e = env("rehearsal", {});
    const fake = fakeApi();
    // Hand it the full object to prove it does not reach for write methods even when present.
    const spyApi = fake.api as BannerReadApi;
    const r = await new RehearsalRegistrar({ api: spyApi, clock: e.clock, store: e.store }).register(request(["31187", "31225"]));
    expect(r.outcome).toBe("dry_run");
    expect(r.message).toStartWith("Would register CRNs 31187, 31225");
    expect(fake.calls).toEqual(["ensureWarm", "readSchedule"]);
    expect(fake.submitted).toEqual([]);
  });

  test("read-only API object has no write methods", async () => {
    const { BannerSessionManager } = await import("../../src/banner/session");
    const e = env("rehearsal", {});
    const { Events } = await import("../../src/core/events");
    const manager = new BannerSessionManager({ config: e.config, events: new Events(e.store, new Bus()), store: e.store, clock: e.clock, settings: e.settings, credentials: () => null });
    const api = manager.readApi() as unknown as Record<string, unknown>;
    for (const name of ["withAuthorizedBatch", "addCrnItems", "submitBatch", "workingSet"]) expect(api[name]).toBeUndefined();
    expect(() => manager.writeApi()).toThrow("not_live");
  });

  test("a session failure is reported, not thrown", async () => {
    const e = env("rehearsal", {});
    const fake = fakeApi();
    const api: BannerReadApi = { ...fake.api, ensureWarm: async () => { throw new (await import("../../src/banner/registrar/types")).BannerSessionError("missing_credentials"); } };
    const r = await new RehearsalRegistrar({ api, clock: e.clock }).register(request(["31187"]));
    expect(r.outcome).toBe("failed");
    expect(r.message).toContain("missing_credentials");
  });
});
