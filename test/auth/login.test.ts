import { describe, expect, test } from "bun:test";
import { HumanActionRequired, LoginError, login, type Credentials } from "../../src/auth/login";
import { parseProbe } from "../../src/auth/page";
import { totp, TotpWindowTracker } from "../../src/auth/totp";
import { AutoClock, FakeBrowser, illinoisFlow, type FlowOptions, type PageName } from "./fake-browser";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CREDS: Credentials = { netid: "student7", password: "correct horse battery", totpSecret: SECRET };

function setup(extra: Partial<FlowOptions> = {}) {
  const clock = new AutoClock();
  const visited: PageName[] = [];
  const flow = illinoisFlow({ password: CREDS.password, expectedCode: () => totp(SECRET, clock.now()), visited, ...extra });
  const browser = new FakeBrowser(flow.start);
  return { clock, browser, visited, flow };
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
    expect(stages).toContain("password_submitted");
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

  test("a password form without Sign in never types", async () => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoftonline.com/common/login",
          fields: { passwd: {} },
          actions: [{ label: "Continue", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("a read-only password field is never typed", async () => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoftonline.com/common/login",
          fields: { passwd: { readOnly: true } },
          actions: [{ label: "Sign in", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("a submit without page progression never resubmits the password", async () => {
    let submissions = 0;
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoftonline.com/common/login",
          fields: { passwd: {} },
          actions: [{
            label: "Sign in",
            kind: "submit",
            onClick: () => {
              submissions++;
            },
          }],
        }),
      },
    });
    const stages: string[] = [];
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000, onStage: s => stages.push(s) }))).toBe("unsupported_mfa_or_timeout");
    expect(submissions).toBe(1);
    expect(passwordTypedOn(browser)).toHaveLength(1);
    expect(stages.at(-1)).toBe("password_submitted");
  });

  test("a delayed password response advances without a duplicate submission", async () => {
    let submissions = 0;
    let waitingSnapshots = 0;
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoftonline.com/common/login",
          fields: { passwd: {} },
          actions: [{
            label: "Sign in",
            kind: "submit",
            onClick: () => {
              submissions++;
            },
          }],
        }),
      },
    });
    browser.beforeProbe = (b, name) => {
      if (name === "snapshot" && submissions > 0 && ++waitingSnapshots >= 3) {
        b.show({ url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/term/termSelection", syncToken: true });
      }
    };
    await login(browser, CREDS, { clock });
    expect(submissions).toBe(1);
    expect(passwordTypedOn(browser)).toHaveLength(1);
    expect(waitingSnapshots).toBe(3);
  });

  test("failed clearing stops before typing a password into existing content", async () => {
    const { clock, browser } = setup();
    const evaluate = browser.evaluate.bind(browser);
    browser.evaluate = async <T>(expr: string): Promise<T> => {
      if (parseProbe(expr)?.name === "clearField" && browser.page.fields?.passwd) {
        browser.values.passwd = "existing-content";
        return false as T;
      }
      return evaluate<T>(expr);
    };
    expect(await reason(login(browser, CREDS, { clock }))).toBe("field_clear_failed");
    expect(passwordTypedOn(browser)).toEqual([]);
    expect(browser.values.passwd).toBe("existing-content");
  });

  test("persistent page-probe failures time out without resubmitting credentials", async () => {
    const { clock, browser } = setup({
      override: {
        push: () => ({ url: "https://login.microsoftonline.com/common/SAS/ProcessAuth" }),
      },
    });
    browser.beforeProbe = (b, name) => {
      if (name === "snapshot" && b.typed.some(t => t.field === "passwd")) throw new Error("page unavailable");
    };
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(passwordTypedOn(browser)).toHaveLength(1);
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

  test.each([
    "Use a verification code",
    "Use a verification code from my mobile app",
    "Code from my authenticator app",
    "Enter a code from an authenticator app",
  ])("selects a direct app-code picker without the exact heading: %s", async label => {
    let methodClicks = 0;
    const { clock, browser, flow } = setup({
      override: {
        push: () => ({
          url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
          flags: { verifyIdentity: false },
          actions: [{ label, kind: "button", onClick: b => {
            methodClicks++;
            b.show(flow.pages.otc(b));
          } }],
        }),
      },
    });
    const stages: string[] = [];
    await login(browser, CREDS, { clock, onStage: s => stages.push(s) });
    expect(methodClicks).toBe(1);
    expect(stages).toContain("mfa_method");
    expect(stages.at(-1)).toBe("ready");
    expect(passwordTypedOn(browser)).toHaveLength(1);
    expect(browser.typed.filter(t => t.field === "otc")).toHaveLength(1);
  });

  test("recognizes the alternate verification option link", async () => {
    let otherWayClicks = 0;
    const { clock, browser, flow } = setup({
      override: {
        push: () => ({
          url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
          actions: [{ label: "Use a different verification option", kind: "button", onClick: b => {
            otherWayClicks++;
            b.show(flow.pages.methods(b));
          } }],
        }),
      },
    });
    await login(browser, CREDS, { clock });
    expect(otherWayClicks).toBe(1);
    expect(browser.typed.filter(t => t.field === "otc")).toHaveLength(1);
  });

  test.each([
    "Text a verification code to my phone",
    "Email a verification code",
    "Call me with a verification code",
  ])("never selects an SMS/email/phone method as an app code: %s", async label => {
    let methodClicks = 0;
    const { clock, browser } = setup({
      override: {
        push: () => ({
          url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
          flags: { verifyIdentity: true },
          actions: [{ label, kind: "button", onClick: () => {
            methodClicks++;
          } }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock, timeoutMs: 20_000 }))).toBe("unsupported_mfa_or_timeout");
    expect(methodClicks).toBe(0);
    expect(browser.typed.some(t => t.field === "otc")).toBe(false);
  });

  test.each([
    ["security_info_required", "security_info_required"],
    ["password_change_required", "password_change_required"],
    ["access_blocked", "access_blocked"],
    ["sign_in_error", "microsoft_sign_in_error"],
    ["captcha", "captcha_required"],
  ] as const)("stops on %s before clicking a code-looking setup/security action", async (prompt, expected) => {
    let clicks = 0;
    const { clock, browser } = setup({
      override: {
        push: () => ({
          url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
          prompt,
          actions: [{ label: "Use a verification code", kind: "button", onClick: () => {
            clicks++;
          } }],
        }),
      },
    });
    const error = await login(browser, CREDS, { clock }).catch(e => e);
    expect(error).toBeInstanceOf(HumanActionRequired);
    expect(error.reason).toBe(expected);
    expect(clicks).toBe(0);
    expect(browser.typed.some(t => t.field === "otc")).toBe(false);
  });

  test.each([
    ["captcha", "captcha_required"],
    ["security_info_required", "security_info_required"],
    ["password_change_required", "password_change_required"],
  ] as const)("does not type into a credential form while %s is showing", async (prompt, expected) => {
    const { clock, browser } = setup({
      override: {
        password: () => ({
          url: "https://login.microsoftonline.com/common/login",
          prompt,
          fields: { passwd: {} },
          actions: [{ label: "Sign in", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock }))).toBe(expected);
    expect(passwordTypedOn(browser)).toEqual([]);
  });

  test("never types a TOTP into a delivered SMS/email code challenge", async () => {
    const { clock, browser } = setup({
      override: {
        push: () => ({
          url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
          prompt: "sms_or_email_code",
          fields: { otc: {} },
          actions: [{ label: "Verify", kind: "submit", onClick: () => {} }],
        }),
      },
    });
    expect(await reason(login(browser, CREDS, { clock }))).toBe("unsupported_mfa_method");
    expect(browser.typed.some(t => t.field === "otc")).toBe(false);
  });

  test("leaves the observed FIDO page once and completes an available app-code alternative", async () => {
    let backs = 0;
    const { clock, browser, flow } = setup({ override: {
      push: () => ({
        url: "https://login.microsoft.com/tenant/fido/get",
        prompt: "passkey",
        actions: [{ label: "Back", kind: "back", onClick: b => {
          backs++;
          b.show(flow.pages.methods(b));
        } }],
      }),
    } });
    const nativeClick = browser.click.bind(browser);
    browser.click = async selector => {
      const marked = browser.marks.get(selector);
      if (marked?.kind === "action" && marked.action.kind === "back" && /^back$/i.test(marked.action.label)) throw new Error("native FIDO Back input is intercepted");
      await nativeClick(selector);
    };
    const stages: string[] = [];
    await login(browser, CREDS, { clock, onStage: stage => stages.push(stage) });
    expect(backs).toBe(1);
    expect(browser.clicks).toContain("dom:#idBtn_Back");
    expect(stages).toContain("passkey_fallback");
    expect(stages.at(-1)).toBe("ready");
    expect(passwordTypedOn(browser)).toHaveLength(1);
    expect(browser.typed.filter(t => t.field === "otc")).toHaveLength(1);
  });

  test("a passkey Back button that makes no progress is never clicked twice", async () => {
    let backs = 0;
    const { clock, browser } = setup({ override: {
      push: () => ({
        url: "https://login.microsoft.com/tenant/fido/get",
        prompt: "passkey",
        actions: [{ label: "Back", kind: "back", onClick: () => { backs++; } }],
      }),
    } });
    expect(await reason(login(browser, CREDS, { clock }))).toBe("passkey_required");
    expect(backs).toBe(1);
    expect(passwordTypedOn(browser)).toHaveLength(1);
  });

  test("returning to the password form after cancelling passkey does not resubmit credentials", async () => {
    const { clock, browser, flow } = setup({ override: {
      push: () => ({
        url: "https://login.microsoft.com/tenant/fido/get",
        prompt: "passkey",
        actions: [{ label: "Back", kind: "back", onClick: b => b.show(flow.pages.password(b)) }],
      }),
    } });
    expect(await reason(login(browser, CREDS, { clock }))).toBe("passkey_required");
    expect(passwordTypedOn(browser)).toHaveLength(1);
    expect(browser.typed.some(t => t.field === "otc")).toBe(false);
  });

  test("missing or mislabeled Back fails closed on the FIDO screen", async () => {
    for (const label of ["Continue", "No"]) {
      let clicks = 0;
      const { clock, browser } = setup({ override: {
        push: () => ({
          url: "https://login.microsoft.com/tenant/fido/get",
          prompt: "passkey",
          actions: [{ label, kind: "back", onClick: () => { clicks++; } }],
        }),
      } });
      expect(await reason(login(browser, CREDS, { clock }))).toBe("passkey_required");
      expect(clicks).toBe(0);
    }
  });

  test("does not leave a method picker just because it also lists a passkey", async () => {
    let backs = 0;
    const { clock, browser, flow } = setup({ override: {
      push: () => ({
        url: "https://login.microsoft.com/tenant/fido/get",
        prompt: "passkey",
        actions: [
          { label: "Back", kind: "back", onClick: () => { backs++; } },
          { label: "Use a verification code", kind: "button", onClick: b => b.show(flow.pages.otc(b)) },
        ],
      }),
    } });
    await login(browser, CREDS, { clock });
    expect(backs).toBe(0);
    expect(browser.typed.filter(t => t.field === "otc")).toHaveLength(1);
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
