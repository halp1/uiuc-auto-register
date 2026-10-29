// The logged-in Banner browser session. Only this module drives the real account.
// Reads go through inPageFetch (fetch inside the page, with the page's cookies and synchronizer token).
// Every Banner request passes the CDP write interceptor; the webkit backend has none, so it is refused.

import { HumanActionRequired, LoginError, credentialsFromSettings, login, type Credentials, type LoginStage } from "../auth/login";
import { TotpWindowTracker, isValidTotpSecret } from "../auth/totp";
import type { BrowserFactory, BrowserSession } from "../auth/browser";
import type { Clock } from "../core/clock";
import type { Config } from "../core/config";
import { SeatSourceError, type RehearsalReport, type SeatSource, type SessionManager } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import type { SeatInfo, SessionState, Settings, SystemStatus } from "../core/types";
import { courseForCrn } from "../catalog/store";
import { AnonymousSeatSource, BANNER_BASE, MEP_CODE, looksLikeLogin, parseEnrollmentInfo, type FetchLike } from "./enrollment";
import { installInterceptor, type AuthorizedBatch, type InstalledInterceptor } from "./interceptor";
import { currentWindow, parseTicket, type TicketParse } from "./ticket";
import type { RegistrationModel } from "./guard";
import {
  BannerSessionError,
  SCHEDULE_READER,
  SSB_PATH,
  makeUniqueSessionId,
  parseAddItems,
  parseRegistrationSummary,
  parseScheduleJson,
  parseSubmitBatch,
  parseTermSearch,
  parseWorkingSet,
  type AddItemRow,
  type BannerReadApi,
  type BannerWriteApi,
  type CrnLookup,
  type Eligibility,
  type InPageInit,
  type InPageResponse,
  type RegistrationPageData,
  type ScheduleRead,
  type ScheduleStrategy,
  type SessionReason,
  type SubmitRow,
} from "./registrar/types";

const SESSION_TITLES: Record<SessionState, string> = {
  cold: "Banner session disconnected",
  logging_in: "Logging in to Banner",
  warm: "Banner session connected",
  error: "Banner session error",
};

export const BANNER_ORIGIN = "https://banner.apps.uillinois.edu";
export const KEEPALIVE_MS = 4 * 60 * 1000;
const MAX_BODY = 2 * 1024 * 1024;

export interface BannerSessionDeps {
  config: Config;
  events: Events;
  store: Store;
  clock: Clock;
  settings: () => Settings;
  browserFactory?: BrowserFactory;
  credentials?: () => Credentials | null;
  tracker?: TotpWindowTracker;
  /** Plain fetch for anonymous lookups (no cookies). */
  fetch?: FetchLike;
  loginTimeoutMs?: number;
}

/**
 * Calendar events for the term the session last selected with term/search. UIUC answers HTTP 500 to any
 * non-empty termFilter, so the term comes from the session, never from the query (verified 2026-10-28).
 */
export const CALENDAR_PATH = `${SSB_PATH}/classRegistration/getRegistrationEvents?termFilter=`;

/** Working-set models for a drop (live only; unverified at UIUC until the swap test runs). */
export function workingSetPath(term: string): string {
  return `${SSB_PATH}/classRegistration/reset?selectedTab=true&term=${encodeURIComponent(term)}`;
}

/** Reads the registration page's own bootstrap data. Returns only the three fields the reader needs. */
const REGISTRATION_PAGE_EXPR = `(() => {
  const b = window.bootstraps;
  if (!b) return null;
  const copy = v => { try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (e) { return null; } };
  return { terms: copy(b.terms), multiTerm: copy(b.multiTerm), summaryModels: copy(b.summaryModels) };
})()`;

export const PREPARE_REGISTRATION_PATH = `${SSB_PATH}/prepareRegistration/prepareRegistration`;

const TICKET_READY_EXPR = `(() => {
  const t = (document.body && document.body.innerText) || '';
  return /time\\s*ticket|registration\\s+(time|window|period|appointment)/i.test(t) && /\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{2}-\\d{2}|[A-Z][a-z]{2,8}\\.?\\s+\\d{1,2},?\\s+\\d{4}|no\\s+(registration\\s+)?time\\s*ticket|not\\s+have/i.test(t);
})()`;

/** Visible page text, capped. Stays in memory only long enough to parse the dates out. */
const TICKET_TEXT_EXPR = `(async () => {
  await new Promise(r => setTimeout(r, 500)); // let late sections finish rendering
  const t = (document.body && document.body.innerText) || '';
  return t.length > 200000 ? t.slice(0, 200000) : t;
})()`;

/** Page-side fetch. Args travel as JSON data; nothing secret is ever included. */
function inPageFetchExpr(args: { url: string; method: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string>; max: number }): string {
  return `(async (a) => {
    const meta = document.querySelector('meta[name="synchronizerToken"]');
    const headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' }, a.headers || {});
    if (meta && meta.content) headers['X-Synchronizer-Token'] = meta.content;
    let body;
    if (a.form) { body = new URLSearchParams(a.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; }
    else if (a.json !== undefined) { body = JSON.stringify(a.json); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(a.url, { method: a.method, headers, body, credentials: 'same-origin', redirect: 'follow' });
    const text = await res.text();
    const finalUrl = (() => { try { const u = new URL(res.url); return u.origin + u.pathname; } catch { return ''; } })();
    return { status: res.status, url: finalUrl, redirected: res.redirected, loginPage: res.headers.get('X-Login-Page') === 'true',
      contentType: res.headers.get('content-type'), body: text.length > a.max ? text.slice(0, a.max) : text };
  })(${JSON.stringify(args)})`;
}

export class BannerSessionManager implements SessionManager {
  private browser: BrowserSession | null = null;
  private interceptor: InstalledInterceptor | null = null;
  private authorized: AuthorizedBatch | null = null;
  private current: SessionState = "cold";
  private since: number | null = null;
  private lastKeepaliveAt: number | null = null;
  private lastError: string | null = null;
  private stage: string | null = null;
  private warming: Promise<void> | null = null;
  /** Aborts the login in progress (Log out while logging in). */
  private loginAbort: AbortController | null = null;
  private keepaliveTimer: { cancel(): void } | null = null;
  private termEligibility = new Map<string, Eligibility>();
  private activeTerm: string | null = null;
  private uniqueSessionId = "";
  private failures = 0;
  private retryAt = 0;
  private humanBlocked = false;
  private disposed = false;
  private blockedTotal = 0;
  private lastStrategies: ScheduleStrategy[] = [];
  private readingTicket = false;
  private batchPending = false;
  private pageOps = 0;
  private ticketDone: Promise<void> | null = null;
  private blockContext: "ticket" | null = null;
  private readonly tracker: TotpWindowTracker;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: BannerSessionDeps) {
    this.tracker = deps.tracker ?? new TotpWindowTracker();
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  // ---------- status ----------

  state(): SessionState {
    return this.current;
  }

  status(): SystemStatus["session"] {
    return {
      state: this.current,
      since: this.since,
      lastKeepaliveAt: this.lastKeepaliveAt,
      loggedOut: this.deps.settings().sessionLoggedOut,
      lastError: this.lastError,
      stage: this.stage,
    };
  }

  /** Strategies that answered on the most recent schedule read. */
  scheduleStrategies(): ScheduleStrategy[] {
    return [...this.lastStrategies];
  }

  blockedWrites(): number {
    return this.blockedTotal;
  }

  private setState(state: SessionState, reason: string | null = null) {
    if (state === this.current && reason === null) return;
    const previous = this.current;
    this.current = state;
    this.since = this.deps.clock.now();
    if (state !== "logging_in") this.stage = null;
    if (previous !== state) {
      this.deps.events.emit({
        kind: "session_state",
        severity: state === "error" ? "warning" : "info",
        title: SESSION_TITLES[state],
        detail: reason,
        payload: { state, previous, reason },
      });
    }
  }

  private fail(reason: SessionReason): BannerSessionError {
    this.lastError = reason;
    this.setState("error", reason);
    this.deps.events.emit({ kind: "session_error", severity: "critical", title: "Banner session error", detail: reason, payload: { reason } });
    return new BannerSessionError(reason);
  }

  // ---------- lifecycle ----------

  async ensureWarm(term: string): Promise<void> {
    await this.pageOp(async () => {
      await this.warmBase();
      await this.selectTerm(term);
    });
  }

  /** Log in without choosing a term (the setup login check). */
  async login(): Promise<void> {
    await this.pageOp(() => this.warmBase());
  }

  /** Log in (single flight) without choosing a term. */
  private async warmBase(): Promise<void> {
    if (this.disposed) throw new BannerSessionError("disposed");
    if (this.current === "warm" && this.browser && !this.browser.closed) return;
    if (this.warming) return this.warming;
    this.warming = this.doWarm().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private async doWarm(): Promise<void> {
    const creds = (this.deps.credentials ?? (() => credentialsFromSettings(this.deps.settings())))();
    // Configuration problems are reported once, not on every keep-warm check.
    const configError = (reason: SessionReason) => (this.lastError === reason && this.current === "error" ? new BannerSessionError(reason) : this.fail(reason));
    if (!creds) throw configError("missing_credentials");
    if (!isValidTotpSecret(creds.totpSecret)) throw configError("invalid_totp_secret");
    if (this.humanBlocked) throw new BannerSessionError(this.lastError ?? "login_blocked");
    if (this.deps.clock.now() < this.retryAt) throw new BannerSessionError(this.lastError ?? "login_failed");

    await this.closeBrowser();
    const abort = new AbortController();
    this.loginAbort = abort;
    this.setState("logging_in");
    try {
      await this.loginInto(creds, abort.signal);
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null;
    }
  }

  private async loginInto(creds: Credentials, signal: AbortSignal): Promise<void> {
    const cancelled = async () => {
      await this.closeBrowser();
      this.stage = null;
      this.setState("cold", "login_cancelled");
      return new BannerSessionError("login_cancelled");
    };
    const factory = this.deps.browserFactory ?? (await import("../auth/webview")).webViewFactory;
    let browser: BrowserSession;
    try {
      browser = await factory({ backend: "chrome", chromePath: this.deps.config.chromePath });
    } catch (error) {
      // Launch only opens about:blank, before credentials enter the browser. Keep the cause in
      // server logs while exposing only the fixed reason code through the API and activity feed.
      console.error("Browser launch failed", error);
      throw this.fail("browser_launch_failed");
    }
    if (browser.backend !== "chrome") {
      await browser.close().catch(() => {});
      throw this.fail("webkit_unsupported");
    }
    this.browser = browser;
    if (signal.aborted) throw await cancelled();
    try {
      this.interceptor = await installInterceptor(browser, () => this.authorized, info => {
        this.blockedTotal++;
        // Requests the Prepare for Registration page makes on its own are blocked too, but they are
        // the page's doing, not the app's, so they are reported without the alarm.
        const ticketPage = this.blockContext === "ticket";
        this.deps.events.emit({
          kind: "session_error",
          severity: ticketPage ? "warning" : "critical",
          title: ticketPage ? "Blocked a request from the Prepare for Registration page" : "Blocked a Banner write",
          detail: `${info.method} ${info.url}`,
          payload: { reason: "write_blocked", method: info.method, url: info.url, context: this.blockContext },
        });
      });
    } catch {
      await this.closeBrowser();
      throw this.fail("interceptor_failed");
    }

    try {
      await login(browser, creds, {
        clock: this.deps.clock,
        tracker: this.tracker,
        timeoutMs: this.deps.loginTimeoutMs,
        signal,
        onStage: (stage: LoginStage) => {
          this.stage = stage;
          this.deps.events.emit({ kind: "login_stage", severity: "info", title: `Login: ${stage}`, payload: { stage } });
        },
      });
    } catch (error) {
      // Cancelled by Log out: not a failure, so no backoff and no error state.
      if (signal.aborted) throw await cancelled();
      await this.closeBrowser();
      const reason = error instanceof LoginError ? error.reason : "login_failed";
      if (error instanceof HumanActionRequired || reason === "password_rejected" || reason === "totp_rejected") {
        // Never retry these automatically: repeated bad passwords lock the account.
        this.humanBlocked = true;
      } else {
        this.failures++;
        this.retryAt = this.deps.clock.now() + Math.min(30 * 60_000, 2 * 60_000 * 2 ** (this.failures - 1));
      }
      throw this.fail(reason);
    }
    if (signal.aborted) throw await cancelled();
    this.failures = 0;
    this.retryAt = 0;
    this.lastError = null;
    this.uniqueSessionId = makeUniqueSessionId(this.deps.clock.now());
    this.termEligibility.clear();
    this.activeTerm = null;
    this.setState("warm");
    this.scheduleKeepalive();
  }

  /** term/search for registration, then open the registration page so its fresh token is in the DOM. */
  private async selectTerm(term: string): Promise<Eligibility> {
    const cached = this.termEligibility.get(term);
    if (cached?.allowed && this.activeTerm === term) return cached;
    const res = await this.inPageFetch(`${SSB_PATH}/term/search?mode=registration`, {
      method: "POST",
      form: { term, studyPath: "", studyPathText: "", startDatepicker: "", endDatepicker: "", uniqueSessionId: this.uniqueSessionId },
    });
    const eligibility = parseTermSearch(res.body);
    if (!eligibility) throw new BannerSessionError("term_search_failed");
    this.termEligibility.set(term, eligibility);
    if (eligibility.allowed) {
      await this.openPage(`${BANNER_ORIGIN}${SSB_PATH}/classRegistration/classRegistration`);
      this.activeTerm = term;
    }
    return eligibility;
  }

  private async openPage(url: string) {
    const browser = this.requireBrowser();
    try {
      await browser.navigate(url);
    } catch {
      // fall through to the token check
    }
    const ok = await browser.waitFor(`document.querySelector('meta[name="synchronizerToken"]')`, 15_000);
    if (!ok || new URL(browser.url() || "about:blank").hostname !== new URL(BANNER_ORIGIN).hostname) {
      await this.dropSession("login_required");
      throw new BannerSessionError("token_missing");
    }
  }

  private requireBrowser(): BrowserSession {
    if (!this.browser || this.browser.closed || this.current !== "warm") throw new BannerSessionError("not_warm");
    return this.browser;
  }

  /** Run fetch inside the logged-in page with the synchronizer token headers. */
  async inPageFetch(path: string, init: InPageInit = {}): Promise<InPageResponse> {
    const browser = this.requireBrowser();
    if (!path.startsWith(`${SSB_PATH}/`)) throw new BannerSessionError("request_failed");
    let host = "";
    try {
      host = new URL(browser.url()).hostname;
    } catch {
      // navigating
    }
    if (host !== new URL(BANNER_ORIGIN).hostname) throw new BannerSessionError("not_warm");
    let res: InPageResponse;
    try {
      res = await browser.evaluate<InPageResponse>(
        inPageFetchExpr({ url: `${BANNER_ORIGIN}${path}`, method: init.method ?? "GET", form: init.form, json: init.json, headers: init.headers, max: MAX_BODY }),
      );
    } catch {
      throw new BannerSessionError("request_failed");
    }
    if (!res || typeof res.status !== "number") throw new BannerSessionError("request_failed");
    const leftBanner = res.url && !res.url.startsWith(BANNER_ORIGIN);
    if (res.loginPage || leftBanner || (res.status === 200 && /text\/html/i.test(res.contentType ?? "") && looksLikeLogin(res.body))) {
      await this.dropSession("login_required");
      throw new BannerSessionError("login_required");
    }
    return res;
  }

  private scheduleKeepalive() {
    this.keepaliveTimer?.cancel();
    this.keepaliveTimer = this.deps.clock.setTimeout(() => void this.keepalive(), KEEPALIVE_MS);
  }

  /** Lightweight authenticated GET. A lost session re-logs in quietly (subject to backoff). */
  async keepalive(): Promise<boolean> {
    if (this.current !== "warm") return false;
    // A ticket read is using the tab and proves the session is alive. Check again next round.
    if (this.readingTicket) {
      this.scheduleKeepalive();
      return true;
    }
    const term = this.activeTerm ?? this.deps.settings().activeTerm ?? "";
    try {
      await this.inPageFetch(CALENDAR_PATH);
      this.lastKeepaliveAt = this.deps.clock.now();
      this.scheduleKeepalive();
      return true;
    } catch (error) {
      if (error instanceof BannerSessionError && error.reason === "login_required" && !this.disposed) {
        try {
          await this.warmBase();
          if (term) await this.selectTerm(term);
          this.lastKeepaliveAt = this.deps.clock.now();
          return true;
        } catch {
          return false;
        }
      }
      if (this.current === "warm") this.scheduleKeepalive();
      return false;
    }
  }

  private async dropSession(reason: string) {
    this.keepaliveTimer?.cancel();
    this.keepaliveTimer = null;
    await this.closeBrowser();
    this.termEligibility.clear();
    this.activeTerm = null;
    this.setState("cold", reason);
  }

  private async closeBrowser() {
    const interceptor = this.interceptor;
    const browser = this.browser;
    this.interceptor = null;
    this.browser = null;
    this.authorized = null;
    if (interceptor) await interceptor.uninstall().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  async goCold(reason: string): Promise<void> {
    // Log out during a login cancels it instead of waiting for it to finish.
    this.loginAbort?.abort();
    if (this.warming) await this.warming.catch(() => {});
    // An explicit cold start also clears login backoff and human-action blocks.
    this.humanBlocked = false;
    this.failures = 0;
    this.retryAt = 0;
    await this.dropSession(reason);
    if (this.current === "error") this.setState("cold", reason);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.warming) await this.warming.catch(() => {});
    await this.dropSession("disposed");
  }

  // ---------- reads ----------

  async eligibility(term: string): Promise<Eligibility> {
    return this.pageOp(async () => {
      await this.warmBase();
      return this.selectTerm(term);
    });
  }

  /**
   * The registered CRNs for a term, read the way Banner's own registration page does:
   *  1. term/search selects the term (registration must be open for it, otherwise "term_not_open"),
   *  2. the classRegistration page is rendered fresh and its summary (window.bootstraps.summaryModels)
   *     is the authoritative list, including online sections with no meeting times,
   *  3. the calendar endpoint is a cross-check: every CRN it lists must be in the summary.
   * Anything that does not line up throws "schedule_unreadable". Never returns a partial schedule.
   */
  async readScheduleDetailed(term: string): Promise<ScheduleRead> {
    return this.pageOp(() => this.readScheduleInner(term));
  }

  private async readScheduleInner(term: string): Promise<ScheduleRead> {
    await this.warmBase();
    // term/search once per session (cached), then a fresh render of the page: the summary is rendered
    // server-side for the session's selected term, and parseRegistrationSummary checks it is this term.
    const eligibility = await this.selectTerm(term);
    if (!eligibility.allowed) throw new BannerSessionError("term_not_open");
    await this.openPage(`${BANNER_ORIGIN}${SSB_PATH}/classRegistration/classRegistration`);
    const browser = this.requireBrowser();
    let page: RegistrationPageData | null;
    try {
      page = await browser.evaluate<RegistrationPageData | null>(REGISTRATION_PAGE_EXPR);
    } catch {
      page = null;
    }
    const summary = parseRegistrationSummary(page, term);
    if (!summary) {
      this.lastStrategies = [];
      throw new BannerSessionError("schedule_unreadable");
    }
    const strategies: ScheduleStrategy[] = ["summary"];
    let calendar: string[] | null = null;
    try {
      const res = await this.inPageFetch(CALENDAR_PATH);
      if (res.status === 200) calendar = parseScheduleJson(res.body, term);
    } catch (error) {
      if (error instanceof BannerSessionError && error.reason === "login_required") throw error;
    }
    if (calendar) {
      // A section with meetings that the summary lacks means the summary is not the whole picture.
      if (calendar.some(crn => !summary.includes(crn))) {
        this.lastStrategies = [];
        throw new BannerSessionError("schedule_unreadable");
      }
      strategies.push("calendar");
    }
    this.lastStrategies = strategies;
    return { crns: summary, strategies };
  }

  async readSchedule(term: string): Promise<string[]> {
    return (await this.readScheduleDetailed(term)).crns;
  }

  /** Anonymous existence check (no cookies) plus the catalog title when known. */
  async lookupCrn(term: string, crn: string): Promise<CrnLookup> {
    const params = new URLSearchParams({ term, courseReferenceNumber: crn, mepCode: MEP_CODE });
    let exists = false;
    try {
      const res = await this.fetchImpl(`${BANNER_BASE}/searchResults/getEnrollmentInfo?${params}`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      exists = res.status === 200 && parseEnrollmentInfo(await res.text()) !== null;
    } catch {
      exists = false;
    }
    const course = courseForCrn(this.deps.store, term, crn);
    return { crn, exists, title: course ? `${course.subject} ${course.number} ${course.section}` : null };
  }

  authenticatedSeatSource(): SeatSource {
    return {
      kind: "authenticated",
      fetchSeats: async (term, crns, signal) => {
        try {
          await this.ensureWarm(term);
        } catch (error) {
          throw new SeatSourceError("Authenticated seat source unavailable", "login_required");
        }
        const seats: Omit<SeatInfo, "changedAt">[] = [];
        for (const crn of [...new Set(crns)]) {
          if (signal?.aborted) throw signal.reason;
          const params = new URLSearchParams({ term, courseReferenceNumber: crn });
          let res: InPageResponse;
          try {
            res = await this.inPageFetch(`${SSB_PATH}/searchResults/getEnrollmentInfo?${params}`);
          } catch (error) {
            if (error instanceof BannerSessionError && (error.reason === "login_required" || error.reason === "not_warm")) {
              throw new SeatSourceError("Authenticated seat source: login required", "login_required");
            }
            continue;
          }
          if (res.status === 429) throw new SeatSourceError("Authenticated seat source: HTTP 429", "rate_limited");
          if (res.status !== 200) continue;
          const info = parseEnrollmentInfo(res.body);
          if (info) seats.push({ term, crn, ...info, checkedAt: this.deps.clock.now() });
        }
        if (crns.length > 0 && seats.length === 0) throw new SeatSourceError("Authenticated seat source: no readable CRNs", "parse");
        return seats;
      },
    };
  }

  /**
   * Read-only end to end check. For a term that is not open yet but has a future time ticket, the schedule
   * reader is proven on another term that is open now (otherTerms, newest first).
   */
  async rehearse(term: string, crns: string[], opts: { otherTerms?: string[]; knownTicketAt?: string | null } = {}): Promise<RehearsalReport> {
    const startedAt = this.deps.clock.now();
    const blockedBefore = this.blockedTotal;
    const report: RehearsalReport = { ok: false, startedAt, finishedAt: startedAt, steps: [], term, eligibility: null, schedule: null, crnChecks: [], blockedWrites: 0, reader: SCHEDULE_READER };
    const step = async <T>(name: string, fn: () => Promise<T>, detail: (value: T) => string | null): Promise<T | null> => {
      const t0 = this.deps.clock.now();
      try {
        const value = await fn();
        report.steps.push({ name, ok: true, detail: detail(value), ms: this.deps.clock.now() - t0 });
        return value;
      } catch (error) {
        const reason = error instanceof BannerSessionError || error instanceof LoginError ? error.reason : "unexpected_error";
        report.steps.push({ name, ok: false, detail: reason, ms: this.deps.clock.now() - t0 });
        return null;
      }
    };
    const logged = await step("login", () => this.warmBase().then(() => true), () => null);
    if (logged) {
      let eligibility: Eligibility | null = null;
      try {
        eligibility = await this.selectTerm(term);
      } catch (error) {
        const reason = error instanceof BannerSessionError ? error.reason : "unexpected_error";
        report.steps.push({ name: "term_open", ok: false, detail: reason, ms: 0 });
      }
      if (eligibility?.allowed) {
        report.eligibility = eligibility;
        report.steps.push({ name: "term_open", ok: true, detail: "Registration is open", ms: 0 });
        const schedule = await step("read_schedule", () => this.readScheduleDetailed(term), s => `${s.crns.length} CRNs: ${s.crns.join(", ") || "none"}`);
        report.schedule = schedule?.crns ?? null;
        report.readerTerm = schedule ? term : null;
        // The live registrar compares its first read against this snapshot.
        if (schedule) this.deps.store.addScheduleSnapshot(term, schedule.crns, "rehearsal");
      } else if (eligibility) {
        // Not open. Before the time ticket that is expected: confirm the ticket is still ahead, then prove the
        // schedule reader on a term that is open now. Nothing is stored for the closed term, so its first
        // real read happens at registration time.
        const why = eligibility.messages.join("; ") || "Banner says registration is not open";
        const ticket = await step("time_ticket", () => this.readTicket(term), t => (t.status === "found" ? `${t.windows.length} window(s)` : t.status));
        const window = ticket?.status === "found" ? currentWindow(ticket.windows, this.deps.clock.now()) : null;
        const now = this.deps.clock.now();
        const fromBanner = window && Date.parse(window.start) > now ? window.start : null;
        // A ticket typed in Settings counts when Banner's page could not be read.
        const typed = opts.knownTicketAt && Date.parse(opts.knownTicketAt) > now ? opts.knownTicketAt : null;
        const opensAt = fromBanner ?? (ticket?.status === "found" ? null : typed);
        if (!opensAt) {
          report.steps.push({ name: "term_open", ok: false, detail: `term_not_open: ${why}`, ms: 0 });
        } else {
          report.opensAt = opensAt;
          report.eligibility = eligibility;
          report.steps.push({ name: "term_open", ok: true, detail: `Not open yet. Opens ${opensAt}`, ms: 0 });
          let readerTerm: string | null = null;
          for (const candidate of (opts.otherTerms ?? []).filter(t => t !== term).slice(0, 4)) {
            try {
              if ((await this.selectTerm(candidate)).allowed) {
                readerTerm = candidate;
                break;
              }
            } catch (error) {
              if (error instanceof BannerSessionError && error.reason === "login_required") break;
            }
          }
          if (!readerTerm) {
            report.steps.push({ name: "read_schedule", ok: false, detail: "no_open_term: no term is open right now to check the schedule reader on", ms: 0 });
          } else {
            const schedule = await step("read_schedule", () => this.readScheduleDetailed(readerTerm!), s => `${s.crns.length} CRNs: ${s.crns.join(", ") || "none"}`);
            report.schedule = schedule?.crns ?? null;
            report.readerTerm = schedule ? readerTerm : null;
            if (schedule) this.deps.store.addScheduleSnapshot(readerTerm, schedule.crns, "rehearsal");
          }
        }
      }
    }
    for (const crn of crns) {
      const check = await step(`crn_${crn}`, () => this.lookupCrn(term, crn), c => (c.exists ? c.title ?? "exists" : "not found"));
      report.crnChecks.push(check ?? { crn, exists: false, title: null });
    }
    report.blockedWrites = this.blockedTotal - blockedBefore;
    report.steps.push({ name: "no_writes", ok: report.blockedWrites === 0, detail: `${report.blockedWrites} blocked`, ms: 0 });
    report.ok = report.steps.every(s => s.ok) && report.crnChecks.every(c => c.exists);
    report.finishedAt = this.deps.clock.now();
    return report;
  }

  /** Registration work waits for a ticket read to finish, since both use the one browser tab. */
  private async ticketIdle(): Promise<void> {
    while (this.ticketDone) await this.ticketDone.catch(() => {});
  }

  /**
   * Run registration-page work. It waits out a ticket read, then counts itself as in flight (in the same
   * tick, so a ticket read cannot start in between) until it settles.
   */
  private async pageOp<T>(fn: () => Promise<T>): Promise<T> {
    await this.ticketIdle();
    this.pageOps++;
    try {
      return await fn();
    } finally {
      this.pageOps--;
    }
  }

  /** True while readTicket has the browser on the Prepare for Registration page. */
  ticketReading(): boolean {
    return this.readingTicket;
  }

  /**
   * The registration time ticket for a term, read the way a student sees it: term/search in preReg
   * mode (the same read-only call the Prepare for Registration term picker makes), then the Prepare
   * for Registration page. Only the parsed dates leave this method. The page text is never logged.
   * Afterwards the registration term selection is forgotten, so the next registration read re-selects it.
   */
  async readTicket(term: string): Promise<TicketParse> {
    // Claim the browser in this tick: no await before the claim, so registration work cannot slip in.
    if (this.authorized || this.batchPending) throw new BannerSessionError("batch_in_flight");
    if (this.readingTicket) throw new BannerSessionError("ticket_read_in_flight");
    if (this.pageOps > 0) throw new BannerSessionError("session_busy");
    this.readingTicket = true;
    let release!: () => void;
    this.ticketDone = new Promise<void>(resolve => (release = resolve));
    const blockedBefore = this.blockedTotal;
    try {
      await this.warmBase();
      this.blockContext = "ticket";
      const res = await this.inPageFetch(`${SSB_PATH}/term/search?mode=preReg`, {
        method: "POST",
        form: { term, studyPath: "", studyPathText: "", startDatepicker: "", endDatepicker: "", uniqueSessionId: this.uniqueSessionId },
      });
      if (res.status !== 200) throw new BannerSessionError("term_search_failed");
      // The registration page token is replaced by this page's, so registration must re-select its term.
      this.activeTerm = null;
      this.termEligibility.clear();
      const browser = this.requireBrowser();
      try {
        await browser.navigate(`${BANNER_ORIGIN}${PREPARE_REGISTRATION_PATH}`);
      } catch {
        // fall through to the content wait
      }
      if (new URL(browser.url() || "about:blank").hostname !== new URL(BANNER_ORIGIN).hostname) {
        await this.dropSession("login_required");
        throw new BannerSessionError("login_required");
      }
      // The ticket section loads after the page. Wait for a ticket label or a "no ticket" message.
      await browser.waitFor(TICKET_READY_EXPR, 15_000);
      let text = "";
      try {
        text = (await browser.evaluate<string>(TICKET_TEXT_EXPR)) ?? "";
      } catch {
        text = "";
      }
      if (looksLikeLogin(text)) {
        await this.dropSession("login_required");
        throw new BannerSessionError("login_required");
      }
      const parsed = parseTicket(text);
      if (parsed.status === "unreadable" && this.blockedTotal > blockedBefore) return { status: "unreadable" };
      return parsed;
    } finally {
      this.blockContext = null;
      this.readingTicket = false;
      this.ticketDone = null;
      release();
    }
  }

  // ---------- API objects ----------

  /** Read-only API. Built as a fresh object so it structurally carries no write method. */
  readApi(): BannerReadApi {
    return {
      ensureWarm: term => this.ensureWarm(term),
      readSchedule: term => this.readSchedule(term),
      readScheduleDetailed: term => this.readScheduleDetailed(term),
      eligibility: term => this.eligibility(term),
      lookupCrn: (term, crn) => this.lookupCrn(term, crn),
      blockedWrites: () => this.blockedWrites(),
    };
  }

  /**
   * The raw logged-in browser, for user-run probe scripts only. Rehearsal mode only: there the
   * interceptor can never be authorized (writeApi refuses), so every write stays blocked.
   */
  probeBrowser(): BrowserSession | null {
    if (this.deps.config.mode !== "rehearsal") throw new BannerSessionError("probe_requires_rehearsal");
    return this.current === "warm" ? this.browser : null;
  }

  /** Write API. Only in live mode. */
  writeApi(): BannerWriteApi {
    if (this.deps.config.mode !== "live") throw new BannerSessionError("not_live");
    return {
      ...this.readApi(),
      withAuthorizedBatch: async (batch, fn) => {
        if (this.authorized || this.batchPending) throw new BannerSessionError("batch_in_flight");
        this.batchPending = true; // readTicket refuses to start from here on
        try {
          await this.ticketIdle();
          // A ticket read before this batch left Banner on Prepare for Registration. Select the term
          // again so the batch runs against the registration page for this term.
          if (this.activeTerm !== batch.term) {
            const e = await this.selectTerm(batch.term);
            if (!e.allowed) throw new BannerSessionError("term_not_open");
          }
          this.authorized = { term: batch.term, addCrns: [...batch.addCrns], dropCrn: batch.dropCrn };
          return await fn();
        } finally {
          this.authorized = null;
          this.batchPending = false;
        }
      },
      addCrnItems: async (term, crns): Promise<AddItemRow[]> => {
        if (this.readingTicket) throw new BannerSessionError("ticket_read_in_flight");
        const res = await this.inPageFetch(`${SSB_PATH}/classRegistration/addCRNRegistrationItems`, { method: "POST", form: { crnList: crns.join(","), term } });
        const rows = parseAddItems(res.body);
        if (!rows) throw new BannerSessionError("add_items_unparseable");
        return rows;
      },
      workingSet: async (term): Promise<RegistrationModel[]> => {
        const res = await this.inPageFetch(workingSetPath(term));
        const models = parseWorkingSet(res.body, term);
        if (!models) throw new BannerSessionError("working_set_unreadable");
        return models;
      },
      submitBatch: async (models): Promise<SubmitRow[]> => {
        if (this.readingTicket) throw new BannerSessionError("ticket_read_in_flight");
        const res = await this.inPageFetch(`${SSB_PATH}/classRegistration/submitRegistration/batch`, {
          method: "POST",
          json: { create: [], update: models, destroy: [], uniqueSessionId: this.uniqueSessionId },
        });
        const rows = parseSubmitBatch(res.body);
        if (!rows) throw new BannerSessionError("submit_unparseable");
        return rows;
      },
    };
  }
}
