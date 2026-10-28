import { describe, expect, test } from "bun:test";
import { FakeClock } from "../../src/core/clock";
import { InvalidTotpSecret, TotpWindowTracker, isValidTotpSecret, totp, totpWindow } from "../../src/auth/totp";

// RFC 6238 Appendix B SHA-1 secret "12345678901234567890" in base32. Six digits: last six RFC digits.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  test("RFC 6238 SHA-1 vectors", () => {
    expect(totp(SECRET, 59_000)).toBe("287082");
    expect(totp(SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totp(SECRET, 1_111_111_111_000)).toBe("050471");
    expect(totp(SECRET, 1_234_567_890_000)).toBe("005924");
    expect(totp(SECRET, 2_000_000_000_000)).toBe("279037");
    expect(totp(SECRET, 20_000_000_000_000)).toBe("353130");
  });

  test("accepts lowercase, spaces and padding", () => {
    expect(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59_000)).toBe("287082");
  });

  test("rejects malformed or short seeds", () => {
    expect(() => totp("short")).toThrow(InvalidTotpSecret);
    expect(() => totp("INVALID!BASE32*SEED")).toThrow(InvalidTotpSecret);
    expect(isValidTotpSecret("")).toBe(false);
    expect(isValidTotpSecret(SECRET)).toBe(true);
  });
});

describe("TotpWindowTracker", () => {
  test("uses the current window early in the window", async () => {
    const clock = new FakeClock(30_000 * 1000 + 5_000);
    const tracker = new TotpWindowTracker();
    expect(await tracker.acquire(clock)).toBe(1000);
  });

  test("waits for the next edge when more than 22 s into the window", async () => {
    const start = 30_000 * 1000 + 23_000;
    const clock = new FakeClock(start);
    const tracker = new TotpWindowTracker();
    expect(tracker.waitMs(start)).toBeGreaterThan(6_000);
    const p = tracker.acquire(clock);
    await clock.advance(8_000);
    expect(await p).toBe(1001);
    expect(clock.now()).toBeGreaterThanOrEqual(30_000 * 1001);
  });

  test("never reuses a window", async () => {
    const clock = new FakeClock(30_000 * 2000 + 1_000);
    const tracker = new TotpWindowTracker();
    expect(await tracker.acquire(clock)).toBe(2000);
    expect(tracker.waitMs(clock.now())).toBeGreaterThan(0);
    let second: number | null = null;
    const p = tracker.acquire(clock).then(w => (second = w));
    await clock.advance(5_000);
    expect(second).toBeNull();
    await clock.advance(30_000);
    await p;
    expect(second!).toBe(2001);
    expect(totpWindow(clock.now())).toBe(2001);
  });

  test("abort stops the wait", async () => {
    const clock = new FakeClock(30_000 * 10 + 25_000);
    const tracker = new TotpWindowTracker();
    const ctl = new AbortController();
    const p = tracker.acquire(clock, ctl.signal);
    ctl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
