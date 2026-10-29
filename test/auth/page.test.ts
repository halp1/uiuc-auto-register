import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { BrowserSession } from "../../src/auth/browser";
import { snapshot } from "../../src/auth/page";

// Execute the actual page-side probe, rather than FakeBrowser's replacement implementation.
// This small DOM stub is only for prompt classification, not native input or layout testing.
function pageSession(text: string, options: { codeField?: boolean; captcha?: boolean; hiddenCaptcha?: boolean } = {}): BrowserSession {
  const element = (hidden = false) => ({
    disabled: false,
    hidden,
    parentElement: null,
    value: "fixture-value",
    getClientRects: () => hidden ? [] : [{}],
    getAttribute: () => null,
  });
  const code = element();
  const challenge = element(options.hiddenCaptcha);
  return {
    closed: false,
    evaluate: async <T>(expr: string): Promise<T> => runInNewContext(expr, {
      location: { hostname: "login.microsoftonline.com", protocol: "https:", port: "", username: "", password: "" },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      document: {
        title: "Sign in",
        readyState: "complete",
        body: { innerText: text },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector.includes("iframe[src*=")) return options.captcha ? [challenge] : [];
          if (selector === 'input[name="otc"]') return options.codeField ? [code] : [];
          return [];
        },
      },
    }) as T,
  } as BrowserSession;
}

describe("page-side prompt classification", () => {
  test.each([
    ["Approve sign in request", "push_approval"],
    ["We've sent a notification to your mobile device", "push_approval"],
    ["More information required", "security_info_required"],
    ["Keep your account secure", "security_info_required"],
    ["Your password has expired", "password_change_required"],
    ["You can't get there from here", "access_blocked"],
    ["AADSTS53003: Access has been blocked by Conditional Access policies", "access_blocked"],
    ["Sorry, but we're having trouble signing you in. AADSTS50000", "sign_in_error"],
    ["Sign in with a passkey", "passkey"],
    ["Help us beat the robots", "captcha"],
    ["Verify that you're human", "captcha"],
    ["An unrecognized page", "unrecognized"],
  ] as const)("classifies %s as %s", async (text, prompt) => {
    expect((await snapshot(pageSession(text)))?.prompt).toBe(prompt);
  });

  test("visible CAPTCHA is recognized without reading its contents", async () => {
    expect((await snapshot(pageSession("", { captcha: true })))?.prompt).toBe("captcha");
    expect((await snapshot(pageSession("", { captcha: true, hiddenCaptcha: true })))?.prompt).toBe("unrecognized");
  });

  test.each([
    "We've sent a verification code to your phone",
    "We texted a code to your phone",
    "Enter the code we sent to your email address",
  ])("recognizes a delivered code instead of an app-generated TOTP: %s", async text => {
    expect((await snapshot(pageSession(text, { codeField: true })))?.prompt).toBe("sms_or_email_code");
    expect((await snapshot(pageSession(text)))?.prompt).toBe("unrecognized");
  });

  test("normal app-code instructions are not treated as delivered SMS/email", async () => {
    const snap = await snapshot(pageSession("Enter the code displayed in your Microsoft Authenticator app", { codeField: true }));
    expect(snap?.fields.otc).toBe(true);
    expect(snap?.prompt).toBe("unrecognized");
  });
});
