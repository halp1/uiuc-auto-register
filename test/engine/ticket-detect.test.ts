import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import { Store, defaultSettings } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { Settings, SystemStatus, TicketParse } from "../../src/core/types";
import { chicagoToMs, currentWindow, parseTicket, ticketText } from "../../src/banner/ticket";
import { DETECT_EVERY_MS, DETECT_FIRST_DELAY_MS, TicketDetectError, TicketDetector } from "../../src/engine/ticket-detect";

const iso = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(chicagoToMs(y, mo, d, h, mi)!).toISOString();

describe("parseTicket", () => {
  const BANNER_PAGE = `Prepare for Registration
Spring 2027
Registration Status
You have no holds which prevent registration.
Time Tickets
Registration Time Ticket
11/09/2026 07:00 AM - 01/29/2027 11:59 PM
Academic Standing: Good Standing`;
  // CST is UTC-6.
  const winter = { start: "2026-11-09T13:00:00.000Z", end: "2027-01-30T05:59:00.000Z" };

  test.each([
    ["Banner page with a range (CST)", BANNER_PAGE, [winter]],
    [
      "named months, 'at' times, CDT",
      "Your registration time ticket: April 2, 2027 at 9:30 AM through May 1, 2027 at 5:00 PM",
      [{ start: "2027-04-02T14:30:00.000Z", end: "2027-05-01T22:00:00.000Z" }],
    ],
    [
      "several windows sorted, duplicates removed",
      "Time Ticket 12/01/2026 08:00 AM - 12/05/2026 11:59 PM Time Ticket 11/09/2026 07:00 AM - 11/20/2026 11:59 PM Time Ticket 12/01/2026 08:00 AM - 12/05/2026 11:59 PM",
      [
        { start: iso(2026, 11, 9, 7), end: iso(2026, 11, 20, 23, 59) },
        { start: iso(2026, 12, 1, 8), end: iso(2026, 12, 5, 23, 59) },
      ],
    ],
    [
      "HTML stripped, entity dash read as a range",
      ticketText("<div><h3>Time Ticket</h3><span>11/09/2026 07:00 AM</span> &ndash; <span>01/29/2027 11:59 PM</span></div>"),
      [winter],
    ],
  ])("found: %s", (_label, text, windows) => {
    expect(parseTicket(text)).toEqual({ status: "found", windows });
  });

  test("JSON keys act as labels", () => {
    const json = JSON.stringify({ data: [{ timeTicketStart: "11/09/2026 07:00 AM", timeTicketEnd: "01/29/2027 11:59 PM" }] });
    const parsed = parseTicket(ticketText(json)) as Extract<TicketParse, { status: "found" }>;
    expect(parsed.status).toBe("found");
    expect(parsed.windows[0]!.start).toBe(winter.start);
  });

  const filler = "x".repeat(600);
  test.each([
    ["empty", ""],
    ["unrelated", "Holds: none"],
    ["date far before the label", `Term begins 01/19/2027 08:00 AM ${filler} Time Ticket`],
    ["date far after the label", `Time Ticket ${filler} Term begins 01/19/2027 08:00 AM`],
    ["date-only values near the label", "Time Tickets  Part of term dates 01/19/2027 - 05/05/2027"],
  ])("unreadable: %s", (_label, text) => {
    expect(parseTicket(text)).toEqual({ status: "unreadable" });
  });

  test.each(["Time Tickets\nYou have no time ticket for this term.", "You do not have a registration time ticket."])("none: %p", text => {
    expect(parseTicket(text)).toEqual({ status: "none" });
  });
});

describe("currentWindow", () => {
  const a = { start: iso(2026, 11, 9, 7), end: iso(2026, 11, 20, 23, 59) };
  const b = { start: iso(2026, 12, 1, 8), end: iso(2026, 12, 5, 23, 59) };
  test.each([
    ["before both picks the first", chicagoToMs(2026, 10, 28, 12)!, a],
    ["inside the first picks it", chicagoToMs(2026, 11, 10, 12)!, a],
    ["between them picks the next", chicagoToMs(2026, 11, 25, 12)!, b],
    ["after both is null", chicagoToMs(2026, 12, 9, 12)!, null],
  ])("%s", (_label, now, expected) => {
    expect(currentWindow([a, b], now)).toEqual(expected);
  });
});

function setup(read: ((term: string) => Promise<TicketParse>) | null, start = Date.UTC(2026, 9, 28, 17, 0)) {
  const clock = new FakeClock(start);
  const store = new Store(":memory:");
  const events = new Events(store, new Bus());
  let settings: Settings = { ...defaultSettings(), activeTerm: "120271", netid: "student7", password: "pw", totpSecret: "JBSWY3DPEHPK3PXP" };
  let phase: SystemStatus["ticket"]["phase"] = "none";
  const reads: string[] = [];
  const detector = new TicketDetector({
    clock,
    settings: () => settings,
    applySettings: patch => (settings = { ...settings, ...patch }),
    events,
    readTicket: read
      ? term => {
          reads.push(term);
          return read(term);
        }
      : null,
    ticketPhase: () => phase,
  });
  return {
    clock,
    store,
    detector,
    reads,
    get settings() {
      return settings;
    },
    set: (patch: Partial<Settings>) => (settings = { ...settings, ...patch }),
    phase: (p: SystemStatus["ticket"]["phase"]) => (phase = p),
  };
}

const found = (start: string, end: string | null = null): TicketParse => ({ status: "found", windows: [{ start, end }] });

describe("TicketDetector", () => {
  test("no automatic check before setup saves a login", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7)));
    t.set({ password: null });
    t.detector.start();
    await t.clock.advance(DETECT_FIRST_DELAY_MS + DETECT_EVERY_MS);
    expect(t.reads).toEqual([]);
    t.detector.stop();
  });

  test("automatic check applies the ticket and records the source", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7), iso(2027, 1, 29, 23, 59)));
    t.detector.start();
    await t.clock.advance(DETECT_FIRST_DELAY_MS);
    expect(t.reads).toEqual(["120271"]);
    expect(t.settings).toMatchObject({ ticketAt: iso(2026, 11, 9, 7), ticketSource: "banner", ticketCheckedTerm: "120271" });
    expect(t.store.listEvents().some(e => (e.payload as { ticketAt?: string } | null)?.ticketAt === iso(2026, 11, 9, 7))).toBe(true);
    await t.clock.advance(DETECT_EVERY_MS);
    expect(t.reads.length).toBe(2);
    t.detector.stop();
  });

  test("auto off: no automatic reads, a manual check applies and turns auto back on", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7)));
    t.set({ ticketAuto: false, ticketAt: iso(2026, 11, 10, 8), ticketSource: "manual" });
    t.detector.start();
    await t.clock.advance(DETECT_FIRST_DELAY_MS * 2);
    expect(t.reads).toEqual([]);
    const result = await t.detector.detect("120271", { manual: true });
    expect(result).toMatchObject({ found: true, applied: true, ticketAt: iso(2026, 11, 9, 7) });
    expect(t.settings).toMatchObject({ ticketAuto: true, ticketSource: "banner" });
    t.detector.stop();
  });

  test("a different term than the active one is read but never applied", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7)));
    const result = await t.detector.detect("120268", { manual: true });
    expect(result.applied).toBe(false);
    expect(t.settings.ticketAt).toBeNull();
  });

  test("Banner saying there is no ticket clears only a ticket that came from Banner", async () => {
    const t = setup(async () => ({ status: "none" }));
    t.set({ ticketAt: iso(2026, 11, 9, 7), ticketSource: "manual" });
    await t.detector.detect("120271", { manual: false }).catch(() => {});
    expect(t.settings.ticketAt).toBe(iso(2026, 11, 9, 7));
    t.set({ ticketSource: "banner" });
    await t.detector.detect("120271", { manual: false });
    expect(t.settings).toMatchObject({ ticketAt: null, ticketSource: null });
  });

  test("unreadable pages change nothing but the checked time", async () => {
    const t = setup(async () => ({ status: "unreadable" }));
    t.set({ ticketAt: iso(2026, 11, 9, 7), ticketSource: "banner" });
    const result = await t.detector.detect("120271", { manual: true });
    expect(result).toMatchObject({ found: false, applied: false });
    expect(t.settings.ticketAt).toBe(iso(2026, 11, 9, 7));
    expect(t.settings.ticketCheckedAt).toBe(t.clock.now());
  });

  test("never reads near the ticket", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7)));
    t.set({ ticketAt: new Date(t.clock.now() + 10 * 60 * 1000).toISOString() });
    expect(() => t.detector.detect("120271", { manual: true })).toThrow(TicketDetectError);
    t.set({ ticketAt: null });
    t.phase("firing");
    expect(() => t.detector.detect("120271", { manual: true })).toThrow(TicketDetectError);
    t.phase("none");
    expect(t.reads).toEqual([]);
  });

  test("read failures surface as a 502 and leave settings alone", async () => {
    const t = setup(async () => {
      throw Object.assign(new Error("x"), { reason: "login_required" });
    });
    const error = await t.detector.detect("120271", { manual: true }).catch(e => e);
    expect(error).toBeInstanceOf(TicketDetectError);
    expect(error.status).toBe(502);
    expect(t.settings.ticketCheckedAt).toBeNull();
  });

  test("after Log out only a manual check reads", async () => {
    const t = setup(async () => found(iso(2026, 11, 9, 7)));
    t.set({ sessionLoggedOut: true });
    t.detector.start();
    await t.clock.advance(DETECT_FIRST_DELAY_MS * 2);
    expect(t.reads).toEqual([]);
    await t.detector.detect("120271", { manual: true });
    expect(t.reads).toEqual(["120271"]);
    t.detector.stop();
  });

  test("simulated mode has no reader", () => {
    const t = setup(null);
    expect(() => t.detector.detect("120271", { manual: true })).toThrow(TicketDetectError);
  });

  test("concurrent checks share one read", async () => {
    let release!: (v: TicketParse) => void;
    const t = setup(() => new Promise(resolve => (release = resolve)));
    const a = t.detector.detect("120271", { manual: true });
    const b = t.detector.detect("120271", { manual: true });
    release(found(iso(2026, 11, 9, 7)));
    expect(await a).toBe(await b);
    expect(t.reads.length).toBe(1);
  });
});
