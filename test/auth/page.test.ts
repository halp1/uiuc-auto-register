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
    ["More information required", {}, "security_info_required"],
    ["Keep your account secure", {}, "security_info_required"],
    ["Your password has expired", {}, "password_change_required"],
    ["You can't get there from here", {}, "access_blocked"],
    ["AADSTS53003: Access has been blocked by Conditional Access policies", {}, "access_blocked"],
    ["Sorry, but we're having trouble signing you in. AADSTS50000", {}, "sign_in_error"],
    ["Sign in with a passkey", {}, "passkey"],
    ["Help us beat the robots", {}, "captcha"],
    ["Verify that you're human", {}, "captcha"],
    ["An unrecognized page", {}, "unrecognized"],
    // A visible CAPTCHA frame is recognized without reading its contents. A hidden one is ignored.
    ["", { captcha: true }, "captcha"],
    ["", { captcha: true, hiddenCaptcha: true }, "unrecognized"],
    // A delivered SMS/email code is distinct from an app-generated TOTP, but only with a code field.
    ["We've sent a verification code to your phone", { codeField: true }, "sms_or_email_code"],
    ["We texted a code to your phone", { codeField: true }, "sms_or_email_code"],
    ["Enter the code we sent to your email address", { codeField: true }, "sms_or_email_code"],
    ["We've sent a verification code to your phone", {}, "unrecognized"],
    ["Enter the code displayed in your Microsoft Authenticator app", { codeField: true }, "unrecognized"],
  ] as const)("classifies %j %j as %s", async (text, options, prompt) => {
    const snap = await snapshot(pageSession(text, options));
    expect(snap?.prompt).toBe(prompt);
    if ("codeField" in options) expect(snap?.fields.otc).toBe(true);
  });
});
