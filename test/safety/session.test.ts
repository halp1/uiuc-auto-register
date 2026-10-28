import { describe, expect, test } from "bun:test";
import { BannerSessionManager } from "../../src/banner/session";
import { createRealBanner } from "../../src/banner/real";
import { parseScheduleJson, parseSubmitBatch, parseTermSearch } from "../../src/banner/registrar/types";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { loadConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { BrowserFactory } from "../../src/auth/browser";
import { FakeBrowser } from "../auth/fake-browser";

const CREDS = { netid: "student7", password: "pw", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };

function setup(over: Partial<Config> = {}, creds: typeof CREDS | null = null) {
  const store = new Store(":memory:");
  const events = new Events(store, new Bus());
  const config: Config = { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal", ...over };
  let launches = 0;
  const browserFactory: BrowserFactory = async opts => {
    launches++;
    return new FakeBrowser(() => ({ url: "about:blank" }), opts.backend);
  };
  const manager = new BannerSessionManager({ config, events, store, clock: new FakeClock(), settings: () => store.getSettings(), browserFactory, credentials: () => creds });
  return { manager, store, launches: () => launches, events: () => store.listEvents() };
}

describe("BannerSessionManager", () => {
  test("missing credentials: error state, reason code, no browser", async () => {
    const s = setup();
    await expect(s.manager.ensureWarm("120271")).rejects.toThrow("missing_credentials");
    expect(s.manager.state()).toBe("error");
    expect(s.manager.status().lastError).toBe("missing_credentials");
    expect(s.launches()).toBe(0);
    const critical = s.events().find(e => e.kind === "session_error");
    expect(critical?.severity).toBe("critical");
    expect(critical?.detail).toBe("missing_credentials");
  });

  test("the webkit backend is refused for rehearsal and live", async () => {
    for (const mode of ["rehearsal", "live"] as const) {
      const s = setup({ mode, browserBackend: "webkit" }, CREDS);
      await expect(s.manager.ensureWarm("120271")).rejects.toThrow("webkit_unsupported");
      expect(s.launches()).toBe(0);
    }
  });

  test("a factory that hands back a webkit view is closed and refused", async () => {
    const store = new Store(":memory:");
    const fake = new FakeBrowser(() => ({ url: "about:blank" }), "webkit");
    const manager = new BannerSessionManager({
      config: { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal" },
      events: new Events(store, new Bus()),
      store,
      clock: new FakeClock(),
      settings: () => store.getSettings(),
      browserFactory: async () => fake,
      credentials: () => CREDS,
    });
    await expect(manager.ensureWarm("120271")).rejects.toThrow("webkit_unsupported");
    expect(fake.closed).toBe(true);
  });

  test("a chrome view without CDP fails closed (no interceptor, no login)", async () => {
    const s = setup({}, CREDS);
    await expect(s.manager.ensureWarm("120271")).rejects.toThrow("interceptor_failed");
    expect(s.manager.state()).toBe("error");
  });

  test("pauseUntil blocks warming", async () => {
    const s = setup({}, CREDS);
    await s.manager.pauseUntil(Date.UTC(2030, 0, 1));
    expect(s.manager.state()).toBe("paused");
    await expect(s.manager.ensureWarm("120271")).rejects.toThrow("paused");
    expect(s.launches()).toBe(0);
    await s.manager.pauseUntil(null);
    expect(s.manager.state()).toBe("cold");
  });

  test("rehearse reports failed steps without throwing", async () => {
    const s = setup();
    const report = await s.manager.rehearse("120271", []);
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ name: "login", ok: false, detail: "missing_credentials" });
    expect(report.blockedWrites).toBe(0);
  });
});

describe("readScheduleDetailed", () => {
  function warmManager(responses: Record<string, { status: number; body: string }>) {
    const store = new Store(":memory:");
    const events = new Events(store, new Bus());
    const bannerPage = { url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/classRegistration/classRegistration", syncToken: true };
    const browser = new FakeBrowser(() => bannerPage);
    browser.page = bannerPage;
    browser.evaluateOther = (expr: string) => {
      const match = /"url":"([^"]+)"/.exec(expr);
      const url = match?.[1] ?? "";
      if (url.includes("term/search")) return { status: 200, url: "", redirected: false, loginPage: false, contentType: "application/json", body: '{"fwdURL":"/x"}' };
      const key = Object.keys(responses).find(k => url.includes(k));
      const r = key ? responses[key]! : { status: 404, body: "" };
      return { status: r.status, url: url.split("?")[0], redirected: false, loginPage: false, contentType: "application/json", body: r.body };
    };
    const manager = new BannerSessionManager({ config: { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal" }, events, store, clock: new FakeClock(), settings: () => store.getSettings(), credentials: () => null });
    // Pretend a login already happened.
    Object.assign(manager as any, { browser, current: "warm" });
    return { manager, store };
  }

  test("error bodies from every strategy throw schedule_unreadable", async () => {
    const { manager } = warmManager({
      getRegistrationEvents: { status: 200, body: '{"success":false}' },
      "classRegistration/reset": { status: 200, body: "{}" },
      "registrationHistory/reset": { status: 200, body: '{"error":"x"}' },
    });
    await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("schedule_unreadable");
  });

  test("a well-shaped empty response is accepted as an empty schedule", async () => {
    const { manager } = warmManager({
      getRegistrationEvents: { status: 200, body: "[]" },
      "classRegistration/reset": { status: 200, body: '{"success":false}' },
    });
    expect(await manager.readScheduleDetailed("120271")).toEqual({ crns: [], strategies: ["registrationEvents"] });
  });

  test("rehearse stores a rehearsal snapshot", async () => {
    const { manager, store } = warmManager({ getRegistrationEvents: { status: 200, body: '[{"crn":"11111","term":"120271"}]' } });
    const report = await manager.rehearse("120271", []);
    expect(report.schedule).toEqual(["11111"]);
    expect(store.latestSchedule("120271")!.crns).toEqual(["11111"]);
  });
});

describe("createRealBanner", () => {
  test("refuses simulated mode, returns rehearsal registrar in live mode with Live off", () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const base = { store, bus, events: new Events(store, bus), clock: new FakeClock(), settings: () => store.getSettings() };
    expect(() => createRealBanner({ ...base, config: { ...loadConfig({ NODE_ENV: "test" }), mode: "simulated" } })).toThrow();
    const live = createRealBanner({ ...base, config: { ...loadConfig({ NODE_ENV: "test" }), mode: "live" } });
    expect(live.registrar().kind).toBe("rehearsal");
    store.updateSettings({ liveEnabled: true, liveTerm: "120271" });
    expect(live.registrar().kind).toBe("live");
    const rehearsal = createRealBanner({ ...base, config: { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal" } });
    expect(rehearsal.registrar().kind).toBe("rehearsal");
    expect(rehearsal.postSubmitCheck).toBeUndefined();
  });

  test("one LiveRegistrar per liveTerm, rebuilt when the term changes", () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const real = createRealBanner({ store, bus, events: new Events(store, bus), clock: new FakeClock(), settings: () => store.getSettings(), config: { ...loadConfig({ NODE_ENV: "test" }), mode: "live" } });
    store.updateSettings({ liveEnabled: true, liveTerm: "120271" });
    const first = real.registrar();
    expect(real.registrar()).toBe(first);
    store.updateSettings({ liveTerm: "120270" });
    const second = real.registrar();
    expect(second.kind).toBe("live");
    expect(second).not.toBe(first);
    store.updateSettings({ liveEnabled: false });
    expect(real.registrar().kind).toBe("rehearsal");
  });
});

describe("parsers", () => {
  test("schedule JSON: registered CRNs on the term only", () => {
    const body = JSON.stringify([
      { crn: "31187", term: "120271", title: "x" },
      { courseReferenceNumber: "31225", term: "120271", statusDescription: "Registered" },
      { courseReferenceNumber: "40000", term: "120271", statusDescription: "Dropped" },
      { courseReferenceNumber: "50000", term: "120268" },
    ]);
    expect(parseScheduleJson(body, "120271")).toEqual(["31187", "31225"]);
    expect(parseScheduleJson("<html>login</html>", "120271")).toBeNull();
    expect(parseScheduleJson("[]", "120271")).toEqual([]);
  });

  test("error-shaped or unrecognized JSON is never an empty schedule", () => {
    for (const body of [
      '{"success":false}',
      '{"success":false,"data":[]}',
      '{"error":"Session expired"}',
      '{"errors":["x"],"data":[]}',
      "{}",
      '{"message":"ok"}',
      '{"data":{"nested":true}}',
      "[1,2,3]",
      '[{"title":"no crn here"}]',
      '{"data":[{"title":"no crn"}]}',
      "null",
      '"text"',
    ]) {
      expect(parseScheduleJson(body, "120271")).toBeNull();
    }
  });

  test("well-shaped empty responses are a genuinely empty schedule", () => {
    expect(parseScheduleJson('{"success":true,"data":[]}', "120271")).toEqual([]);
    expect(parseScheduleJson('{"registrations":[]}', "120271")).toEqual([]);
    expect(parseScheduleJson('{"data":[{"courseReferenceNumber":"31187","term":"120271"}]}', "120271")).toEqual(["31187"]);
  });

  test("term search eligibility", () => {
    expect(parseTermSearch(JSON.stringify({ fwdURL: "/x" }))).toEqual({ allowed: true, messages: [] });
    expect(parseTermSearch(JSON.stringify({ regAllowed: false, studentEligFailures: ["<b>Hold</b> on account"] }))).toEqual({ allowed: false, messages: ["Hold on account"] });
    expect(parseTermSearch("nope")).toBeNull();
  });

  test("submit batch rows", () => {
    const body = JSON.stringify({ success: true, data: { update: [
      { courseReferenceNumber: "31187", errorFlag: null, statusDescription: "Registered" },
      { courseReferenceNumber: "31225", errorFlag: "F", crnErrors: [{ message: "Closed Section" }] },
    ] } });
    expect(parseSubmitBatch(body)).toEqual([
      { crn: "31187", ok: true, message: "Registered", statusDescription: "Registered" },
      { crn: "31225", ok: false, message: "Closed Section", statusDescription: null },
    ]);
  });
});
