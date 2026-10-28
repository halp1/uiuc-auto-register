import { describe, expect, test } from "bun:test";
import { HumanActionRequired, LoginError, login, type Credentials } from "../../src/auth/login";
import { totp, TotpWindowTracker } from "../../src/auth/totp";
import { AutoClock, FakeBrowser, illinoisFlow, type FlowOptions, type PageName } from "./fake-browser";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CREDS: Credentials = { netid: "student7", password: "correct horse battery", totpSecret: SECRET };

function setup(extra: Partial<FlowOptions> = {}) {
  const clock = new AutoClock();
  const visited: PageName[] = [];
  const flow = illinoisFlow({ password: CREDS.password, expectedCode: () => totp(SECRET, clock.now()), visited, ...extra });
  const browser = new FakeBrowser(flow.start);
  return { clock, browser, visited };
}

function passwordTypedOn(browser: FakeBrowser): string[] {
  return browser.typed.filter(t => t.text === CREDS.password).map(t => t.host);
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoginError) return error.reason;
    throw error;
  }
  return "resolved";
}

describe("login", () => {
  test("full chain: idpproxy, Microsoft, password, another way, code, KMSI, Banner", async () => {
    const { clock, browser, visited } = setup();
    const stages: string[] = [];
    await login(browser, CREDS, { clock, onStage: s => stages.push(s) });
    expect(visited).toEqual(["idp", "netid", "password", "push", "methods", "otc", "kmsi", "banner"]);
    expect(stages).toContain("idp_discovery");
    expect(stages).toContain("password");
    expect(stages).toContain("totp");
    expect(stages.at(-1)).toBe("ready");
    expect(browser.typed.map(t => [t.host, t.field])).toEqual([
      ["idpproxy.uillinois.edu", "upn"],
      ["login.microsoftonline.com", "loginfmt"],
      ["login.microsoftonline.com", "passwd"],
      ["login.microsoftonline.com", "otc"],
    ]);
    expect(browser.typed[0]!.text).toBe("student7@illinois.edu");
    // Secrets never appear in any evaluated expression.
    for (const expr of browser.evaluated) {
      expect(expr).not.toContain(CREDS.password);
      expect(expr).not.toContain(SECRET);
    }
  });

  test("prefilled read-only NetID continues with Next", async () => {
    const { clock, browser, visited } = setup({ netidPrefilled: true, kmsi: false });
    await login(browser, CREDS, { clock });
    expect(visited.at(-1)).toBe("banner");
    expect(browser.typed.some(t => t.field === "loginfmt")).toBe(false);
  });

  test("password field on a non-Microsoft host is never typed", async () => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.evil-example.com/common/login",
          fields: { passwd: {} },
          actions: [{ label: "Sign in", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    const error = await login(browser, CREDS, { clock, unknownHostMs: 5_000 }).catch(e => e);
    expect(error).toBeInstanceOf(HumanActionRequired);
    expect(error.reason).toBe("unexpected_host");
    expect(passwordTypedOn(browser)).toEqual([]);
    expect(String(error.message)).not.toContain("evil");
  });

  test("password field on the idpproxy host is never typed", async () => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://idpproxy.uillinois.edu/login",
          fields: { passwd: {} },
          actions: [{ label: "Sign in", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("password field on login.microsoft.com (not the password host) is never typed", async () => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoft.com/common/login",
          fields: { passwd: {} },
          actions: [{ label: "Sign in", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("host changes between focus and typing: nothing typed", async () => {
    const { clock, browser } = setup();
    browser.beforeProbe = (b, name) => {
      if (name === "focusCheck" && b.page.fields?.passwd) b.page = { ...b.page, url: "https://attacker.example.net/x" };
    };
    expect(await reason(login(browser, CREDS, { clock }))).toBe("focus_failed");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("unexpected host raises HumanActionRequired with a fixed reason", async () => {
    const { clock, browser } = setup({
      override: { push: () => ({ url: "https://duo.example.org/frame", actions: [] }) },
    });
    const error = await login(browser, CREDS, { clock }).catch(e => e);
    expect(error).toBeInstanceOf(HumanActionRequired);
    expect(error.reason).toBe("unexpected_host");
    expect(error.message).toBe("Sign-in requires human action (unexpected_host)");
  });

  test("a mislabeled Next button stops before the password", async () => {
    const { clock, browser } = setup({
      override: {
        netid: () => ({
          url: "https://login.microsoftonline.com/common/oauth2/authorize",
          fields: { loginfmt: {} },
          actions: [{ label: "Submit", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock }))).toBe("button_not_found");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("a rejected password is reported and not retried", async () => {
    const { clock, browser } = setup({ password: "something else" });
    expect(await reason(login(browser, CREDS, { clock }))).toBe("password_rejected");
    expect(passwordTypedOn(browser).length).toBe(1);
  });

  test("TOTP is typed only on auth hosts", async () => {
    const { clock, browser } = setup({
      override: {
        push: () => ({ url: "https://idpproxy.uillinois.edu/otp", fields: { otc: {} }, actions: [{ label: "Verify", kind: "submit", onClick: () => {} }] }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(browser.typed.some(t => t.field === "otc")).toBe(false);
  });

  test("a TOTP window already used is not reused", async () => {
    const { clock, browser } = setup({ kmsi: false });
    const tracker = new TotpWindowTracker();
    // Pretend the current window was used by an earlier login.
    await tracker.acquire(clock);
    const used = tracker.lastWindow()!;
    await login(browser, CREDS, { clock, tracker });
    expect(tracker.lastWindow()!).toBeGreaterThan(used);
  });

  test("missing credentials fail before navigating", async () => {
    const { clock, browser } = setup();
    expect(await reason(login(browser, null, { clock }))).toBe("missing_credentials");
    expect(await reason(login(browser, { ...CREDS, totpSecret: "bad" }, { clock }))).toBe("invalid_totp_secret");
    expect(browser.navigations).toEqual([]);
  });

  test("abort stops the flow", async () => {
    const { clock, browser } = setup();
    const ctl = new AbortController();
    ctl.abort();
    expect(await reason(login(browser, CREDS, { clock, signal: ctl.signal }))).toBe("aborted");
  });
});
