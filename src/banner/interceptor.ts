// Network-level write gate for the Banner browser session (Chrome DevTools Fetch domain).
// Every request to banner.apps.uillinois.edu pauses here; writes go through only for the one authorized batch.

import type { BrowserSession } from "../auth/browser";
import { selectedActionKind } from "./guard";

export interface AuthorizedBatch {
  term: string;
  addCrns: string[];
  dropCrn: string | null;
}

export interface InterceptedRequest {
  method: string;
  url: string;
  postData?: string | null;
  /** The request has a body that was not made available for inspection. Writes then block. */
  bodyUnavailable?: boolean;
  /** False when the request comes from a subframe, worker, or another target. Writes then block. */
  fromMainFrame?: boolean;
}

export type WriteDecision = "allow" | "block";

const BANNER_HOST = "banner.apps.uillinois.edu";
const SSB = "/studentregistrationssb/ssb/";

/** GETs under classRegistration known to be read-only (calendar, working-set reset, page itself). */
const READ_ONLY_GETS = new Set([
  "classregistration",
  "getregistrationevents",
  "reset",
  "getsectioncatalogdetails",
  "getclassdetails",
  "getenrollmentinfo",
]);

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== a.length || sb.size !== b.length || sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function formParams(postData: string | null | undefined): URLSearchParams | null {
  if (typeof postData !== "string") return null;
  try {
    return new URLSearchParams(postData);
  } catch {
    return null;
  }
}

function decideAddItems(url: URL, postData: string | null | undefined, auth: AuthorizedBatch): WriteDecision {
  // Values may arrive in the body or the query; both must agree when both are present.
  const body = formParams(postData) ?? new URLSearchParams();
  const pick = (name: string) => {
    const values = [...body.getAll(name), ...url.searchParams.getAll(name)];
    if (values.length === 0) return null;
    return values.every(v => v === values[0]) ? values[0]! : undefined;
  };
  const term = pick("term");
  const crnList = pick("crnList");
  if (!term || !crnList || term !== auth.term) return "block";
  const crns = crnList.split(",").map(s => s.trim()).filter(Boolean);
  return sameSet(crns, auth.addCrns) ? "allow" : "block";
}

const SUBMIT_KEYS = new Set(["create", "update", "destroy", "uniqueSessionId"]);

function decideSubmit(postData: string | null | undefined, auth: AuthorizedBatch): WriteDecision {
  if (typeof postData !== "string" || !postData) return "block";
  let body: any;
  try {
    body = JSON.parse(postData);
  } catch {
    return "block";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "block";
  if (Object.keys(body).some(key => !SUBMIT_KEYS.has(key))) return "block";
  const create = body.create ?? [];
  const destroy = body.destroy ?? [];
  const update = body.update ?? [];
  if (!Array.isArray(create) || !Array.isArray(destroy) || !Array.isArray(update)) return "block";
  if (create.length > 0 || destroy.length > 0 || update.length === 0) return "block";
  const allowed = new Set(auth.addCrns);
  const seen = new Set<string>();
  for (const model of update) {
    if (!model || typeof model !== "object") return "block";
    const crn = String(model.courseReferenceNumber ?? "");
    if (!crn || seen.has(crn) || String(model.term ?? "") !== auth.term) return "block";
    seen.add(crn);
    const kind = selectedActionKind(model);
    if (allowed.has(crn)) {
      if (kind !== "add") return "block";
      continue;
    }
    if (auth.dropCrn && crn === auth.dropCrn) {
      if (kind !== "drop") return "block";
      continue;
    }
    return "block";
  }
  for (const crn of allowed) if (!seen.has(crn)) return "block";
  return "allow";
}

/**
 * Decide whether a Banner request may proceed. Pure. Conservative: anything that could change
 * registration and is not the exact authorized batch is blocked.
 */
export function decideWrite(req: InterceptedRequest, authorized: AuthorizedBatch | null): WriteDecision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "block";
  }
  const method = (req.method || "GET").toUpperCase();
  // Any port or scheme on the Banner host is Banner.
  if (url.hostname.toLowerCase().replace(/\.$/, "") !== BANNER_HOST) return "allow";
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return "block";
  }
  // Drop matrix params (";jsessionid=...") and collapse slashes so lookalike paths classify the same.
  path = path.toLowerCase().replace(/;[^/]*/g, "").replace(/\/{2,}/g, "/");
  if (path.includes("/../") || path.includes("/./")) return "block";
  const at = path.indexOf(SSB);
  if (at < 0) return "allow"; // SAML endpoints, static assets
  const rest = path.slice(at + SSB.length).replace(/\/$/, "");
  const [area, action = "", ...more] = rest.split("/");

  if (area === "classregistration") {
    if ((action === "addcrnregistrationitems" || action === "submitregistration") && (req.bodyUnavailable || req.fromMainFrame === false)) return "block";
    if (action === "addcrnregistrationitems") {
      return authorized && more.length === 0 ? decideAddItems(url, req.postData, authorized) : "block";
    }
    if (action === "addregistrationitem") return "block"; // never used by this app
    if (action === "submitregistration") {
      return authorized ? decideSubmit(req.postData, authorized) : "block";
    }
    if ((method === "GET" || method === "HEAD") && more.length === 0 && READ_ONLY_GETS.has(action)) return "allow";
    // Unknown classRegistration calls (any method) are blocked.
    return "block";
  }
  // Registration writes might hide under other areas in future Banner versions.
  if (/registration/.test(area ?? "") && area !== "registration" && method !== "GET" && method !== "HEAD") return "block";
  return "allow";
}

export interface InstalledInterceptor {
  blockedCount(): number;
  blocked(): { method: string; url: string; at: number }[];
  uninstall(): Promise<void>;
}

export class InterceptorUnavailable extends Error {
  constructor() {
    super("Write interceptor needs the chrome backend");
    this.name = "InterceptorUnavailable";
  }
}

/** Strip query strings before anything is logged or stored. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

/** Page-side guard injected into every new document: no service workers (they would sit outside Fetch). */
export const NO_SERVICE_WORKER_SCRIPT = `(() => {
  try {
    if (navigator.serviceWorker) {
      const reject = () => Promise.reject(new DOMException('Service workers are disabled', 'SecurityError'));
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { value: reject, configurable: false, writable: false });
    }
  } catch (e) {}
})()`;

/** True for a path the interceptor treats as a registration write (used for frame checks). */
export function isWritePath(rawUrl: string): boolean {
  return decideWrite({ method: "POST", url: rawUrl, postData: null }, null) === "block" && /banner\.apps\.uillinois\.edu/i.test(rawUrl);
}

/**
 * Pause EVERY request of this page target via CDP Fetch (urlPattern "*") and continue or fail it per
 * decideWrite, deciding by hostname so any port or scheme on the Banner host is covered. Non-Banner
 * requests continue untouched. Throws InterceptorUnavailable on a backend without CDP (webkit).
 *
 * Child targets. Fetch on the page session sees requests from the main frame and same-process
 * subframes (each with its frameId). Out-of-process iframes, dedicated workers that Chrome runs as
 * separate targets, and service workers can have their own network sessions that this Fetch handler
 * does not see. Bun.WebView's cdp() is scoped to the page session and cannot address child sessions
 * (no sessionId parameter), so we cannot run Fetch inside them or resume them after
 * waitForDebuggerOnStart. Mitigations instead:
 *   1. navigator.serviceWorker.register is disabled in every new document (addScriptToEvaluateOnNewDocument).
 *   2. A Banner write path is blocked unless it comes from the main frame (frameId check), so a
 *      same-process iframe or an unattributed request cannot carry a write.
 *   3. Target.setAutoAttach (flatten, not paused) runs only to observe: every attached child target
 *      whose URL is on the Banner host is reported through onBlocked as a "child_target" so the session
 *      can treat it as an incident.
 * Residual risk: a Banner write issued by an out-of-process child target would bypass this handler.
 * Banner pages are same-origin with the main frame (same process, so visible here), and this app never
 * opens Banner in a child frame, so the only remaining path is page script on Banner itself spawning a
 * worker that posts a registration write, which the guard and post-submit diff would still detect.
 */
export async function installInterceptor(
  session: BrowserSession,
  getAuthorized: () => AuthorizedBatch | null,
  onBlocked: (info: { method: string; url: string }) => void,
): Promise<InstalledInterceptor> {
  const cdp = session.cdp?.bind(session);
  const on = session.onCdpEvent?.bind(session);
  if (session.backend !== "chrome" || !cdp || !on) throw new InterceptorUnavailable();
  const blocked: { method: string; url: string; at: number }[] = [];
  const report = (info: { method: string; url: string }) => {
    blocked.push({ ...info, at: Date.now() });
    try {
      onBlocked(info);
    } catch {
      // observer errors never unblock
    }
  };
  let mainFrameId: string | null = null;
  const refreshMainFrame = async () => {
    try {
      const tree = await cdp<any>("Page.getFrameTree");
      mainFrameId = typeof tree?.frameTree?.frame?.id === "string" ? tree.frameTree.frame.id : null;
    } catch {
      mainFrameId = null;
    }
  };

  const offs: (() => void)[] = [];
  offs.push(
    on("Fetch.requestPaused", async (params: any) => {
      const requestId = params?.requestId;
      const request = params?.request ?? {};
      const url = String(request.url ?? "");
      const method = String(request.method ?? "GET");
      const frameId = typeof params?.frameId === "string" ? params.frameId : null;
      let fromMainFrame = true;
      let onBanner = false;
      try {
        onBanner = new URL(url).hostname.toLowerCase().replace(/\.$/, "") === BANNER_HOST;
      } catch {
        onBanner = false;
      }
      if (onBanner && isWritePath(url)) {
        if (frameId === null || frameId !== mainFrameId) await refreshMainFrame();
        fromMainFrame = frameId !== null && frameId === mainFrameId;
      }
      const decision = decideWrite(
        {
          method,
          url,
          postData: request.postData ?? null,
          // CDP omits large bodies; a body we cannot read never authorizes a write.
          bodyUnavailable: Boolean(request.hasPostData) && typeof request.postData !== "string",
          fromMainFrame,
        },
        getAuthorized(),
      );
      if (decision === "allow") {
        void cdp("Fetch.continueRequest", { requestId }).catch(() => {});
      } else {
        void cdp("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
        report({ method, url: redactUrl(url) });
      }
    }),
  );
  offs.push(
    on("Target.attachedToTarget", (params: any) => {
      const info = params?.targetInfo ?? {};
      try {
        if (new URL(String(info.url ?? "")).hostname === BANNER_HOST) report({ method: `child_target:${String(info.type ?? "unknown")}`, url: redactUrl(String(info.url)) });
      } catch {
        // about:blank and similar
      }
    }),
  );

  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: NO_SERVICE_WORKER_SCRIPT, runImmediately: true });
  await refreshMainFrame();
  // Observation only (see above). Failure here is not fatal: the frame check already fails closed.
  await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  return {
    blockedCount: () => blocked.length,
    blocked: () => [...blocked],
    uninstall: async () => {
      for (const off of offs) off();
      await cdp("Fetch.disable").catch(() => {});
    },
  };
}
