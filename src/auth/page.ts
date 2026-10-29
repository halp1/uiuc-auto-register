// In-page probes used by the login flow. Every probe is a tagged expression:
//   /*uar:<name>*/(<function source>).apply(null, <JSON args>)
// The tag lets the test fake recognize probes without a DOM. Args are never secrets.

import type { BrowserSession } from "./browser";

export type ProbeName = "snapshot" | "markField" | "markAction" | "focusCheck" | "clearField" | "fieldFilled";

function tagged(name: ProbeName, fn: string, args: unknown[]): string {
  return `/*uar:${name}*/(${fn}).apply(null, ${JSON.stringify(args)})`;
}

/** Parse a tagged probe expression (used by test fakes). */
export function parseProbe(expr: string): { name: ProbeName; args: unknown[] } | null {
  const match = /^\/\*uar:(\w+)\*\//.exec(expr);
  if (!match) return null;
  const at = expr.lastIndexOf(".apply(null, ");
  if (at < 0) return null;
  const argsJson = expr.slice(at + ".apply(null, ".length, -1);
  return { name: match[1] as ProbeName, args: JSON.parse(argsJson) };
}

export type SignInPrompt =
  | "unrecognized"
  | "captcha"
  | "security_info_required"
  | "password_change_required"
  | "access_blocked"
  | "sign_in_error"
  | "sms_or_email_code"
  | "push_approval"
  | "passkey";

export interface PageSnapshot {
  host: string;
  secure: boolean; // https, default port
  title: string;
  ready: boolean;
  fields: { upn: boolean; loginfmt: boolean; loginfmtFilled: boolean; passwd: boolean; otc: boolean };
  actions: string[]; // visible action labels
  syncToken: boolean;
  prompt: SignInPrompt;
  flags: {
    passwordError: boolean;
    emptyPassword: boolean;
    otcError: boolean;
    kmsi: boolean;
    verifyIdentity: boolean;
    signInReady: boolean; // visible passwd and a visible "Sign in" submit
  };
}

export const OTC_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="otc"]',
  'input[id="idTxtBx_SAOTCC_OTC"]',
  'input[name*="otc" i]',
];
export const UPN_SELECTORS = ['input[name="upn"]'];
export const LOGINFMT_SELECTORS = ['input[name="loginfmt"]', 'input[type="email"]'];
export const PASSWD_SELECTORS = ['input[name="passwd"]'];
export const SUBMIT_SELECTORS = ["#idSIButton9", 'input[type="submit"]', 'button[type="submit"]'];
export const ACTION_SELECTORS = ['button', "a", '[role="button"]', 'input[type="button"]', 'input[type="submit"]'];

// Shared page-side helpers, inlined into each probe.
const HELPERS = `
  const visible = el => {
    if (!el || el.disabled || el.getClientRects().length === 0) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const firstVisible = selectors => {
    for (const selector of selectors) for (const el of document.querySelectorAll(selector)) if (visible(el)) return el;
    return null;
  };
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
`;

const SNAPSHOT_FN = `function (sel) {
  ${HELPERS}
  const text = (document.body && document.body.innerText) || '';
  const passwd = firstVisible(sel.passwd);
  const loginfmt = firstVisible(sel.loginfmt);
  const otc = firstVisible(sel.otc);
  // Only return fixed categories, never the body text or challenge contents.
  let prompt = 'unrecognized';
  const captcha = Array.from(document.querySelectorAll('iframe[src*="captcha" i], iframe[title*="captcha" i], [data-sitekey]')).some(visible);
  if (captcha || /prove you.re (?:not a robot|human)|verify (?:that )?you.re human|help us beat the robots|enter the characters you see/i.test(text)) prompt = 'captcha';
  else if (/you cannot access this right now|you can.t get there from here|access has been blocked|your sign.in was blocked|AADSTS5300[0-3]/i.test(text)) prompt = 'access_blocked';
  else if (/your password has expired|(?:update|change) your password/i.test(text)) prompt = 'password_change_required';
  else if (/more information required|keep your account secure|your organization needs more information|set up (?:your )?security info/i.test(text)) prompt = 'security_info_required';
  else if (/sorry, but we.re having trouble signing you in|something went wrong|AADSTS[0-9]{5,}/i.test(text)) prompt = 'sign_in_error';
  else if (otc && /we(?:.ve| have)? (?:sent|texted|emailed) (?:you )?(?:a |the )?(?:verification |security )?code|enter (?:the )?code (?:we|that we) (?:sent|texted|emailed)|code (?:sent|texted|emailed) to (?:your |the )?(?:email|phone)/i.test(text)) prompt = 'sms_or_email_code';
  else if (/approve (?:the )?sign.?in request|check your (?:microsoft )?authenticator app|we.ve sent a notification|open your authenticator app/i.test(text)) prompt = 'push_approval';
  else if (/sign in with (?:a )?passkey|face, fingerprint, pin or security key|insert your security key/i.test(text)) prompt = 'passkey';
  const actions = [];
  for (const selector of sel.action) for (const el of document.querySelectorAll(selector)) {
    if (actions.length >= 40) break;
    if (visible(el)) { const l = label(el); if (l && l.length <= 80) actions.push(l); }
  }
  const submitLabels = [];
  for (const selector of sel.submit) for (const el of document.querySelectorAll(selector)) if (visible(el)) submitLabels.push(label(el));
  return {
    host: location.hostname,
    secure: location.protocol === 'https:' && !location.port && !location.username && !location.password,
    title: document.title || '',
    ready: document.readyState !== 'loading',
    fields: {
      upn: Boolean(firstVisible(sel.upn)),
      loginfmt: Boolean(loginfmt),
      loginfmtFilled: Boolean(loginfmt && loginfmt.value),
      passwd: Boolean(passwd),
      otc: Boolean(otc),
    },
    actions,
    syncToken: Boolean(document.querySelector('meta[name="synchronizerToken"]')),
    prompt,
    flags: {
      passwordError: /your account or password is incorrect|password is incorrect|account (?:is|has been) locked/i.test(text),
      emptyPassword: text.includes('Please enter your password.') && !(passwd && passwd.value),
      otcError: /didn.t enter the expected verification code|code didn.t work|incorrect code|that code is not correct/i.test(text),
      kmsi: /stay signed in\\?/i.test(text) && Boolean(document.querySelector('#idBtn_Back')),
      verifyIdentity: /verify your identity/i.test(text),
      signInReady: Boolean(passwd) && submitLabels.some(l => /^sign in$/i.test(l)),
    },
  };
}`;

const MARK_FIELD_FN = `function (selectors, nonce) {
  ${HELPERS}
  for (const old of document.querySelectorAll('[data-uar-mark]')) old.removeAttribute('data-uar-mark');
  const el = firstVisible(selectors);
  if (!el || el.readOnly) return null;
  el.setAttribute('data-uar-mark', nonce);
  return '[data-uar-mark="' + nonce + '"]';
}`;

const MARK_ACTION_FN = `function (selectors, source, flags, nonce) {
  ${HELPERS}
  const pattern = new RegExp(source, flags);
  for (const old of document.querySelectorAll('[data-uar-mark]')) old.removeAttribute('data-uar-mark');
  for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
    if (visible(el) && pattern.test(label(el))) {
      el.setAttribute('data-uar-mark', nonce);
      return '[data-uar-mark="' + nonce + '"]';
    }
  }
  return null;
}`;

const FOCUS_CHECK_FN = `function (mark, hosts) {
  const el = document.activeElement;
  return Boolean(el && el.matches(mark)) && hosts.includes(location.hostname) &&
    location.protocol === 'https:' && !location.port;
}`;

const CLEAR_FIELD_FN = `function (mark) {
  const el = document.querySelector(mark);
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}`;

const FIELD_FILLED_FN = `function (mark) {
  const el = document.querySelector(mark);
  return Boolean(el && el.value && el.value.length > 0);
}`;

const nonce = () => Math.random().toString(36).slice(2, 10);

const SELECTOR_SET = {
  upn: UPN_SELECTORS,
  loginfmt: LOGINFMT_SELECTORS,
  passwd: PASSWD_SELECTORS,
  otc: OTC_SELECTORS,
  action: ACTION_SELECTORS,
  submit: SUBMIT_SELECTORS,
};

/** Snapshot the page, or null while it is navigating. */
export async function snapshot(session: BrowserSession): Promise<PageSnapshot | null> {
  try {
    return (await session.evaluate<PageSnapshot | null>(tagged("snapshot", SNAPSHOT_FN, [SELECTOR_SET]))) ?? null;
  } catch (error) {
    if (session.closed) throw error;
    return null;
  }
}

async function safeEval<T>(session: BrowserSession, expr: string, fallback: T): Promise<T> {
  try {
    return (await session.evaluate<T>(expr)) ?? fallback;
  } catch (error) {
    if (session.closed) throw error;
    return fallback;
  }
}

/** Mark the first visible editable field matching selectors; returns a selector for it. */
export function markField(session: BrowserSession, selectors: string[]): Promise<string | null> {
  return safeEval(session, tagged("markField", MARK_FIELD_FN, [selectors, nonce()]), null);
}

/** Mark the first visible action whose label matches pattern. */
export function markAction(session: BrowserSession, selectors: string[], pattern: RegExp): Promise<string | null> {
  return safeEval(session, tagged("markAction", MARK_ACTION_FN, [selectors, pattern.source, pattern.flags.replace("g", ""), nonce()]), null);
}

/** True when the marked element has focus and the page host is in hosts. */
export function focusCheck(session: BrowserSession, mark: string, hosts: string[]): Promise<boolean> {
  return safeEval(session, tagged("focusCheck", FOCUS_CHECK_FN, [mark, hosts]), false);
}

export function clearField(session: BrowserSession, mark: string): Promise<boolean> {
  return safeEval(session, tagged("clearField", CLEAR_FIELD_FN, [mark]), false);
}

export function fieldFilled(session: BrowserSession, mark: string): Promise<boolean> {
  return safeEval(session, tagged("fieldFilled", FIELD_FILLED_FN, [mark]), false);
}
