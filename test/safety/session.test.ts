import { describe, expect, spyOn, test } from "bun:test";
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

  test("launch failures log the cause but expose only a fixed reason code", async () => {
    const store = new Store(":memory:");
    const error = new Error("Chromium sandbox could not start");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const manager = new BannerSessionManager({
        config: { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal" },
        events: new Events(store, new Bus()),
        store,
        clock: new FakeClock(),
        settings: () => store.getSettings(),
        browserFactory: async () => {
          throw error;
        },
        credentials: () => CREDS,
      });
      await expect(manager.ensureWarm("120271")).rejects.toThrow("browser_launch_failed");
      expect(log).toHaveBeenCalledWith("Browser launch failed", error);
      expect(manager.status().lastError).toBe("browser_launch_failed");
      expect(store.listEvents().find(e => e.kind === "session_error")?.detail).toBe("browser_launch_failed");
      expect(JSON.stringify(store.listEvents())).not.toContain(error.message);
    } finally {
      log.mockRestore();
      store.close();
    }
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
  // Shaped like the real Fall 2026 probe (2026-10-28): 9 registered rows in summaryModels, and the
  // calendar (getRegistrationEvents?termFilter=) lists only the 8 with meeting times.
  const REGISTERED = (crn: string, term = "120271") => ({ courseReferenceNumber: crn, term, statusDescription: "Registered" });

  function warmManager(opts: {
    termSearch?: string;
    page?: unknown;
    calendar?: { status: number; body: string };
  }) {
    const store = new Store(":memory:");
    const events = new Events(store, new Bus());
    const bannerPage = { url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/classRegistration/classRegistration", syncToken: true };
    const browser = new FakeBrowser(() => bannerPage);
    browser.page = bannerPage;
    const fetched: string[] = [];
    browser.evaluateOther = (expr: string) => {
      if (expr.includes("window.bootstraps")) return opts.page;
      const url = /"url":"([^"]+)"/.exec(expr)?.[1] ?? "";
      fetched.push(url);
      const reply = (status: number, body: string) => ({ status, url: url.split("?")[0], redirected: false, loginPage: false, contentType: "application/json", body });
      if (url.includes("term/search")) return reply(200, opts.termSearch ?? '{"fwdURL":"/x"}');
      if (url.includes("getRegistrationEvents")) return opts.calendar ? reply(opts.calendar.status, opts.calendar.body) : reply(500, "<html>error</html>");
      return reply(404, "");
    };
    const manager = new BannerSessionManager({ config: { ...loadConfig({ NODE_ENV: "test" }), mode: "rehearsal" }, events, store, clock: new FakeClock(), settings: () => store.getSettings(), credentials: () => null });
    // Pretend a login already happened.
    Object.assign(manager as any, { browser, current: "warm" });
    return { manager, store, fetched };
  }

  test("the page summary is the schedule, including sections the calendar does not list", async () => {
    const { manager, fetched } = warmManager({
      page: { terms: "120271", multiTerm: false, summaryModels: ["11111", "22222", "33333"].map(c => REGISTERED(c)) },
      calendar: { status: 200, body: JSON.stringify([{ crn: "11111", term: "120271" }, { crn: "22222", term: "120271" }]) },
    });
    expect(await manager.readScheduleDetailed("120271")).toEqual({ crns: ["11111", "22222", "33333"], strategies: ["summary", "calendar"] });
    // The calendar is asked with an empty termFilter: UIUC answers 500 to any term value.
    expect(fetched.some(u => u.endsWith("getRegistrationEvents?termFilter="))).toBe(true);
  });

  test("a calendar CRN missing from the summary rejects the read", async () => {
    const { manager } = warmManager({
      page: { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] },
      calendar: { status: 200, body: JSON.stringify([{ crn: "11111", term: "120271" }, { crn: "99999", term: "120271" }]) },
    });
    await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("schedule_unreadable");
  });

  test("a calendar error does not block a valid summary", async () => {
    const { manager } = warmManager({ page: { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] } });
    expect(await manager.readScheduleDetailed("120271")).toEqual({ crns: ["11111"], strategies: ["summary"] });
  });

  test("a page rendered for another term, multi-term, or missing data is unreadable", async () => {
    for (const page of [
      { terms: "120268", multiTerm: false, summaryModels: [REGISTERED("11111", "120268")] },
      { terms: "120271", multiTerm: true, summaryModels: [REGISTERED("11111")] },
      { terms: "120271", multiTerm: false, summaryModels: null },
      { terms: "120271", multiTerm: false, summaryModels: [{ courseReferenceNumber: "11111", term: "120271" }] },
      { terms: "120271", multiTerm: false, summaryModels: [{ courseReferenceNumber: "11111", term: "120271", statusDescription: "Pending" }] },
      null,
    ]) {
      const { manager } = warmManager({ page });
      await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("schedule_unreadable");
    }
  });

  test("an empty summary is a genuinely empty schedule", async () => {
    const { manager } = warmManager({ page: { terms: "120271", multiTerm: false, summaryModels: [] }, calendar: { status: 200, body: "[]" } });
    expect(await manager.readScheduleDetailed("120271")).toEqual({ crns: [], strategies: ["summary", "calendar"] });
  });

  test("dropped rows in the summary are not on the schedule", async () => {
    const { manager } = warmManager({
      page: { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111"), { courseReferenceNumber: "22222", term: "120271", statusDescription: "Web Dropped" }] },
    });
    expect((await manager.readScheduleDetailed("120271")).crns).toEqual(["11111"]);
  });

  test("a term that is not open for registration cannot be read", async () => {
    const { manager } = warmManager({
      termSearch: JSON.stringify({ regAllowed: false, studentEligFailures: ["Term not eligible for registration"] }),
      page: { terms: "120271", multiTerm: false, summaryModels: [] },
    });
    await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("term_not_open");
  });

  test("rehearse stores a rehearsal snapshot and records the reader", async () => {
    const { manager, store } = warmManager({ page: { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] } });
    const report = await manager.rehearse("120271", []);
    expect(report.ok).toBe(true);
    expect(report.schedule).toEqual(["11111"]);
    expect(report.reader).toBe("summary-v1");
    expect(store.latestSchedule("120271")!.crns).toEqual(["11111"]);
  });

  test("rehearsing a term that is not open fails instead of passing with an empty schedule", async () => {
    const { manager, store } = warmManager({
      termSearch: JSON.stringify({ regAllowed: false, studentEligFailures: ["Term not eligible for registration"] }),
      page: { terms: "120271", multiTerm: false, summaryModels: [] },
    });
    const report = await manager.rehearse("120271", []);
    expect(report.ok).toBe(false);
    expect(report.schedule).toBeNull();
    expect(report.steps.find(s => s.name === "term_open")).toMatchObject({ ok: false });
    expect(store.latestSchedule("120271")).toBeNull();
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

describe("readTicket", () => {
  const PREP = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/prepareRegistration/prepareRegistration";
  function ticketManager(text: string, opts: { termSearchStatus?: number; landOn?: string } = {}) {
    const store = new Store(":memory:");
    const events = new Events(store, new Bus());
    const bannerPage = { url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/classRegistration/classRegistration", syncToken: true };
    const browser = new FakeBrowser((_b, url) => ({ url: opts.landOn ?? url, syncToken: true }));
    browser.page = bannerPage;
    const fetched: { url: string; method: string; form: any }[] = [];
    browser.evaluateOther = (expr: string) => {
      if (expr.includes("innerText") && expr.includes("200000")) return text;
      if (expr.includes("window.bootstraps")) return { terms: "120271", multiTerm: false, summaryModels: [] };
      const args = /\}\)\((\{[\s\S]*\})\)$/.exec(expr)?.[1];
      const a = args ? JSON.parse(args) : { url: "" };
      fetched.push({ url: a.url, method: a.method, form: a.form });
      const reply = (status: number, body: string) => ({ status, url: String(a.url).split("?")[0], redirected: false, loginPage: false, contentType: "application/json", body });
      if (String(a.url).includes("term/search")) return reply(opts.termSearchStatus ?? 200, '{"fwdURL":"/x"}');
      if (String(a.url).includes("getRegistrationEvents")) return reply(200, "[]");
      return reply(404, "");
    };
    const manager = new BannerSessionManager({ config: { ...loadConfig({ NODE_ENV: "test" }), mode: "live" }, events, store, clock: new FakeClock(), settings: () => store.getSettings(), credentials: () => null });
    Object.assign(manager as any, { browser, current: "warm" });
    return { manager, browser, fetched, store };
  }

  test("selects the term in preReg mode, opens Prepare for Registration, and parses the ticket", async () => {
    const t = ticketManager("Time Tickets\nRegistration Time Ticket\n11/09/2026 07:00 AM - 01/29/2027 11:59 PM");
    const parsed = await t.manager.readTicket("120271");
    expect(parsed).toEqual({ status: "found", windows: [{ start: "2026-11-09T13:00:00.000Z", end: "2027-01-30T05:59:00.000Z" }] });
    expect(t.fetched[0]).toMatchObject({ method: "POST", form: { term: "120271" } });
    expect(t.fetched[0]!.url).toEndWith("/term/search?mode=preReg");
    expect(t.browser.navigations).toEqual([PREP]);
    // Nothing else was requested: no registration endpoints.
    expect(t.fetched.length).toBe(1);
  });

  test("leaving Banner means the session is gone", async () => {
    const t = ticketManager("", { landOn: "https://login.microsoftonline.com/x" });
    await expect(t.manager.readTicket("120271")).rejects.toThrow("login_required");
    expect(t.manager.state()).toBe("cold");
  });

  test("term search failure", async () => {
    const t = ticketManager("", { termSearchStatus: 500 });
    await expect(t.manager.readTicket("120271")).rejects.toThrow("term_search_failed");
  });

  test("registration reads wait for a ticket read and re-select their term afterwards", async () => {
    const t = ticketManager("Time Ticket 11/09/2026 07:00 AM");
    Object.assign(t.manager as any, { activeTerm: "120271", termEligibility: new Map([["120271", { allowed: true, messages: [] }]]) });
    const ticket = t.manager.readTicket("120271");
    const schedule = t.manager.readScheduleDetailed("120271");
    await ticket;
    await schedule;
    const order = t.fetched.map(f => f.url.replace(/^.*\/ssb/, ""));
    expect(order[0]).toBe("/term/search?mode=preReg");
    // After the ticket read the registration term is selected again before the schedule read.
    expect(order[1]).toBe("/term/search?mode=registration");
  });

  test("refuses while a registration batch is authorized", async () => {
    const t = ticketManager("Time Ticket 11/09/2026 07:00 AM");
    (t.manager as any).authorized = { term: "120271", addCrns: ["11111"], dropCrn: null };
    await expect(t.manager.readTicket("120271")).rejects.toThrow("batch_in_flight");
    expect(t.fetched.length).toBe(0);
  });
});
