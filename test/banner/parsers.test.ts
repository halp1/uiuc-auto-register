import { describe, expect, test } from "bun:test";
import { SeatSourceError } from "../../src/core/contracts";
import { AnonymousSeatSource, parseEnrollmentInfo, parseRetryAfter } from "../../src/banner/enrollment";
import { LinkedSections, parseLinkedSections } from "../../src/banner/linked";
import { Store } from "../../src/core/db";

const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();

describe("parseEnrollmentInfo", () => {
  test("reads the live fragment", async () => {
    expect(parseEnrollmentInfo(await fixture("enrollment-59777.html"))).toEqual({ enrolled: 0, max: 400, available: 400 });
    expect(parseEnrollmentInfo(await fixture("enrollment-65054.html"))).toEqual({ enrolled: 61, max: 100, available: 39 });
  });

  test("returns null for pages without the labels", () => {
    expect(parseEnrollmentInfo("<html><title>Banner</title></html>")).toBeNull();
  });
});

describe("parseLinkedSections", () => {
  test("groups options", async () => {
    const options = parseLinkedSections(await fixture("linked-59777.html"));
    expect(options).toEqual([["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]]);
  });

  test("empty when no linked sections", async () => {
    expect(parseLinkedSections(await fixture("linked-empty.html"))).toEqual([]);
  });

  test("null for unrelated pages", () => {
    expect(parseLinkedSections("<html>login</html>")).toBeNull();
  });
});

test("parseRetryAfter", () => {
  expect(parseRetryAfter("30")).toBe(30_000);
  expect(parseRetryAfter(null)).toBeNull();
  expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
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

  test("login redirect throws login_required", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://eis.apps.uillinois.edu/saml2/authenticate" } }));
    const source = new AnonymousSeatSource({ fetch: fn, spreadMs: 0 });
    const error = await source.fetchSeats("120271", ["11111", "22222"]).catch(e => e);
    expect(error).toBeInstanceOf(SeatSourceError);
    expect(error.reason).toBe("login_required");
  });

  test("429 throws rate_limited with Retry-After", async () => {
    const { fn } = fakeFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "45" } }));
    const error = await new AnonymousSeatSource({ fetch: fn, spreadMs: 0 }).fetchSeats("120271", ["11111"]).catch(e => e);
    expect(error.reason).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(45_000);
  });

  test("all 5xx throws server_error, labels missing on 200 throws login_required", async () => {
    const down = fakeFetch(() => new Response("oops", { status: 503 }));
    expect((await new AnonymousSeatSource({ fetch: down.fn, spreadMs: 0 }).fetchSeats("120271", ["1", "2"]).catch(e => e)).reason).toBe(
      "server_error",
    );
    const weird = fakeFetch(() => new Response("<html>Sign in</html>"));
    expect((await new AnonymousSeatSource({ fetch: weird.fn, spreadMs: 0 }).fetchSeats("120271", ["1"]).catch(e => e)).reason).toBe(
      "login_required",
    );
  });

  test("network errors on every CRN throw network", async () => {
    const source = new AnonymousSeatSource({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      spreadMs: 0,
    });
    expect((await source.fetchSeats("120271", ["1"]).catch(e => e)).reason).toBe("network");
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
