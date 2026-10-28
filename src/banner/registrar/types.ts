// Internal types and pure parsers shared by the Banner session, the rehearsal registrar, and the live registrar.

import type { AuthorizedBatch } from "../interceptor";
import type { RegistrationModel } from "../guard";

export const SSB_PATH = "/StudentRegistrationSSB/ssb";

/** Result of a fetch run inside the logged-in page. */
export interface InPageResponse {
  status: number;
  /** Final URL after redirects, without the query string. */
  url: string;
  redirected: boolean;
  loginPage: boolean; // X-Login-Page: true
  contentType: string | null;
  body: string;
}

export interface InPageInit {
  method?: "GET" | "POST";
  /** Form fields (sent urlencoded) or a JSON value. Never a credential. */
  form?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
}

export type ScheduleStrategy = "registrationEvents" | "classRegistrationReset" | "registrationHistory";
export const SCHEDULE_STRATEGIES: ScheduleStrategy[] = ["registrationEvents", "classRegistrationReset", "registrationHistory"];

export interface ScheduleRead {
  crns: string[];
  /** Strategies that answered with a parseable response. */
  strategies: ScheduleStrategy[];
}

export interface Eligibility {
  allowed: boolean;
  messages: string[];
}

export interface CrnLookup {
  crn: string;
  exists: boolean;
  title: string | null;
}

/** What the rehearsal path may use. There is deliberately no write method here. */
export interface BannerReadApi {
  ensureWarm(term: string): Promise<void>;
  readSchedule(term: string): Promise<string[]>;
  readScheduleDetailed(term: string): Promise<ScheduleRead>;
  eligibility(term: string): Promise<Eligibility>;
  lookupCrn(term: string, crn: string): Promise<CrnLookup>;
  blockedWrites(): number;
}

export interface AddItemRow {
  crn: string;
  success: boolean;
  message: string | null;
  model: RegistrationModel | null;
}

export interface SubmitRow {
  crn: string;
  ok: boolean;
  message: string | null;
  statusDescription: string | null;
}

/** Live-only additions. Only LiveRegistrar and the swap test receive this. */
export interface BannerWriteApi extends BannerReadApi {
  /** Run fn with the interceptor authorized for exactly this batch; always de-authorizes afterwards. */
  withAuthorizedBatch<T>(batch: AuthorizedBatch, fn: () => Promise<T>): Promise<T>;
  addCrnItems(term: string, crns: string[]): Promise<AddItemRow[]>;
  /** Registered models for the term from the working set (needed to drop a CRN). */
  workingSet(term: string): Promise<RegistrationModel[]>;
  submitBatch(models: RegistrationModel[]): Promise<SubmitRow[]>;
}

// ---------- parsers ----------

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const CRN_RE = /^\d{5}$/;
const REGISTERED_STATUS = /regist|enrol/i;
const NOT_REGISTERED = /drop|delet|withdr|error|cancel|fail|wait/i;

function crnOf(obj: any): string | null {
  const raw = obj?.courseReferenceNumber ?? obj?.crn;
  const crn = raw === undefined || raw === null ? "" : String(raw).trim();
  return CRN_RE.test(crn) ? crn : null;
}

function statusText(obj: any): string | null {
  const parts = [obj?.statusDescription, obj?.registrationStatusDescription, obj?.courseRegistrationStatusDescription]
    .filter(v => typeof v === "string" && v.trim());
  return parts.length ? parts.join(" ") : null;
}

/** Objects in a JSON tree that carry a CRN. Bounded walk. */
function crnObjects(root: unknown): any[] {
  const out: any[] = [];
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length && visited < 20_000) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node && typeof node === "object") {
      if (crnOf(node)) out.push(node);
      else for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
    }
  }
  return out;
}

/** Keys under which a Banner JSON object may hold its list of registration rows. */
const ROW_KEYS = ["data", "registrations", "aaData", "rows", "models", "update", "events"];
const ERROR_KEYS = ["error", "errors", "exception", "errorMessage"];

/**
 * The list of registration rows in a schedule-like response, or null when the body does not have the
 * expected shape: not JSON, error-shaped ({success:false}, {error:...}), no row array, or rows that are
 * not objects or carry no CRN at all. An empty row array is well-shaped (a genuinely empty schedule).
 */
export function scheduleRows(parsed: unknown): any[] | null {
  let rows: unknown;
  if (Array.isArray(parsed)) rows = parsed;
  else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj.success === false || ERROR_KEYS.some(key => obj[key] !== undefined && obj[key] !== null && obj[key] !== "")) return null;
    const key = ROW_KEYS.find(k => Array.isArray(obj[k]));
    if (!key) return null;
    rows = obj[key];
  } else return null;
  const list = rows as unknown[];
  if (!list.every(row => row !== null && typeof row === "object" && !Array.isArray(row))) return null;
  if (list.length > 0 && crnObjects(list).length === 0) return null;
  return list;
}

/**
 * Extract registered CRNs from a schedule-like JSON response. Returns null unless the body is
 * well-shaped (see scheduleRows), so error bodies never pass as an empty schedule. Objects with a status
 * must look registered; objects without one count (calendar events only exist for registered sections).
 * A term field, when present, must match.
 */
export function parseScheduleJson(body: string, term: string): string[] | null {
  const rows = scheduleRows(safeJson(body));
  if (!rows) return null;
  const crns = new Set<string>();
  for (const obj of crnObjects(rows)) {
    const objTerm = obj.term ?? obj.termCode;
    if (objTerm !== undefined && objTerm !== null && String(objTerm) !== term) continue;
    const status = statusText(obj);
    if (status && (!REGISTERED_STATUS.test(status) || NOT_REGISTERED.test(status))) continue;
    crns.add(crnOf(obj)!);
  }
  return [...crns].sort();
}

/** Working-set models for a term (classRegistration/reset). */
export function parseWorkingSet(body: string, term: string): RegistrationModel[] | null {
  const parsed = safeJson(body);
  if (parsed === undefined || parsed === null || typeof parsed !== "object") return null;
  return crnObjects(parsed)
    .filter(obj => Array.isArray(obj.registrationActions) && String(obj.term ?? "") === term)
    .map(obj => ({ ...obj, courseReferenceNumber: crnOf(obj)! })) as RegistrationModel[];
}

export function parseTermSearch(body: string): Eligibility | null {
  const parsed = safeJson(body) as any;
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.fwdURL === "string" && parsed.regAllowed !== false) return { allowed: true, messages: [] };
  const failures = Array.isArray(parsed.studentEligFailures) ? parsed.studentEligFailures : [];
  const messages = failures
    .map((f: any) => (typeof f === "string" ? f : typeof f?.message === "string" ? f.message : null))
    .filter((m: string | null): m is string => Boolean(m))
    .map((m: string) => m.replace(/<[^>]*>/g, "").trim())
    .slice(0, 20);
  if (parsed.regAllowed === false || failures.length) return { allowed: false, messages };
  return null;
}

export function parseAddItems(body: string): AddItemRow[] | null {
  const parsed = safeJson(body) as any;
  if (!parsed || !Array.isArray(parsed.aaData)) return null;
  return parsed.aaData.map((row: any) => ({
    crn: String(row?.courseReferenceNumber ?? row?.model?.courseReferenceNumber ?? ""),
    success: row?.success === true,
    message: typeof row?.message === "string" && row.message ? row.message : null,
    model: row?.model && typeof row.model === "object" ? (row.model as RegistrationModel) : null,
  }));
}

export function parseSubmitBatch(body: string): SubmitRow[] | null {
  const parsed = safeJson(body) as any;
  if (!parsed || typeof parsed !== "object") return null;
  const update = Array.isArray(parsed?.data?.update) ? parsed.data.update : Array.isArray(parsed?.update) ? parsed.update : null;
  if (!update) return null;
  return update.map((row: any) => {
    const errors: string[] = Array.isArray(row?.crnErrors)
      ? row.crnErrors.map((e: any) => (typeof e?.message === "string" ? e.message : null)).filter(Boolean)
      : [];
    const status = typeof row?.statusDescription === "string" ? row.statusDescription : null;
    const ok = row?.errorFlag !== "F" && errors.length === 0;
    return { crn: String(row?.courseReferenceNumber ?? ""), ok, message: errors.length ? errors.join("; ") : status, statusDescription: status };
  });
}

/** 5 random base36 chars + Date.now(), as Banner's own page script builds it. */
export function makeUniqueSessionId(now = Date.now()): string {
  let prefix = "";
  for (let i = 0; i < 5; i++) prefix += Math.floor(Math.random() * 36).toString(36);
  return `${prefix}${now}`;
}

/** Fixed reason codes for session failures. Never URLs or values. */
export type SessionReason =
  | "missing_credentials"
  | "invalid_totp_secret"
  | "webkit_unsupported"
  | "interceptor_failed"
  | "browser_launch_failed"
  | "login_failed"
  | "login_blocked"
  | "paused"
  | "login_required"
  | "term_not_allowed"
  | "term_search_failed"
  | "token_missing"
  | "schedule_unreadable"
  | "request_failed"
  | "not_warm"
  | "disposed"
  | string;

export class BannerSessionError extends Error {
  constructor(readonly reason: SessionReason) {
    super(`Banner session: ${reason}`);
    this.name = "BannerSessionError";
  }
}
