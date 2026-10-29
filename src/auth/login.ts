// Illinois SSO login (Banner -> idpproxy discovery -> Microsoft Entra -> TOTP -> Banner) on a BrowserSession.
// Ported from uiuc-totp/src/login.js. Safeguards kept:
//  - credentials are typed only while the page host is allowlisted for that credential
//  - buttons are verified by their label before clicking
//  - the password only on login.microsoftonline.com, TOTP only on AUTH_HOSTS
//  - secrets never enter an evaluate() string: the field is focused by a native click and filled with type()
//  - errors carry fixed reason codes only (never URLs or values)

import { systemClock, type Clock } from "../core/clock";
import { currentHost, type BrowserSession } from "./browser";
import {
  ACTION_SELECTORS,
  LOGINFMT_SELECTORS,
  OTC_SELECTORS,
  PASSWD_SELECTORS,
  SUBMIT_SELECTORS,
  UPN_SELECTORS,
  cancelPasskey,
  clearField,
  fieldFilled,
  focusCheck,
  markAction,
  markField,
  snapshot,
  type PageSnapshot,
} from "./page";
import { isValidTotpSecret, totpForWindow, TotpWindowTracker } from "./totp";

export const BANNER_HOST = "banner.apps.uillinois.edu";
export const REGISTRATION_START_URL =
  "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/term/termSelection?mode=registration&mepCode=1UIUC";

export const IDP_DISCO_HOSTS = ["idpproxy.uillinois.edu"];
export const MICROSOFT_HOSTS = ["login.microsoftonline.com", "login.microsoft.com"];
export const NETID_HOSTS = [...IDP_DISCO_HOSTS, ...MICROSOFT_HOSTS];
export const PASSWORD_HOSTS = ["login.microsoftonline.com"];
export const AUTH_HOSTS = ["login.microsoftonline.com", "login.microsoft.com", "shibboleth.illinois.edu"];
/** Hosts the chain is expected to pass through. Anything else for too long needs a human. */
export const KNOWN_HOSTS = new Set([
  BANNER_HOST,
  "eis.apps.uillinois.edu",
  "idpproxy.uillinois.edu",
  "shibboleth.illinois.edu",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "aadcdn.msauth.net",
  "aadcdn.msftauth.net",
]);

export type LoginStage =
  | "start"
  | "idp_discovery"
  | "netid"
  | "password"
  | "password_submitted"
  | "passkey_fallback"
  | "mfa_method"
  | "totp_wait"
  | "totp"
  | "kmsi"
  | "returning"
  | "ready";

export type LoginReason =
  | "missing_credentials"
  | "invalid_totp_secret"
  | "aborted"
  | "session_closed"
  | "unexpected_host"
  | "password_rejected"
  | "password_empty"
  | "totp_rejected"
  | "field_not_retained"
  | "field_clear_failed"
  | "focus_failed"
  | "button_not_found"
  | "captcha_required"
  | "security_info_required"
  | "password_change_required"
  | "access_blocked"
  | "microsoft_sign_in_error"
  | "unsupported_mfa_method"
  | "passkey_required"
  | "unsupported_mfa_or_timeout";

export class LoginError extends Error {
  constructor(readonly reason: LoginReason) {
    super(`Login failed: ${reason}`);
    this.name = "LoginError";
  }
}

/** The flow reached something it must not automate. Message and reason are fixed strings. */
export class HumanActionRequired extends LoginError {
  constructor(reason: LoginReason) {
    super(reason);
    this.name = "HumanActionRequired";
    this.message = `Sign-in requires human action (${reason})`;
  }
}

export interface Credentials {
  netid: string;
  password: string;
  totpSecret: string;
}

export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): Credentials | null {
  const netid = env.UIUC_NETID?.trim();
  const password = env.UIUC_PASSWORD;
  const totpSecret = env.UIUC_TOTP_SECRET;
  if (!netid || !password || !totpSecret) return null;
  return { netid, password, totpSecret };
}

export function fullNetId(netid: string): string {
  return netid.includes("@") ? netid : `${netid}@illinois.edu`;
}

export interface LoginOptions {
  onStage?: (stage: LoginStage) => void;
  signal?: AbortSignal;
  tracker?: TotpWindowTracker;
  clock?: Clock;
  startUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** How long an unknown host may show before giving up. */
  unknownHostMs?: number;
  /** Skip the initial navigation (the session is already somewhere in the chain). */
  skipNavigate?: boolean;
}

const OTHER_WAY = /use another way|use a different verification option|sign in another way|other ways to sign in|can.t use my microsoft authenticator/i;
// Match known app-code choices, not actions offering to text/email/call with a code.
const CODE_OPTION = /^(?:(?:use|enter) (?:a |the )?verification code|(?:use |enter )?(?:a |the )?(?:verification )?code from (?:my |your |an? )?(?:microsoft )?(?:authenticator(?: app)?|mobile app))$/i;
const PASSKEY_FALLBACK_TIMEOUT_MS = 15_000;

/** Log in and resolve when the Banner page with a synchronizer token is showing. */
export async function login(session: BrowserSession, creds: Credentials | null, opts: LoginOptions = {}): Promise<void> {
  if (!creds || !creds.netid || !creds.password || !creds.totpSecret) throw new LoginError("missing_credentials");
  if (!isValidTotpSecret(creds.totpSecret)) throw new LoginError("invalid_totp_secret");
  const clock = opts.clock ?? systemClock;
  const tracker = opts.tracker ?? new TotpWindowTracker();
  const pollMs = opts.pollMs ?? 500;
  const deadline = clock.now() + (opts.timeoutMs ?? 180_000);
  const unknownHostMs = opts.unknownHostMs ?? 15_000;
  const signal = opts.signal;
  let lastStage: LoginStage | null = null;
  const stage = (s: LoginStage) => {
    if (s === lastStage) return;
    lastStage = s;
    try {
      opts.onStage?.(s);
    } catch {
      // observers never break login
    }
  };
  const check = () => {
    if (signal?.aborted) throw new LoginError("aborted");
    if (session.closed) throw new LoginError("session_closed");
  };
  const sleep = async (ms: number) => {
    try {
      await clock.sleep(ms, signal);
    } catch {
      throw new LoginError("aborted");
    }
  };
  const hostIn = (hosts: string[]) => {
    const host = currentHost(session);
    return host !== null && hosts.includes(host);
  };

  /**
   * Type a secret into the field matched by selectors, only while the page is on one of hosts.
   * Returns false (nothing typed) if any check fails.
   */
  const typeInto = async (selectors: string[], hosts: string[], value: string, clearFirst: boolean): Promise<boolean> => {
    check();
    if (!hostIn(hosts)) return false;
    const mark = await markField(session, selectors);
    if (!mark) return false;
    if (!hostIn(hosts)) return false;
    try {
      await session.click(mark, { timeoutMs: 5000 });
    } catch {
      return false;
    }
    if (clearFirst && !(await clearField(session, mark))) throw new LoginError("field_clear_failed");
    check();
    // The last checks before typing: focus is on the marked field and the page host is allowed.
    if (!hostIn(hosts) || !(await focusCheck(session, mark, hosts))) throw new LoginError("focus_failed");
    await session.type(value);
    await sleep(300);
    if (!hostIn(hosts)) return false;
    if (!(await fieldFilled(session, mark))) throw new LoginError("field_not_retained");
    return true;
  };

  /** Click the first visible action whose label matches, only on the given hosts. */
  const clickAction = async (selectors: string[], pattern: RegExp, hosts: string[]): Promise<boolean> => {
    check();
    if (!hostIn(hosts)) return false;
    const mark = await markAction(session, selectors, pattern);
    if (!mark || !hostIn(hosts)) return false;
    try {
      await session.click(mark, { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  };

  stage("start");
  check();
  if (!opts.skipNavigate) {
    try {
      await session.navigate(opts.startUrl ?? REGISTRATION_START_URL);
    } catch {
      // SSO redirects can interrupt the load event; the loop below follows wherever the page lands.
      check();
    }
  }

  let upnDone = false;
  let netidDone = false;
  let passwordDone = false;
  let clickedOtherWay = false;
  let selectedCode = false;
  let codeEntered = false;
  let kmsiClicks = 0;
  let unknownSince: number | null = null;
  let passkeyBackAt: number | null = null;
  let lastPrompt: PageSnapshot["prompt"] | null = null;

  while (clock.now() < deadline) {
    check();
    const snap: PageSnapshot | null = await snapshot(session);
    check();
    const host = currentHost(session);
    if (!snap || !host || snap.host !== host || !snap.secure) {
      await sleep(pollMs);
      continue;
    }

    if (!KNOWN_HOSTS.has(host)) {
      unknownSince ??= clock.now();
      if (clock.now() - unknownSince > unknownHostMs) throw new HumanActionRequired("unexpected_host");
      await sleep(pollMs);
      continue;
    }
    unknownSince = null;
    lastPrompt = snap.prompt;

    if (host === BANNER_HOST) {
      if (snap.syncToken) {
        stage("ready");
        return;
      }
      stage("returning");
      await sleep(pollMs);
      continue;
    }

    if (IDP_DISCO_HOSTS.includes(host)) {
      if (snap.fields.upn && !upnDone) {
        stage("idp_discovery");
        if (await typeInto(UPN_SELECTORS, IDP_DISCO_HOSTS, fullNetId(creds.netid), true)) {
          upnDone = await clickAction(['button[type="submit"]', 'input[type="submit"]'], /^continue to sign in$/i, IDP_DISCO_HOSTS);
          if (!upnDone) throw new LoginError("button_not_found");
        }
      }
      await sleep(pollMs);
      continue;
    }

    if (MICROSOFT_HOSTS.includes(host)) {
      if (snap.flags.passwordError) throw new HumanActionRequired("password_rejected");
      if (snap.flags.otcError) throw new HumanActionRequired("totp_rejected");
      if (snap.flags.emptyPassword && passwordDone) throw new LoginError("password_empty");

      const noCredentialForm = !snap.fields.passwd && !snap.fields.loginfmt && !snap.fields.otc;
      let blockedReason: LoginReason | null = null;
      if (snap.prompt === "captcha") blockedReason = "captcha_required";
      else if (snap.prompt === "sms_or_email_code") blockedReason = "unsupported_mfa_method";
      else if (snap.prompt === "security_info_required") blockedReason = "security_info_required";
      else if (snap.prompt === "password_change_required") blockedReason = "password_change_required";
      else if (snap.prompt === "access_blocked") blockedReason = "access_blocked";
      else if (snap.prompt === "sign_in_error") blockedReason = "microsoft_sign_in_error";
      if (blockedReason) throw new HumanActionRequired(blockedReason);

      // Cancel a browser-owned FIDO prompt once to select an available app-code method.
      let fidoRoute = false;
      try {
        fidoRoute = /\/fido\/get\/?$/i.test(new URL(session.url()).pathname);
      } catch {
        // A transitioning URL is not permission to click Back.
      }
      const alternateAvailable = snap.actions.some(label => OTHER_WAY.test(label) || CODE_OPTION.test(label));
      if (snap.prompt === "passkey" && noCredentialForm && fidoRoute && !alternateAvailable && !codeEntered) {
        if (passkeyBackAt === null) {
          passkeyBackAt = clock.now();
          stage("passkey_fallback");
          if (!(await cancelPasskey(session))) throw new HumanActionRequired("passkey_required");
        } else if (clock.now() - passkeyBackAt >= PASSKEY_FALLBACK_TIMEOUT_MS) {
          throw new HumanActionRequired("passkey_required");
        }
        await sleep(pollMs);
        continue;
      }
      if (passkeyBackAt !== null && (snap.fields.passwd || snap.fields.loginfmt)) {
        // Back may return to credentials instead of offering an alternate factor. Do not resubmit.
        throw new HumanActionRequired("passkey_required");
      }

      if (snap.flags.kmsi) {
        stage("kmsi");
        if (kmsiClicks < 3 && (await clickAction(["#idBtn_Back"], /^no$/i, MICROSOFT_HOSTS))) kmsiClicks++;
        await sleep(pollMs);
        continue;
      }

      if (snap.fields.passwd && !passwordDone) {
        stage("password");
        // Wait for Microsoft's transition: visible password field plus a "Sign in" submit.
        if (!snap.flags.signInReady || !hostIn(PASSWORD_HOSTS)) {
          await sleep(pollMs);
          continue;
        }
        await sleep(1000);
        if (await typeInto(PASSWD_SELECTORS, PASSWORD_HOSTS, creds.password, true)) {
          if (!(await clickAction(SUBMIT_SELECTORS, /^sign in$/i, PASSWORD_HOSTS))) throw new LoginError("button_not_found");
          passwordDone = true;
          // A click is not proof of acceptance. Never automatically submit the password again.
          stage("password_submitted");
          await sleep(750);
        }
        continue;
      }

      if (snap.fields.loginfmt && !netidDone && !snap.fields.passwd) {
        stage("netid");
        if (await typeInto(LOGINFMT_SELECTORS, MICROSOFT_HOSTS, fullNetId(creds.netid), true)) {
          if (!(await clickAction(SUBMIT_SELECTORS, /^next$/i, MICROSOFT_HOSTS))) throw new LoginError("button_not_found");
          netidDone = true;
        } else if (snap.fields.loginfmtFilled) {
          // Prefilled and read-only: continue with Next only.
          netidDone = await clickAction(SUBMIT_SELECTORS, /^next$/i, MICROSOFT_HOSTS);
        }
        await sleep(pollMs);
        continue;
      }

      if (!snap.fields.otc && !codeEntered) {
        if (!clickedOtherWay && (await clickAction(ACTION_SELECTORS, OTHER_WAY, MICROSOFT_HOSTS))) {
          stage("mfa_method");
          clickedOtherWay = true;
          await sleep(pollMs);
          continue;
        }
        // Microsoft can show the method picker directly, without this heading or an Other way click.
        const directMethodPicker = passwordDone && noCredentialForm;
        if ((clickedOtherWay || snap.flags.verifyIdentity || directMethodPicker) && !selectedCode) {
          if (await clickAction(ACTION_SELECTORS, CODE_OPTION, MICROSOFT_HOSTS)) {
            stage("mfa_method");
            selectedCode = true;
            await sleep(pollMs);
            continue;
          }
        }
      }
    }

    if (AUTH_HOSTS.includes(host) && snap.fields.otc && !codeEntered) {
      if (clock.now() >= deadline) break;
      const waitMs = tracker.waitMs(clock.now());
      if (waitMs > 0) stage("totp_wait");
      let window: number;
      try {
        window = await tracker.acquire(clock, signal);
      } catch {
        throw new LoginError("aborted");
      }
      check();
      // The page may have moved while we waited for the window edge.
      const again = await snapshot(session);
      if (!again || !again.fields.otc || !hostIn(AUTH_HOSTS)) continue;
      stage("totp");
      if (await typeInto(OTC_SELECTORS, AUTH_HOSTS, totpForWindow(creds.totpSecret, window), true)) {
        codeEntered = true;
        if (!(await clickAction(SUBMIT_SELECTORS.concat(["#idSubmit_SAOTCC_Continue"]), /^(verify|next|sign in)$/i, AUTH_HOSTS))) {
          throw new LoginError("button_not_found");
        }
      }
      await sleep(pollMs);
      continue;
    }

    await sleep(pollMs);
  }
  throw new HumanActionRequired(lastPrompt === "passkey" ? "passkey_required" : "unsupported_mfa_or_timeout");
}
