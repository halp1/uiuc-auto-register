// Anonymous live seat counts from Banner's class search fragment endpoint (no login, no cookie).

import { SeatSourceError, type SeatSource } from "../core/contracts";
import type { SeatInfo } from "../core/types";

export const BANNER_BASE = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb";
export const MEP_CODE = "1UIUC";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface EnrollmentInfo {
  enrolled: number;
  max: number;
  available: number;
}

function labeledNumber(html: string, label: string): number | null {
  const pattern = new RegExp(`${label}:\\s*</span>\\s*<span[^>]*>\\s*(-?\\d+)\\s*<`, "i");
  const match = pattern.exec(html);
  return match ? Number(match[1]) : null;
}

/** Parse the getEnrollmentInfo HTML fragment. Returns null when the labels are missing. */
export function parseEnrollmentInfo(html: string): EnrollmentInfo | null {
  const enrolled = labeledNumber(html, "Enrollment Actual");
  const max = labeledNumber(html, "Enrollment Maximum");
  const available = labeledNumber(html, "Enrollment Seats Available");
  if (enrolled === null || max === null || available === null) return null;
  return { enrolled, max, available };
}

const LOGIN_MARKERS = /saml2?\/authenticate|eis\.apps\.uillinois\.edu|idpproxy|shibboleth|SAMLRequest|login\.microsoftonline/i;

/** True when a body or redirect target points at the SSO login flow. */
export function looksLikeLogin(text: string | null | undefined): boolean {
  return Boolean(text && LOGIN_MARKERS.test(text));
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export interface AnonymousSeatSourceOptions {
  fetch?: FetchLike;
  base?: string;
  /** Max simultaneous requests. */
  concurrency?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Gap between consecutive requests on one worker, to spread load. */
  spreadMs?: number;
  now?: () => number;
}

type Outcome =
  | { ok: true; seat: Omit<SeatInfo, "changedAt"> }
  | { ok: false; reason: SeatSourceError["reason"]; fatal: boolean; retryAfterMs: number | null; detail: string };

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class AnonymousSeatSource implements SeatSource {
  readonly kind = "anonymous" as const;
  private fetchImpl: FetchLike;
  private base: string;
  private concurrency: number;
  private timeoutMs: number;
  private spreadMs: number;
  private now: () => number;

  constructor(options: AnonymousSeatSourceOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = options.base ?? BANNER_BASE;
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.spreadMs = Math.max(0, options.spreadMs ?? 60);
    this.now = options.now ?? Date.now;
  }

  url(term: string, crn: string): string {
    const params = new URLSearchParams({ term, courseReferenceNumber: crn, mepCode: MEP_CODE });
    return `${this.base}/searchResults/getEnrollmentInfo?${params}`;
  }

  private async fetchOne(term: string, crn: string, signal?: AbortSignal): Promise<Outcome> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    let body: string;
    try {
      response = await this.fetchImpl(this.url(term, crn), {
        redirect: "manual",
        signal: combined,
        headers: { Accept: "text/html, */*" },
      });
      body = response.status >= 300 && response.status < 400 ? "" : await response.text();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return { ok: false, reason: "network", fatal: false, retryAfterMs: null, detail: String((error as Error)?.message ?? error) };
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      // Any redirect from this anonymous endpoint means Banner now wants a login.
      return { ok: false, reason: "login_required", fatal: true, retryAfterMs: null, detail: `HTTP ${status} to ${response.headers.get("location") ?? "?"}` };
    }
    if (status === 401 || status === 403) {
      return { ok: false, reason: "login_required", fatal: true, retryAfterMs: null, detail: `HTTP ${status}` };
    }
    if (status === 429) {
      return { ok: false, reason: "rate_limited", fatal: true, retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), this.now()), detail: "HTTP 429" };
    }
    if (status >= 400) {
      // Banner answers 500 for unknown CRNs, so one 5xx is a per-CRN failure; all-5xx makes the source unusable.
      return { ok: false, reason: "server_error", fatal: false, retryAfterMs: null, detail: `HTTP ${status}` };
    }
    const parsed = parseEnrollmentInfo(body);
    if (!parsed) {
      return { ok: false, reason: "login_required", fatal: looksLikeLogin(body), retryAfterMs: null, detail: "Enrollment labels missing" };
    }
    return { ok: true, seat: { term, crn, ...parsed, checkedAt: this.now() } };
  }

  async fetchSeats(term: string, crns: string[], signal?: AbortSignal): Promise<Omit<SeatInfo, "changedAt">[]> {
    const unique = [...new Set(crns)];
    if (unique.length === 0) return [];
    const seats: Omit<SeatInfo, "changedAt">[] = [];
    const failures: Extract<Outcome, { ok: false }>[] = [];
    let fatal: Extract<Outcome, { ok: false }> | null = null;
    let index = 0;
    const workers = Math.min(this.concurrency, unique.length);

    const worker = async (workerIndex: number) => {
      if (this.spreadMs && workerIndex > 0) await delay((this.spreadMs * workerIndex) / workers, signal);
      let first = true;
      while (!fatal) {
        const i = index++;
        if (i >= unique.length) return;
        if (!first && this.spreadMs) await delay(this.spreadMs, signal);
        first = false;
        const outcome = await this.fetchOne(term, unique[i]!, signal);
        if (outcome.ok) seats.push(outcome.seat);
        else {
          failures.push(outcome);
          if (outcome.fatal && !fatal) fatal = outcome;
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));

    const stop = fatal as Extract<Outcome, { ok: false }> | null;
    if (stop) throw new SeatSourceError(`Anonymous seat source: ${stop.detail}`, stop.reason, stop.retryAfterMs);
    if (seats.length === 0 && failures.length > 0) {
      const counts = new Map<SeatSourceError["reason"], number>();
      for (const failure of failures) counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);
      const [reason] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      throw new SeatSourceError(`Anonymous seat source: all ${failures.length} requests failed (${failures[0]!.detail})`, reason);
    }
    return seats;
  }
}
