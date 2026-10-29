import { SCHEDULE_READER } from "../banner/registrar/types";
import { isTermCode, termLabel } from "../core/terms";
import { PLAN_LIMITS } from "../core/db";
import {
  NOTIFY_EVENTS,
  type AnyFilters,
  type Day,
  type Plan,
  type PlanBreak,
  type PlanCourse,
  type PlanPick,
  type PlanSort,
  type Settings,
  type SettingsPatch,
  type Snapshot,
  type StreamMessage,
} from "../core/types";
import { PlanError } from "../engine/plans";
import { TicketDetectError } from "../engine/ticket-detect";
import { normalizeWebhookUrl } from "../notify/webhook";
import type { AppServices } from "./services";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function body<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new HttpError(413, "Request is too large.");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function id(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id.");
  return n;
}

const CRN = /^\d{5}$/;
const DAYS: Day[] = ["M", "T", "W", "R", "F", "S", "U"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validCrns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) throw new HttpError(400, "A bundle needs 1 to 6 CRNs.");
  const crns = value.map(String);
  if (!crns.every(crn => CRN.test(crn))) throw new HttpError(400, "CRNs are 5 digit numbers.");
  if (new Set(crns).size !== crns.length) throw new HttpError(400, "A bundle cannot repeat a CRN.");
  return crns;
}

function validBundles(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, "Too many bundles.");
  return value.map(validCrns);
}

function validFilters(value: unknown): AnyFilters {
  const v = (value ?? {}) as Partial<AnyFilters>;
  const excludeDays = (v.excludeDays ?? []).filter((d): d is Day => DAYS.includes(d as Day));
  const excludeTimes = (v.excludeTimes ?? []).filter(r => r && HHMM.test(r.start) && HHMM.test(r.end) && r.start < r.end);
  const excludeInstructors = (v.excludeInstructors ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 20);
  return { excludeDays, excludeTimes, excludeInstructors };
}

const PLAN_SORTS: PlanSort[] = ["open", "days", "start", "end", "gaps"];
const SUBJECT = /^[A-Za-z]{2,5}$/;
const NUMBER = /^\d{3}[A-Za-z]?$/;

function validPlanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 60) throw new HttpError(400, "Plan names are 1 to 60 characters.");
  return name;
}

function validBreaks(value: unknown): PlanBreak[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Breaks must be a list.");
  if (value.length > PLAN_LIMITS.breaks) throw new HttpError(400, `A plan can have up to ${PLAN_LIMITS.breaks} breaks.`);
  return value.map(raw => {
    const days = Array.isArray(raw?.days) ? [...new Set(raw.days.map(String))] : [];
    if (!days.length || !days.every(day => DAYS.includes(day as Day))) throw new HttpError(400, "Each break needs at least one day.");
    if (!HHMM.test(String(raw?.start)) || !HHMM.test(String(raw?.end)) || raw.start >= raw.end)
      throw new HttpError(400, "Each break needs a start before its end.");
    return { days: DAYS.filter(day => days.includes(day)), start: String(raw.start), end: String(raw.end) };
  });
}

function validPlanPatch(raw: any): Partial<Pick<Plan, "name" | "breaks" | "ignoreRegistered" | "openOnly" | "sort">> {
  const patch: Partial<Pick<Plan, "name" | "breaks" | "ignoreRegistered" | "openOnly" | "sort">> = {};
  const b = raw ?? {};
  if (b.name !== undefined) patch.name = validPlanName(b.name);
  if (b.breaks !== undefined) patch.breaks = validBreaks(b.breaks);
  if (b.ignoreRegistered !== undefined) patch.ignoreRegistered = Boolean(b.ignoreRegistered);
  if (b.openOnly !== undefined) patch.openOnly = Boolean(b.openOnly);
  if (b.sort !== undefined) {
    if (!PLAN_SORTS.includes(b.sort)) throw new HttpError(400, "Unknown sort.");
    patch.sort = b.sort;
  }
  return patch;
}

function validPlanCoursePatch(raw: any): Partial<Pick<PlanCourse, "included" | "excludedCrns" | "locked" | "backups">> {
  const patch: Partial<Pick<PlanCourse, "included" | "excludedCrns" | "locked" | "backups">> = {};
  const b = raw ?? {};
  if (b.included !== undefined) patch.included = Boolean(b.included);
  if (b.backups !== undefined) patch.backups = Boolean(b.backups);
  if (b.excludedCrns !== undefined) {
    if (!Array.isArray(b.excludedCrns)) throw new HttpError(400, "Excluded CRNs must be a list.");
    const crns = [...new Set(b.excludedCrns.map(String))] as string[];
    if (crns.length > PLAN_LIMITS.excludedCrns) throw new HttpError(400, `Exclude up to ${PLAN_LIMITS.excludedCrns} CRNs.`);
    if (!crns.every(crn => CRN.test(crn))) throw new HttpError(400, "CRNs are 5 digit numbers.");
    patch.excludedCrns = crns;
  }
  if (b.locked !== undefined) patch.locked = b.locked === null ? null : validCrns(b.locked);
  return patch;
}

function validPicks(value: unknown): PlanPick[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "Pick a schedule first.");
  if (value.length > PLAN_LIMITS.coursesPerPlan) throw new HttpError(400, "Too many courses.");
  return value.map(raw => {
    if (!SUBJECT.test(String(raw?.subject ?? "")) || !NUMBER.test(String(raw?.number ?? ""))) throw new HttpError(400, "That is not a valid course.");
    return { subject: String(raw.subject).toUpperCase(), number: String(raw.number).toUpperCase(), crns: validCrns(raw.crns) };
  });
}

function validSettingsPatch(raw: any, current: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  const p = (raw ?? {}) as SettingsPatch;
  if (p.approvalMode !== undefined) {
    if (p.approvalMode !== "auto" && p.approvalMode !== "approve") throw new HttpError(400, "Approval mode must be auto or approve.");
    patch.approvalMode = p.approvalMode;
  }
  if (p.approvalAutoAfterMin !== undefined) {
    const v = p.approvalAutoAfterMin;
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1440)) throw new HttpError(400, "Auto-register delay must be 1 to 1440 minutes.");
    patch.approvalAutoAfterMin = v;
  }
  if (p.pollIntervalSec !== undefined) {
    if (!Number.isInteger(p.pollIntervalSec) || p.pollIntervalSec < 10 || p.pollIntervalSec > 3600)
      throw new HttpError(400, "Check interval must be 10 to 3600 seconds.");
    patch.pollIntervalSec = p.pollIntervalSec;
  }
  if (p.jitterPct !== undefined) {
    if (!Number.isInteger(p.jitterPct) || p.jitterPct < 0 || p.jitterPct > 50) throw new HttpError(400, "Jitter must be 0 to 50 percent.");
    patch.jitterPct = p.jitterPct;
  }
  if (p.overnightSlow !== undefined) patch.overnightSlow = Boolean(p.overnightSlow);
  if (p.activeTerm !== undefined) {
    if (p.activeTerm !== null && !isTermCode(p.activeTerm)) throw new HttpError(400, "Unknown term.");
    patch.activeTerm = p.activeTerm;
    // Switching terms always turns Live off: live authorization is per term.
    if (p.activeTerm !== current.activeTerm && current.liveEnabled) {
      patch.liveEnabled = false;
      patch.liveTerm = null;
    }
  }
  if (p.ticketAt !== undefined) {
    if (p.ticketAt !== null && Number.isNaN(Date.parse(p.ticketAt))) throw new HttpError(400, "Time ticket is not a valid date.");
    patch.ticketAt = p.ticketAt === null ? null : new Date(p.ticketAt).toISOString();
    // A ticket typed by hand stays put: automatic detection turns off unless it is turned on in the same save.
    if (patch.ticketAt !== current.ticketAt) {
      patch.ticketSource = patch.ticketAt ? "manual" : null;
      patch.ticketAuto = false;
    }
  }
  if (p.ticketAuto !== undefined) patch.ticketAuto = Boolean(p.ticketAuto);
  if (p.discordToken !== undefined) {
    if (p.discordToken !== null && (typeof p.discordToken !== "string" || p.discordToken.trim().length < 30))
      throw new HttpError(400, "That does not look like a Discord bot token.");
    patch.discordToken = p.discordToken === null ? null : p.discordToken.trim();
  }
  if (p.discordUserId !== undefined) {
    if (p.discordUserId !== null && !/^\d{15,22}$/.test(String(p.discordUserId))) throw new HttpError(400, "Discord user IDs are 15 to 22 digit numbers.");
    patch.discordUserId = p.discordUserId === null ? null : String(p.discordUserId);
  }
  if (p.discordWebhookUrl !== undefined) {
    if (p.discordWebhookUrl === null) patch.discordWebhookUrl = null;
    else {
      const url = normalizeWebhookUrl(p.discordWebhookUrl);
      if (!url) throw new HttpError(400, "That is not a Discord webhook URL. Copy it from Server Settings, Integrations, Webhooks.");
      patch.discordWebhookUrl = url;
    }
  }
  if (p.routing !== undefined) {
    const routing = { ...current.routing };
    for (const event of NOTIFY_EVENTS) {
      const r = (p.routing as any)[event];
      if (r) routing[event] = { discord: Boolean(r.discord), push: Boolean(r.push), webhook: Boolean(r.webhook) };
    }
    patch.routing = routing;
  }
  // globalPaused and sessionLoggedOut go through their own endpoints.
  return patch;
}

function snapshot(s: AppServices, terms: Snapshot["terms"]): Snapshot {
  const settings = s.settings();
  const term = settings.activeTerm;
  return {
    status: s.status(),
    settings: s.store.publicSettings(settings),
    wanted: term ? s.store.listWanted(term) : [],
    seats: term ? s.store.listSeats(term) : [],
    approvals: s.store.pendingApprovals(),
    events: s.store.listEvents(60),
    terms,
  };
}

function sse(s: AppServices, terms: Snapshot["terms"], req: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: StreamMessage) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };
      send({ type: "hello", snapshot: snapshot(s, terms) });
      unsubscribe = s.bus.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Cross-site and DNS-rebinding protection. The app has no login of its own (Cloudflare Access fronts
 * deployments), so any state change must prove it came from this app's own pages:
 *  - a custom header, which a cross-site page cannot send without a CORS preflight we never grant;
 *  - an Origin, when present, that matches the Host;
 *  - on a loopback bind, a loopback Host name (a rebinding attacker's hostname is rejected).
 */
export function checkRequestOrigin(req: Request, opts: { loopbackOnly: boolean }): string | null {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (opts.loopbackOnly && !LOOPBACK_HOSTS.has(hostname)) return "Unexpected host.";
  const unsafe = req.method !== "GET" && req.method !== "HEAD";
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "Bad origin.";
    }
    if (originHost !== host.toLowerCase()) return "Cross-site requests are not allowed.";
  }
  if (unsafe) {
    if (req.headers.get("x-auto-register") !== "1") return "Missing app header.";
    const type = req.headers.get("content-type");
    if (type && !type.toLowerCase().startsWith("application/json")) return "Send JSON.";
  }
  return null;
}

let originOptions = { loopbackOnly: true };
export function configureOriginCheck(options: { loopbackOnly: boolean }) {
  originOptions = options;
}

function wrap(handler: Handler): Handler {
  return async req => {
    try {
      const refused = checkRequestOrigin(req, originOptions);
      if (refused) return json({ error: refused }, 403);
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError || error instanceof PlanError || error instanceof TicketDetectError) return json({ error: error.message }, error.status);
      console.error("api error", req.method, new URL(req.url).pathname, error);
      return json({ error: "Something went wrong on the server. Check the logs." }, 500);
    }
  };
}

export function apiRoutes(s: AppServices) {
  let termsCache: { at: number; terms: Snapshot["terms"] } = { at: 0, terms: [] };
  const terms = async () => {
    if (Date.now() - termsCache.at > 60 * 60 * 1000 || termsCache.terms.length === 0) {
      try {
        termsCache = { at: Date.now(), terms: await s.terms() };
      } catch (error) {
        console.warn("terms lookup failed", error);
      }
    }
    return termsCache.terms;
  };
  const publishWanted = () => {
    const term = s.settings().activeTerm;
    s.bus.publish({ type: "wanted", wanted: term ? s.store.listWanted(term) : [] });
  };
  const publishSettings = () => s.bus.publish({ type: "settings", settings: s.store.publicSettings() });
  const course = (cid: number) => {
    const c = s.store.getWanted(cid);
    if (!c) throw new HttpError(404, "That course is not on your watchlist.");
    return c;
  };
  const requireSim = () => {
    if (!s.sim) throw new HttpError(404, "The simulator only runs in simulated mode.");
    return s.sim;
  };
  const afterWatchlistChange = (reason: string) => {
    publishWanted();
    s.poller.kick();
    s.orchestrator.evaluate(reason);
  };
  const plan = (pid: number) => {
    const p = s.store.getPlan(pid);
    if (!p) throw new HttpError(404, "That plan no longer exists.");
    return p;
  };
  const publishPlans = (term: string) => s.bus.publish({ type: "plans", term, plans: s.store.listPlans(term) });
  /** Respond with the fresh plan and broadcast the term's plans. */
  const planChanged = (pid: number) => {
    const p = plan(pid);
    publishPlans(p.term);
    return json(p);
  };

  const r: Record<string, Handler | Record<string, Handler>> = {
    "/healthz": () => new Response("ok"),

    "/api/state": { GET: async () => json(snapshot(s, await terms())) },
    "/api/stream": { GET: async req => sse(s, await terms(), req) },
    "/api/events": {
      GET: req => {
        const url = new URL(req.url);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const before = url.searchParams.get("before");
        return json(s.store.listEvents(limit, before ? id(before) : undefined));
      },
    },

    "/api/terms": { GET: async () => json(await terms()) },
    "/api/search": {
      GET: req => {
        const url = new URL(req.url);
        const term = url.searchParams.get("term") ?? s.settings().activeTerm;
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
        if (!term || !isTermCode(term)) throw new HttpError(400, "Pick a term first.");
        return json(q ? s.search(term, q) : []);
      },
    },
    "/api/course/:term/:subject/:number": {
      GET: async req => {
        const { term, subject, number } = req.params;
        if (!isTermCode(term) || !/^[A-Za-z]{2,5}$/.test(subject!) || !/^\d{3}[A-Za-z]?$/.test(number!))
          throw new HttpError(400, "That is not a valid course.");
        const detail = await s.courseDetail(term, subject!.toUpperCase(), number!);
        if (!detail) throw new HttpError(404, `${subject!.toUpperCase()} ${number} is not offered in ${termLabel(term)}.`);
        return json(detail);
      },
    },
    "/api/catalog/sync": {
      POST: async req => {
        const { term } = await body<{ term: string }>(req);
        if (!isTermCode(term)) throw new HttpError(400, "Unknown term.");
        if (s.catalog.syncing()) throw new HttpError(409, "A catalog sync is already running.");
        void s.catalog.sync(term, { force: true }).catch(error => console.error("catalog sync failed", error));
        return json({ ok: true });
      },
    },

    "/api/wanted": {
      POST: async req => {
        const b = await body(req);
        if (!isTermCode(b.term)) throw new HttpError(400, "Unknown term.");
        if (!/^[A-Za-z]{2,5}$/.test(b.subject ?? "") || !/^\d{3}[A-Za-z]?$/.test(b.number ?? "")) throw new HttpError(400, "That is not a valid course.");
        if (b.kind !== "bundles" && b.kind !== "any") throw new HttpError(400, "Kind must be bundles or any.");
        const bundles = b.kind === "bundles" ? validBundles(b.bundles ?? []) : [];
        const existing = s.store.listWanted(b.term).find(c => c.subject === b.subject.toUpperCase() && c.number === b.number);
        if (existing) throw new HttpError(409, `${existing.subject} ${existing.number} is already on your watchlist.`);
        const created = s.store.createWanted({
          term: b.term,
          subject: b.subject,
          number: b.number,
          title: String(b.title ?? "").slice(0, 200),
          kind: b.kind,
          filters: validFilters(b.filters),
        });
        if (bundles.length) s.store.setBundles(created.id, bundles.map(crns => ({ crns })));
        afterWatchlistChange("wanted_created");
        return json(s.store.getWanted(created.id), 201);
      },
    },
    "/api/wanted/reorder": {
      POST: async req => {
        const { ids } = await body<{ ids: number[] }>(req);
        if (!Array.isArray(ids)) throw new HttpError(400, "ids must be a list.");
        s.store.reorderWanted(ids.map(v => id(String(v))));
        afterWatchlistChange("reordered");
        return json({ ok: true });
      },
    },
    "/api/wanted/:id": {
      PATCH: async req => {
        const c = course(id(req.params.id));
        const b = await body(req);
        const patch: any = {};
        if (b.kind !== undefined) {
          if (b.kind !== "bundles" && b.kind !== "any") throw new HttpError(400, "Kind must be bundles or any.");
          patch.kind = b.kind;
        }
        if (b.filters !== undefined) patch.filters = validFilters(b.filters);
        if (b.swapDropCrn !== undefined) {
          if (b.swapDropCrn !== null) {
            if (!s.settings().swapsUnlocked) throw new HttpError(403, "Swaps are locked.");
            if (!CRN.test(String(b.swapDropCrn))) throw new HttpError(400, "CRNs are 5 digit numbers.");
          }
          patch.swapDropCrn = b.swapDropCrn === null ? null : String(b.swapDropCrn);
        }
        const updated = s.store.updateWanted(c.id, patch);
        afterWatchlistChange("wanted_updated");
        return json(updated);
      },
      DELETE: req => {
        const c = course(id(req.params.id));
        s.store.deleteWanted(c.id);
        afterWatchlistChange("wanted_deleted");
        return json({ ok: true });
      },
    },
    "/api/wanted/:id/arm": {
      POST: req => {
        const c = course(id(req.params.id));
        if (c.kind === "bundles" && c.bundles.length === 0) throw new HttpError(400, "Add at least one bundle before arming.");
        const updated = s.store.updateWanted(c.id, { armed: true });
        s.events.emit({ kind: "control", severity: "info", title: `Armed ${c.subject} ${c.number}`, courseId: c.id });
        afterWatchlistChange("armed");
        return json(updated);
      },
    },
    "/api/wanted/:id/disarm": {
      POST: req => {
        const c = course(id(req.params.id));
        const updated = s.store.updateWanted(c.id, { armed: false });
        s.events.emit({ kind: "control", severity: "info", title: `Disarmed ${c.subject} ${c.number}`, courseId: c.id });
        afterWatchlistChange("disarmed");
        return json(updated);
      },
    },
    "/api/wanted/:id/reset": {
      POST: req => {
        const c = course(id(req.params.id));
        s.store.tx(() => {
          for (const b of c.bundles) if (b.state === "blocked") s.store.setBundleState(b.id, "watching", null);
          if (c.state === "blocked") s.store.setCourseState(c.id, "watching");
        });
        afterWatchlistChange("reset");
        return json(s.store.getWanted(c.id));
      },
    },
    "/api/wanted/:id/bundles": {
      PUT: async req => {
        const c = course(id(req.params.id));
        const { bundles } = await body(req);
        s.store.setBundles(c.id, validBundles(bundles).map(crns => ({ crns })));
        afterWatchlistChange("bundles_replaced");
        return json(s.store.getWanted(c.id));
      },
    },
    "/api/bundles/:id": {
      DELETE: req => {
        s.store.deleteBundle(id(req.params.id));
        afterWatchlistChange("bundle_deleted");
        return json({ ok: true });
      },
    },

    "/api/plans": {
      GET: req => {
        const term = new URL(req.url).searchParams.get("term") ?? s.settings().activeTerm;
        if (!term || !isTermCode(term)) throw new HttpError(400, "Pick a term first.");
        return json(s.store.listPlans(term));
      },
      POST: async req => {
        const b = await body(req);
        if (!isTermCode(b.term)) throw new HttpError(400, "Unknown term.");
        const name = validPlanName(b.name);
        if (s.store.countPlans(b.term) >= PLAN_LIMITS.plansPerTerm)
          throw new HttpError(409, `You can keep up to ${PLAN_LIMITS.plansPerTerm} plans per term.`);
        const created = s.store.createPlan(b.term, name);
        publishPlans(b.term);
        return json(created, 201);
      },
    },
    "/api/plans/:id": {
      PATCH: async req => {
        const p = plan(id(req.params.id));
        const patch = validPlanPatch(await body(req));
        s.store.updatePlan(p.id, patch);
        return planChanged(p.id);
      },
      DELETE: req => {
        const p = plan(id(req.params.id));
        const linked = s.store.listWanted(p.term).some(course => course.planId === p.id);
        s.store.deletePlan(p.id);
        publishPlans(p.term);
        if (linked) publishWanted();
        return json({ ok: true });
      },
    },
    "/api/plans/:id/courses": {
      POST: async req => {
        const p = plan(id(req.params.id));
        const b = await body(req);
        if (!SUBJECT.test(String(b.subject ?? "")) || !NUMBER.test(String(b.number ?? ""))) throw new HttpError(400, "That is not a valid course.");
        const subject = String(b.subject).toUpperCase();
        const number = String(b.number).toUpperCase();
        if (p.courses.some(c => c.subject === subject && c.number === number)) throw new HttpError(409, `${subject} ${number} is already in this plan.`);
        if (p.courses.length >= PLAN_LIMITS.coursesPerPlan) throw new HttpError(409, `A plan holds up to ${PLAN_LIMITS.coursesPerPlan} courses.`);
        const title = await s.courseTitle(p.term, subject, number).catch(() => null);
        if (title === null) throw new HttpError(404, `${subject} ${number} is not offered in ${termLabel(p.term)}.`);
        s.store.addPlanCourse(p.id, { subject, number, title });
        return planChanged(p.id);
      },
    },
    "/api/plans/:id/courses/:cid": {
      PATCH: async req => {
        const p = plan(id(req.params.id));
        const cid = id(req.params.cid);
        if (!p.courses.some(c => c.id === cid)) throw new HttpError(404, "That course is not in this plan.");
        s.store.updatePlanCourse(p.id, cid, validPlanCoursePatch(await body(req)));
        return planChanged(p.id);
      },
      DELETE: req => {
        const p = plan(id(req.params.id));
        if (!s.store.deletePlanCourse(p.id, id(req.params.cid))) throw new HttpError(404, "That course is not in this plan.");
        return planChanged(p.id);
      },
    },
    "/api/plans/:id/generate": {
      POST: async req => json(await s.planGenerate(plan(id(req.params.id)).id)),
    },
    "/api/plans/:id/target": {
      POST: async req => {
        const p = plan(id(req.params.id));
        const { picks } = await body(req);
        const result = await s.planTarget(p.id, validPicks(picks));
        publishPlans(p.term);
        afterWatchlistChange("plan_targeted");
        return json(result);
      },
    },

    "/api/control/pause": {
      POST: () => {
        s.control.pauseAll("dashboard");
        return json({ ok: true });
      },
    },
    "/api/control/resume": {
      POST: () => {
        if (s.orchestrator.guardState()) throw new HttpError(409, "The schedule guard tripped. Review it and clear it first.");
        s.control.resumeAll("dashboard");
        return json({ ok: true });
      },
    },
    "/api/guard/clear": {
      POST: () => {
        s.orchestrator.clearGuard();
        s.events.emit({ kind: "control", severity: "warning", title: "Schedule guard cleared" });
        s.bus.publish({ type: "status", status: s.status() });
        return json({ ok: true });
      },
    },
    "/api/session/login": {
      POST: async () => {
        if (!s.session) throw new HttpError(409, "There is no Banner session in simulated mode.");
        const term = s.settings().activeTerm;
        if (!term) throw new HttpError(400, "Pick a term first.");
        s.applySettings({ sessionLoggedOut: false });
        void s.session.ensureWarm(term).catch(() => {});
        return json({ ok: true });
      },
    },
    "/api/session/logout": {
      POST: async () => {
        s.applySettings({ sessionLoggedOut: true });
        if (s.session) await s.session.goCold("user");
        return json({ ok: true });
      },
    },
    "/api/rehearsal": {
      POST: async req => {
        const { term } = await body<{ term: string }>(req);
        if (!isTermCode(term)) throw new HttpError(400, "Unknown term.");
        if (s.config.mode === "simulated") throw new HttpError(409, "Testing needs REGISTRATION_MODE=test or live in your .env file.");
        if (!s.config.hasCredentials) throw new HttpError(409, "Add your NetID, password, and TOTP secret to the .env file first.");
        return json(await s.rehearse(term));
      },
    },
    "/api/ticket/detect": {
      POST: async req => {
        const { term } = await body<{ term: string }>(req);
        if (!isTermCode(term)) throw new HttpError(400, "Unknown term.");
        if (s.config.mode === "simulated") throw new HttpError(409, "Reading the time ticket needs REGISTRATION_MODE=test or live in your .env file.");
        if (!s.config.hasCredentials) throw new HttpError(409, "Add your NetID, password, and TOTP secret to the .env file first.");
        return json(await s.detectTicket(term));
      },
    },
    "/api/live": {
      POST: async req => {
        const { enabled, confirmText } = await body<{ enabled: boolean; confirmText?: string }>(req);
        const settings = s.settings();
        if (!enabled) return json(s.applySettings({ liveEnabled: false, liveTerm: null }));
        if (s.config.mode !== "live") throw new HttpError(403, "Live registration needs REGISTRATION_MODE=live in your .env file.");
        if (!s.config.hasCredentials) throw new HttpError(409, "Add your NetID, password, and TOTP secret to the .env file first.");
        const term = settings.activeTerm;
        if (!term) throw new HttpError(400, "Pick a term first.");
        // The schedule reader must be proven on this account first: a passing rehearsal for this term in the last 24 h.
        const rehearsal = s.store
          .listEvents(500)
          .find(e => e.kind === "rehearsal_result" && (e.payload as any)?.term === term && Date.now() - e.ts < 24 * 60 * 60 * 1000);
        const report = rehearsal?.payload as { ok?: boolean; schedule?: string[] | null; reader?: string } | undefined;
        // Only the newest rehearsal counts, and only one made with the current schedule reader.
        if (!report?.ok || !Array.isArray(report.schedule) || report.reader !== SCHEDULE_READER)
          throw new HttpError(409, `Run a test for ${termLabel(term)} in Settings first and check that it found your current classes.`);
        if ((confirmText ?? "").trim() !== termLabel(term)) throw new HttpError(400, `Type ${termLabel(term)} exactly to turn on Live.`);
        const updated = s.applySettings({ liveEnabled: true, liveTerm: term });
        s.events.emit({ kind: "control", severity: "warning", title: `Live registration on for ${termLabel(term)}` });
        return json(updated);
      },
    },
    "/api/swaps/unlock": {
      POST: () => {
        throw new HttpError(403, "Swaps unlock only after a passing swap test on a Winter or Summer term.");
      },
    },

    "/api/settings": {
      GET: () => json(s.store.publicSettings()),
      PUT: async req => {
        const patch = validSettingsPatch(await body(req), s.settings());
        return json(s.applySettings(patch));
      },
    },
    "/api/discord/status": { GET: () => json(s.discordStatus()) },
    "/api/notify/test/:channel": {
      POST: async req => {
        const channel = req.params.channel;
        if (channel !== "discord" && channel !== "push" && channel !== "webhook") throw new HttpError(404, "Unknown channel.");
        return json(await s.notifier.test(channel));
      },
    },
    "/api/push/vapid": {
      GET: () => {
        const key = s.settings().vapidPublicKey;
        if (!key) throw new HttpError(503, "Push keys are not ready yet. Try again in a moment.");
        return json({ publicKey: key });
      },
    },
    "/api/push/subscribe": {
      POST: async req => {
        const sub = await body<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(req);
        if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth)
          throw new HttpError(400, "That push subscription is incomplete.");
        s.store.addPushSubscription(sub as { endpoint: string });
        return json({ ok: true });
      },
    },
    "/api/push/unsubscribe": {
      POST: async req => {
        const { endpoint } = await body<{ endpoint: string }>(req);
        if (endpoint) s.store.removePushSubscription(endpoint);
        return json({ ok: true });
      },
    },

    "/api/approvals/:id/approve": { POST: async req => json(await s.orchestrator.approve(id(req.params.id), "dashboard")) },
    "/api/approvals/:id/skip": { POST: async req => json(await s.orchestrator.skip(id(req.params.id), "dashboard")) },

    "/api/sim": {
      GET: () => {
        const sim = requireSim();
        const state = sim.state();
        return json({ seats: state.seats, schedule: state.schedule, scripted: state.scripted });
      },
    },
    "/api/sim/seats": {
      POST: async req => {
        const sim = requireSim();
        const b = await body(req);
        if (!isTermCode(b.term) || !CRN.test(String(b.crn))) throw new HttpError(400, "Need a term and a 5 digit CRN.");
        const available = Number(b.available);
        if (!Number.isInteger(available) || available < 0 || available > 2000) throw new HttpError(400, "Seats must be 0 to 2000.");
        sim.setSeats(b.term, String(b.crn), available, b.max === undefined ? undefined : Number(b.max));
        s.poller.kick();
        return json({ ok: true });
      },
    },
    "/api/sim/error": {
      POST: async req => {
        const sim = requireSim();
        const b = await body(req);
        if (b.crn !== null && !CRN.test(String(b.crn))) throw new HttpError(400, "CRNs are 5 digit numbers.");
        if (typeof b.message !== "string" || !b.message.trim()) throw new HttpError(400, "Pick an error message.");
        sim.scriptError(b.crn === null ? null : String(b.crn), b.message.trim().slice(0, 200));
        return json({ ok: true });
      },
    },
    "/api/sim/schedule": {
      POST: async req => {
        const sim = requireSim();
        const b = await body(req);
        if (!isTermCode(b.term) || !Array.isArray(b.crns) || !b.crns.every((c: unknown) => CRN.test(String(c))))
          throw new HttpError(400, "Need a term and a list of 5 digit CRNs.");
        sim.setSchedule(b.term, b.crns.map(String));
        return json({ ok: true });
      },
    },
  };

  // Wrap every handler with error handling.
  const routes: Record<string, any> = {};
  for (const [path, value] of Object.entries(r)) {
    routes[path] = typeof value === "function"
      ? wrap(value)
      : Object.fromEntries(Object.entries(value).map(([method, handler]) => [method, wrap(handler)]));
  }
  return { routes, publishSettings };
}
