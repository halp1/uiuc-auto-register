import { describe, expect, test } from "bun:test";
import { SeatSourceError } from "../../src/core/contracts";
import { AnonymousSeatSource, parseEnrollmentInfo, parseRetryAfter } from "../../src/banner/enrollment";
import { LinkedSections, parseLinkedSections } from "../../src/banner/linked";
import { Store } from "../../src/core/db";

const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();

test.each([
  ["enrollment-59777.html", { enrolled: 0, max: 400, available: 400 }],
  ["enrollment-65054.html", { enrolled: 61, max: 100, available: 39 }],
])("parseEnrollmentInfo reads %s", async (name, expected) => {
  expect(parseEnrollmentInfo(await fixture(name))).toEqual(expected);
});

test("parseLinkedSections groups options, empty when none, null for unrelated pages", async () => {
  expect(parseLinkedSections(await fixture("linked-59777.html"))).toEqual([["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]]);
  expect(parseLinkedSections(await fixture("linked-empty.html"))).toEqual([]);
  expect(parseLinkedSections("<html>login</html>")).toBeNull();
  expect(parseEnrollmentInfo("<html><title>Banner</title></html>")).toBeNull();
});

test.each([
  ["seconds", "30", undefined, 30_000],
  ["missing", null, undefined, null],
  ["HTTP date", new Date(10_000).toUTCString(), 0, 10_000],
] as const)("parseRetryAfter: %s", (_name, header, now, expected) => {
  expect(parseRetryAfter(header, now)).toBe(expected);
});

type Handler = (url: URL) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = async (input: string, init?: RequestInit) => {
    calls.push(input);
    expect(init?.redirect).toBe("manual");
    return handler(new URL(input));
  };
  return { fn, calls };
}

describe("AnonymousSeatSource", () => {
  const enrollment = (enrolled: number, max: number) =>
    `<span class="status-bold">Enrollment Actual:</span> <span dir="ltr">${enrolled}</span><br/>
     <span class="status-bold">Enrollment Maximum:</span> <span dir="ltr">${max}</span><br/>
     <span class="status-bold">Enrollment Seats Available:</span> <span dir="ltr">${max - enrolled}</span>`;

  test("fetches every CRN with mepCode and skips individual failures", async () => {
    const { fn, calls } = fakeFetch(url => {
      const crn = url.searchParams.get("courseReferenceNumber")!;
      if (crn === "99999") return new Response("No such section", { status: 500 });
      return new Response(enrollment(crn === "11111" ? 10 : 30, 30));
    });
    const source = new AnonymousSeatSource({ fetch: fn, spreadMs: 0, now: () => 5 });
    const seats = await source.fetchSeats("120271", ["11111", "22222", "99999"]);
    expect(seats.map(seat => seat.crn).sort()).toEqual(["11111", "22222"]);
    expect(seats.find(seat => seat.crn === "11111")).toEqual({ term: "120271", crn: "11111", enrolled: 10, max: 30, available: 20, checkedAt: 5 });
    expect(calls.every(call => call.includes("mepCode=1UIUC") && call.includes("term=120271"))).toBe(true);
  });

  test("caps concurrency at 3", async () => {
    let active = 0;
    let peak = 0;
    const { fn } = fakeFetch(async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return new Response(enrollment(1, 2));
    });
    const source = new AnonymousSeatSource({ fetch: fn, spreadMs: 0 });
    const crns = Array.from({ length: 10 }, (_, i) => String(10000 + i));
    expect((await source.fetchSeats("120271", crns)).length).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test.each([
    ["login redirect", () => new Response(null, { status: 302, headers: { location: "https://eis.apps.uillinois.edu/saml2/authenticate" } }), "login_required"],
    ["labels missing on 200", () => new Response("<html>Sign in</html>"), "login_required"],
    ["every CRN 5xx", () => new Response("oops", { status: 503 }), "server_error"],
    ["429", () => new Response("slow down", { status: 429, headers: { "retry-after": "45" } }), "rate_limited"],
    ["network error", () => Promise.reject(new TypeError("fetch failed")), "network"],
  ] as const)("%s throws %s", async (_name, respond, reason) => {
    const { fn } = fakeFetch(respond);
    const error = await new AnonymousSeatSource({ fetch: fn, spreadMs: 0 }).fetchSeats("120271", ["11111", "22222"]).catch(e => e);
    expect(error).toBeInstanceOf(SeatSourceError);
    expect(error.reason).toBe(reason);
    if (reason === "rate_limited") expect(error.retryAfterMs).toBe(45_000);
  });

  test("empty input makes no requests", async () => {
    const { fn, calls } = fakeFetch(() => new Response(""));
    expect(await new AnonymousSeatSource({ fetch: fn }).fetchSeats("120271", [])).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe("LinkedSections cache", () => {
  test("fetches once within 24 h and refetches after", async () => {
    const store = new Store(":memory:");
    const html = await fixture("linked-59777.html");
    let now = 1_000;
    let calls = 0;
    const linked = new LinkedSections(store, {
      now: () => now,
      fetch: async input => {
        calls++;
        expect(input).toContain("getLinkedSections");
        expect(input).toContain("mepCode=1UIUC");
        return new Response(html);
      },
    });
    expect((await linked.get("120271", "59777"))?.length).toBe(7);
    expect((await linked.get("120271", "59777"))?.length).toBe(7);
    expect(calls).toBe(1);
    now += 25 * 3600_000;
    await linked.get("120271", "59777");
    expect(calls).toBe(2);
  });

  test("keeps stale cache when the refetch fails", async () => {
    const store = new Store(":memory:");
    let now = 0;
    let fail = false;
    const linked = new LinkedSections(store, {
      now: () => now,
      fetch: async () => (fail ? new Response("err", { status: 500 }) : new Response(`<section aria-labelledby="linked">No linked course information available.</section>`)),
    });
    expect(await linked.get("120271", "30772")).toEqual([]);
    fail = true;
    now += 48 * 3600_000;
    expect(await linked.get("120271", "30772")).toEqual([]);
    expect(await linked.get("120271", "11111")).toBeNull();
  });
});
