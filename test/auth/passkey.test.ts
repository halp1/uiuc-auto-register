import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { BrowserSession } from "../../src/auth/browser";
import { cancelPasskey } from "../../src/auth/page";

function fixture(options: {
  url?: string;
  heading?: string;
  label?: string;
  tag?: string;
  type?: string;
  disabled?: boolean;
  disabledCredential?: boolean;
  disabledCode?: boolean;
  inert?: boolean;
  credentialField?: boolean;
  appCode?: boolean;
} = {}) {
  let clicks = 0;
  let valueReads = 0;
  const element = (text = "") => ({
    disabled: false,
    hidden: false,
    parentElement: null,
    innerText: text,
    getClientRects: () => [{}],
    getAttribute: () => null as string | null,
  });
  const back = {
    ...element(),
    tagName: options.tag ?? "BUTTON",
    type: options.type ?? "button",
    disabled: options.disabled ?? false,
    getAttribute: (name: string) => name === "aria-label" ? options.label ?? "Back" : null,
    closest: () => options.inert ? {} : null,
    click: () => { clicks++; },
  };
  const heading = element(options.heading ?? "Face, fingerprint, PIN or security key");
  const input = { ...element(), disabled: options.disabledCredential ?? false };
  const appCode = { ...element(), disabled: options.disabledCode ?? false };
  for (const el of [back, input]) Object.defineProperty(el, "value", { get: () => {
    valueReads++;
    throw new Error("field values must not be read");
  } });
  const context = {
    location: new URL(options.url ?? "https://login.microsoft.com/tenant/fido/get"),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: {
      querySelector: (selector: string) => selector === "#loginHeader" ? heading : selector === "#idBtn_Back" ? back : null,
      querySelectorAll: (selector: string) => {
        if (selector === 'input[name="passwd"]') return options.credentialField ? [input] : [];
        if (selector === '[role="button"][data-value="PhoneAppOTP"]') return options.appCode ? [appCode] : [];
        return [];
      },
    },
  };
  const session = {
    closed: false,
    evaluate: async <T>(expr: string): Promise<T> => runInNewContext(expr, context) as T,
  } as BrowserSession;
  return { session, clicks: () => clicks, valueReads: () => valueReads };
}

describe("verified FIDO DOM cancellation", () => {
  test.each(["login.microsoft.com", "login.microsoftonline.com"])("only clicks the observed Back button on %s", async host => {
    const f = fixture({ url: `https://${host}/tenant/fido/get` });
    expect(await cancelPasskey(f.session)).toBe(true);
    expect(f.clicks()).toBe(1);
    expect(f.valueReads()).toBe(0);
  });

  test.each([
    { url: "https://attacker.example/tenant/fido/get" },
    { url: "http://login.microsoft.com/tenant/fido/get" },
    { url: "https://login.microsoft.com:444/tenant/fido/get" },
    { url: "https://user@login.microsoft.com/tenant/fido/get" },
    { url: "https://login.microsoft.com/tenant/login" },
    { heading: "Stay signed in?" },
    { heading: "Set up a passkey" },
    { label: "No" },
    { tag: "INPUT" },
    { type: "submit" },
    { disabled: true },
    { inert: true },
    { credentialField: true },
    { credentialField: true, disabledCredential: true },
    { appCode: true },
    { appCode: true, disabledCode: true },
  ])("fails closed outside the observed cancellation state: %j", async options => {
    const f = fixture(options);
    expect(await cancelPasskey(f.session)).toBe(false);
    expect(f.clicks()).toBe(0);
    expect(f.valueReads()).toBe(0);
  });
});
