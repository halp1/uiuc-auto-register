import { describe, expect, spyOn, test } from "bun:test";
import { BannerSessionManager } from "../../src/banner/session";
import { createRealBanner } from "../../src/banner/real";
import { parseScheduleJson, parseSubmitBatch, parseTermSearch } from "../../src/banner/registrar/types";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { makeConfig, type Config } from "../../src/core/config";
import { Store } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { BrowserFactory } from "../../src/auth/browser";
import { FakeBrowser, type FakePage } from "../auth/fake-browser";

const CREDS = { netid: "student7", password: "pw", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };
const REGISTRATION_PAGE = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/classRegistration/classRegistration";

function setup(over: Partial<Config> = {}, creds: typeof CREDS | null = null) {
  const store = new Store(":memory:");
  const events = new Events(store, new Bus());
  const config: Config = { ...makeConfig("rehearsal", { chromePath: null }), ...over };
  let launches = 0;
  const browserFactory: BrowserFactory = async opts => {
    launches++;
    return new FakeBrowser(() => ({ url: "about:blank" }), opts.backend);
  };
  const manager = new BannerSessionManager({ config, events, store, clock: new FakeClock(), settings: () => store.getSettings(), browserFactory, credentials: () => creds });
  return { manager, store, launches: () => launches, events: () => store.listEvents() };
}

/** Give a fake browser the CDP surface the write interceptor needs. */
function withCdp(browser: FakeBrowser): FakeBrowser {
  browser.cdp = async <T,>(method: string): Promise<T> => (method === "Page.getFrameTree" ? ({ frameTree: { frame: { id: "MAIN" } } } as T) : ({} as T));
  browser.onCdpEvent = () => () => {};
  return browser;
}

/** A manager logged in through the public login path on a browser that lands straight on Banner. */
async function loggedIn(browser: FakeBrowser, mode: Config["mode"] = "rehearsal") {
  const store = new Store(":memory:");
  const manager = new BannerSessionManager({
    config: makeConfig(mode, { chromePath: null }),
    events: new Events(store, new Bus()),
    store,
    clock: new FakeClock(),
    settings: () => store.getSettings(),
    browserFactory: async () => withCdp(browser),
    credentials: () => CREDS,
  });
  await manager.login();
  expect(manager.state()).toBe("warm");
  browser.navigations.length = 0;
  return { manager, store };
}

/** Pull the JSON args out of an inPageFetch expression. */
const fetchArgs = (expr: string): { url: string; method?: string; form?: Record<string, string> } => {
  const args = /\}\)\((\{[\s\S]*\})\)$/.exec(expr)?.[1];
  return args ? JSON.parse(args) : { url: "" };
};
const reply = (url: string, status: number, body: string) => ({ status, url: url.split("?")[0], redirected: false, loginPage: false, contentType: "application/json", body });

describe("BannerSessionManager", () => {
  test("the saved login is used when no credentials override is given", async () => {
    const store = new Store(":memory:");
    store.updateSettings({ netid: "student7", password: "pw", totpSecret: "not base32!" });
    let launches = 0;
    const manager = new BannerSessionManager({
      config: makeConfig("rehearsal", { chromePath: null }),
      events: new Events(store, new Bus()),
      store,
      clock: new FakeClock(),
      settings: () => store.getSettings(),
      browserFactory: async opts => (launches++, new FakeBrowser(() => ({ url: "about:blank" }), opts.backend)),
    });
    // The saved key is read (and rejected) before any browser opens.
    await expect(manager.login()).rejects.toThrow("invalid_totp_secret");
    expect(launches).toBe(0);
    store.updateSettings({ password: null });
    await manager.goCold("credentials_changed");
    await expect(manager.login()).rejects.toThrow("missing_credentials");
    expect(launches).toBe(0);
  });

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

  test("a factory that hands back a webkit view is closed and refused", async () => {
    const store = new Store(":memory:");
    const fake = new FakeBrowser(() => ({ url: "about:blank" }), "webkit");
    const manager = new BannerSessionManager({
      config: makeConfig("rehearsal", { chromePath: null }),
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
        config: makeConfig("rehearsal", { chromePath: null }),
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
      expect(log.mock.calls.some(args => args.includes(error))).toBe(true);
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
  const calendarOf = (...crns: string[]) => ({ status: 200, body: JSON.stringify(crns.map(crn => ({ crn, term: "120271" }))) });

  async function warmManager(opts: { termSearch?: string; page?: unknown; calendar?: { status: number; body: string } }) {
    const browser = new FakeBrowser(() => ({ url: REGISTRATION_PAGE, syncToken: true }));
    const fetched: string[] = [];
    browser.evaluateOther = (expr: string) => {
      if (expr.includes("window.bootstraps")) return opts.page;
      const url = fetchArgs(expr).url;
      fetched.push(url);
      if (url.includes("term/search")) return reply(url, 200, opts.termSearch ?? '{"fwdURL":"/x"}');
      if (url.includes("getRegistrationEvents")) return opts.calendar ? reply(url, opts.calendar.status, opts.calendar.body) : reply(url, 500, "<html>error</html>");
      return reply(url, 404, "");
    };
    return { ...(await loggedIn(browser)), fetched };
  }

  test.each<[string, unknown, { status: number; body: string } | undefined, { crns: string[]; strategies: string[] }]>([
    [
      "the summary is the schedule, including sections the calendar does not list",
      { terms: "120271", multiTerm: false, summaryModels: ["11111", "22222", "33333"].map(c => REGISTERED(c)) },
      calendarOf("11111", "22222"),
      { crns: ["11111", "22222", "33333"], strategies: ["summary", "calendar"] },
    ],
    ["a calendar error does not block a valid summary", { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] }, undefined, { crns: ["11111"], strategies: ["summary"] }],
    ["an empty summary is a genuinely empty schedule", { terms: "120271", multiTerm: false, summaryModels: [] }, { status: 200, body: "[]" }, { crns: [], strategies: ["summary", "calendar"] }],
    [
      "dropped rows in the summary are not on the schedule",
      { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111"), { courseReferenceNumber: "22222", term: "120271", statusDescription: "Web Dropped" }] },
      undefined,
      { crns: ["11111"], strategies: ["summary"] },
    ],
  ])("%s", async (_name, page, calendar, expected) => {
    const { manager, fetched } = await warmManager({ page, calendar });
    expect(await manager.readScheduleDetailed("120271")).toEqual(expected as never);
    // The calendar is asked with an empty termFilter: UIUC answers 500 to any term value.
    expect(fetched.some(u => u.endsWith("getRegistrationEvents?termFilter="))).toBe(true);
  });

  test.each<[string, unknown, { status: number; body: string } | undefined]>([
    ["a calendar CRN missing from the summary", { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] }, calendarOf("11111", "99999")],
    ["a page rendered for another term", { terms: "120268", multiTerm: false, summaryModels: [REGISTERED("11111", "120268")] }, undefined],
    ["a multi-term page", { terms: "120271", multiTerm: true, summaryModels: [REGISTERED("11111")] }, undefined],
    ["no summary rows", { terms: "120271", multiTerm: false, summaryModels: null }, undefined],
    ["a row without a status", { terms: "120271", multiTerm: false, summaryModels: [{ courseReferenceNumber: "11111", term: "120271" }] }, undefined],
    ["a row with an unknown status", { terms: "120271", multiTerm: false, summaryModels: [{ courseReferenceNumber: "11111", term: "120271", statusDescription: "Pending" }] }, undefined],
    ["no bootstrap data", null, undefined],
  ])("%s is schedule_unreadable", async (_name, page, calendar) => {
    const { manager } = await warmManager({ page, calendar });
    await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("schedule_unreadable");
  });

  test("a term that is not open for registration cannot be read", async () => {
    const { manager } = await warmManager({
      termSearch: JSON.stringify({ regAllowed: false, studentEligFailures: ["Term not eligible for registration"] }),
      page: { terms: "120271", multiTerm: false, summaryModels: [] },
    });
    await expect(manager.readScheduleDetailed("120271")).rejects.toThrow("term_not_open");
  });

  test("rehearse stores a rehearsal snapshot and records the reader", async () => {
    const { manager, store } = await warmManager({ page: { terms: "120271", multiTerm: false, summaryModels: [REGISTERED("11111")] } });
    const report = await manager.rehearse("120271", []);
    expect(report.ok).toBe(true);
    expect(report.schedule).toEqual(["11111"]);
    expect(report.reader).toBe("summary-v1");
    expect(store.latestSchedule("120271")!.crns).toEqual(["11111"]);
  });

  test("rehearsing a term that is not open fails instead of passing with an empty schedule", async () => {
    const { manager, store } = await warmManager({
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

describe("test (rehearse) before registration opens", () => {
  async function closedTermManager(opts: { ticketText: string; openTerms: string[] }) {
    const browser = new FakeBrowser(() => ({ url: REGISTRATION_PAGE, syncToken: true }));
    let selected = "";
    browser.evaluateOther = (expr: string) => {
      if (expr.includes("innerText") && expr.includes("200000")) return opts.ticketText;
      if (expr.includes("window.bootstraps"))
        return { terms: selected, multiTerm: false, summaryModels: ["11111", "22222"].map(crn => ({ courseReferenceNumber: crn, term: selected, statusDescription: "Registered" })) };
      const a = fetchArgs(expr);
      if (a.url.includes("term/search")) {
        const term = a.form?.term ?? "";
        if (a.url.includes("mode=registration")) selected = term;
        const open = opts.openTerms.includes(term);
        return reply(a.url, 200, JSON.stringify(open ? { fwdURL: "/x" } : { regAllowed: false, studentEligFailures: ["Term not eligible for registration"] }));
      }
      if (a.url.includes("getRegistrationEvents")) return reply(a.url, 500, "");
      return reply(a.url, 404, "");
    };
    return loggedIn(browser);
  }

  test("a future time ticket passes, and the reader is proven on a term that is open now", async () => {
    const { manager, store } = await closedTermManager({ ticketText: "Time Ticket 01/11/2027 07:00 AM - 01/29/2027 11:59 PM", openTerms: ["120268"] });
    const report = await manager.rehearse("120271", [], { otherTerms: ["120271", "120268"] });
    expect(report.ok).toBe(true);
    expect(report.opensAt).toBe("2027-01-11T13:00:00.000Z");
    expect(report.readerTerm).toBe("120268");
    expect(report.schedule).toEqual(["11111", "22222"]);
    expect(report.steps.find(s => s.name === "term_open")).toMatchObject({ ok: true });
    // The open term gets the snapshot. The closed term has none, so its first real read is fresh.
    expect(store.latestSchedule("120268")!.crns).toEqual(["11111", "22222"]);
    expect(store.latestSchedule("120271")).toBeNull();
  });

  test("no ticket and no typed ticket still fails as not open", async () => {
    const { manager } = await closedTermManager({ ticketText: "Time Tickets\nYou have no time ticket for this term.", openTerms: ["120268"] });
    const report = await manager.rehearse("120271", [], { otherTerms: ["120268"] });
    expect(report.ok).toBe(false);
    expect(report.steps.find(s => s.name === "term_open")?.detail).toStartWith("term_not_open");
  });

  test("an unreadable ticket page falls back to the ticket typed in Settings", async () => {
    const { manager } = await closedTermManager({ ticketText: "Prepare for Registration", openTerms: ["120268"] });
    const report = await manager.rehearse("120271", [], { otherTerms: ["120268"], knownTicketAt: "2027-01-11T13:00:00.000Z" });
    expect(report.ok).toBe(true);
    expect(report.opensAt).toBe("2027-01-11T13:00:00.000Z");
  });

  test("a ticket in the past does not count, and with no open term the reader step fails", async () => {
    const past = await closedTermManager({ ticketText: "Time Ticket 10/01/2026 07:00 AM", openTerms: ["120268"] });
    expect((await past.manager.rehearse("120271", [], { otherTerms: ["120268"] })).ok).toBe(false);
    const none = await closedTermManager({ ticketText: "Time Ticket 01/11/2027 07:00 AM", openTerms: [] });
    const report = await none.manager.rehearse("120271", [], { otherTerms: ["120268"] });
    expect(report.ok).toBe(false);
    expect(report.steps.find(s => s.name === "read_schedule")?.detail).toStartWith("no_open_term");
  });
});

describe("createRealBanner", () => {
  test("refuses simulated mode, returns rehearsal registrar in live mode with Live off", () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const base = { store, bus, events: new Events(store, bus), clock: new FakeClock(), settings: () => store.getSettings() };
    expect(() => createRealBanner({ ...base, config: makeConfig("simulated", { chromePath: null }) })).toThrow();
    const live = createRealBanner({ ...base, config: makeConfig("live", { chromePath: null }) });
    expect(live.registrar().kind).toBe("rehearsal");
    store.updateSettings({ liveEnabled: true, liveTerm: "120271" });
    expect(live.registrar().kind).toBe("live");
    const rehearsal = createRealBanner({ ...base, config: makeConfig("rehearsal", { chromePath: null }) });
    expect(rehearsal.registrar().kind).toBe("rehearsal");
    expect(rehearsal.postSubmitCheck).toBeUndefined();
  });

  test("one LiveRegistrar per liveTerm, rebuilt when the term changes", () => {
    const store = new Store(":memory:");
    const bus = new Bus();
    const real = createRealBanner({ store, bus, events: new Events(store, bus), clock: new FakeClock(), settings: () => store.getSettings(), config: makeConfig("live", { chromePath: null }) });
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
  test.each<[string, string, string[] | null]>([
    [
      "registered CRNs on the term only",
      JSON.stringify([
        { crn: "31187", term: "120271", title: "x" },
        { courseReferenceNumber: "31225", term: "120271", statusDescription: "Registered" },
        { courseReferenceNumber: "40000", term: "120271", statusDescription: "Dropped" },
        { courseReferenceNumber: "50000", term: "120268" },
      ]),
      ["31187", "31225"],
    ],
    ["HTML login page", "<html>login</html>", null],
    ["empty array", "[]", []],
    ["success with empty data", '{"success":true,"data":[]}', []],
    ["empty registrations", '{"registrations":[]}', []],
    ["wrapped data", '{"data":[{"courseReferenceNumber":"31187","term":"120271"}]}', ["31187"]],
    // Error-shaped or unrecognized JSON is never an empty schedule.
    ...[
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
    ].map(body => [`unrecognized ${body}`, body, null] as [string, string, null]),
  ])("parseScheduleJson: %s", (_name, body, expected) => {
    expect(parseScheduleJson(body, "120271")).toEqual(expected);
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

  async function ticketManager(text: string, opts: { termSearchStatus?: number; landOn?: string } = {}) {
    let afterLogin = false;
    // Login lands on Banner. Later navigations land on opts.landOn when given.
    const browser = new FakeBrowser((_b, url): FakePage => ({ url: afterLogin && opts.landOn ? opts.landOn : url, syncToken: true }));
    const fetched: { url: string; method?: string; form?: Record<string, string> }[] = [];
    browser.evaluateOther = (expr: string) => {
      if (expr.includes("innerText") && expr.includes("200000")) return text;
      if (expr.includes("window.bootstraps")) return { terms: "120271", multiTerm: false, summaryModels: [] };
      const a = fetchArgs(expr);
      fetched.push(a);
      if (a.url.includes("term/search")) return reply(a.url, opts.termSearchStatus ?? 200, '{"fwdURL":"/x"}');
      if (a.url.includes("getRegistrationEvents")) return reply(a.url, 200, "[]");
      return reply(a.url, 404, "");
    };
    const session = await loggedIn(browser, "live");
    afterLogin = true;
    return { ...session, browser, fetched };
  }

  test("selects the term in preReg mode, opens Prepare for Registration, and parses the ticket", async () => {
    const t = await ticketManager("Time Tickets\nRegistration Time Ticket\n11/09/2026 07:00 AM - 01/29/2027 11:59 PM");
    const parsed = await t.manager.readTicket("120271");
    expect(parsed).toEqual({ status: "found", windows: [{ start: "2026-11-09T13:00:00.000Z", end: "2027-01-30T05:59:00.000Z" }] });
    expect(t.fetched[0]).toMatchObject({ method: "POST", form: { term: "120271" } });
    expect(t.fetched[0]!.url).toEndWith("/term/search?mode=preReg");
    expect(t.browser.navigations).toEqual([PREP]);
    // Nothing else was requested: no registration endpoints.
    expect(t.fetched.length).toBe(1);
  });

  test.each<[string, { termSearchStatus?: number; landOn?: string }, string, string]>([
    ["leaving Banner means the session is gone", { landOn: "https://login.microsoftonline.com/x" }, "login_required", "cold"],
    ["a term search failure keeps the session", { termSearchStatus: 500 }, "term_search_failed", "warm"],
  ])("%s", async (_name, opts, reason, state) => {
    const t = await ticketManager("", opts);
    await expect(t.manager.readTicket("120271")).rejects.toThrow(reason);
    expect(t.manager.state()).toBe(state as never);
  });

  test("registration reads wait for a ticket read and re-select their term afterwards", async () => {
    const t = await ticketManager("Time Ticket 11/09/2026 07:00 AM");
    // Select the registration term first, as a warm session would have.
    await t.manager.eligibility("120271");
    t.fetched.length = 0;
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
    const t = await ticketManager("Time Ticket 11/09/2026 07:00 AM");
    await t.manager.writeApi().withAuthorizedBatch({ term: "120271", addCrns: ["11111"], dropCrn: null }, async () => {
      const before = t.fetched.length;
      await expect(t.manager.readTicket("120271")).rejects.toThrow("batch_in_flight");
      expect(t.fetched.length).toBe(before);
    });
  });
});

describe("Log out during login", () => {
  test("cancels the login: browser closed, state cold, no error and no backoff", async () => {
    const store = new Store(":memory:");
    const events = new Events(store, new Bus());
    const clock = new FakeClock();
    // A login page that never moves on, so login would sit in its wait loop until the timeout.
    const stuck = withCdp(new FakeBrowser(() => ({ url: "https://login.microsoftonline.com/common/login", title: "Sign in" })));
    // The retry lands straight on Banner.
    const ready = withCdp(new FakeBrowser(() => ({ url: REGISTRATION_PAGE, syncToken: true })));
    const browsers = [stuck, ready];
    const manager = new BannerSessionManager({
      config: makeConfig("rehearsal", { chromePath: null }),
      events,
      store,
      clock,
      settings: () => store.getSettings(),
      browserFactory: async () => browsers.shift()!,
      credentials: () => CREDS,
    });
    const warming = manager.ensureWarm("120271").catch(e => e);
    for (let i = 0; i < 20 && manager.state() !== "logging_in"; i++) await Promise.resolve();
    await clock.advance(2000);
    expect(manager.state()).toBe("logging_in");
    const loggingOut = manager.goCold("user");
    await clock.advance(1000);
    await loggingOut;
    const error = await warming;
    expect(String(error?.message ?? error)).toContain("login_cancelled");
    expect(manager.state()).toBe("cold");
    expect(manager.status().lastError).toBeNull();
    expect(stuck.closed).toBe(true);
    expect(store.listEvents().some(e => e.kind === "session_error")).toBe(false);
    // No backoff: the next login is allowed right away.
    await manager.login();
    expect(manager.state()).toBe("warm");
  });
});
