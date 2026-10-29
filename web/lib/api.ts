import type { RehearsalReport } from "../../src/core/contracts";
import type {
  AnyFilters,
  AppEvent,
  CourseDetail,
  Plan,
  PlanCourse,
  PlanGenerateResult,
  PlanPick,
  PublicSettings,
  SearchHit,
  SettingsPatch,
  TicketDetectResult,
  Snapshot,
  WantedCourse,
} from "../../src/core/types";

export const isMock = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (isMock) {
    const mock = await import("../dev/mock");
    return mock.mockRequest(method, path, body) as Promise<T>;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "x-auto-register": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("Could not reach the server. Check that it is running.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

export type SimState = {
  seats: { crn: string; term: string; available: number; max: number }[];
  schedule: Record<string, string[]>;
};

export const api = {
  state: () => request<Snapshot>("GET", "/api/state"),
  events: (before: number | null, limit = 50) =>
    request<AppEvent[]>("GET", `/api/events?${before != null ? `before=${before}&` : ""}limit=${limit}`),

  search: (term: string, q: string) => request<SearchHit[]>("GET", `/api/search?term=${enc(term)}&q=${enc(q)}`),
  course: (term: string, subject: string, number: string, signal?: AbortSignal) =>
    request<CourseDetail>("GET", `/api/course/${enc(term)}/${enc(subject)}/${enc(number)}`, undefined, signal),
  syncCatalog: (term: string) => request<{ ok: true }>("POST", "/api/catalog/sync", { term }),

  createWanted: (body: {
    term: string;
    subject: string;
    number: string;
    title: string;
    kind: "bundles" | "any";
    bundles?: string[][];
    filters?: AnyFilters;
  }) => request<WantedCourse>("POST", "/api/wanted", body),
  patchWanted: (id: number, body: Partial<Pick<WantedCourse, "kind" | "filters" | "swapDropCrn">>) =>
    request<WantedCourse>("PATCH", `/api/wanted/${id}`, body),
  deleteWanted: (id: number) => request<{ ok: true }>("DELETE", `/api/wanted/${id}`),
  reorder: (ids: number[]) => request<{ ok: true }>("POST", "/api/wanted/reorder", { ids }),
  arm: (id: number) => request<WantedCourse>("POST", `/api/wanted/${id}/arm`),
  disarm: (id: number) => request<WantedCourse>("POST", `/api/wanted/${id}/disarm`),
  reset: (id: number) => request<WantedCourse>("POST", `/api/wanted/${id}/reset`),
  putBundles: (id: number, bundles: string[][]) => request<WantedCourse>("PUT", `/api/wanted/${id}/bundles`, { bundles }),

  plans: (term: string) => request<Plan[]>("GET", `/api/plans?term=${enc(term)}`),
  createPlan: (term: string, name: string) => request<Plan>("POST", "/api/plans", { term, name }),
  patchPlan: (id: number, body: Partial<Pick<Plan, "name" | "breaks" | "ignoreRegistered" | "openOnly" | "sort">>) =>
    request<Plan>("PATCH", `/api/plans/${id}`, body),
  deletePlan: (id: number) => request<{ ok: true }>("DELETE", `/api/plans/${id}`),
  addPlanCourse: (id: number, subject: string, number: string) =>
    request<Plan>("POST", `/api/plans/${id}/courses`, { subject, number }),
  patchPlanCourse: (id: number, cid: number, body: Partial<Pick<PlanCourse, "included" | "excludedCrns" | "locked" | "backups">>) =>
    request<Plan>("PATCH", `/api/plans/${id}/courses/${cid}`, body),
  deletePlanCourse: (id: number, cid: number) => request<Plan>("DELETE", `/api/plans/${id}/courses/${cid}`),
  generatePlan: (id: number) => request<PlanGenerateResult>("POST", `/api/plans/${id}/generate`),
  targetPlan: (id: number, picks: PlanPick[]) =>
    request<{ plan: Plan; wanted: WantedCourse[] }>("POST", `/api/plans/${id}/target`, { picks }),

  pauseAll: () => request<{ ok: true }>("POST", "/api/control/pause"),
  resumeAll: () => request<{ ok: true }>("POST", "/api/control/resume"),
  clearGuard: () => request<{ ok: true }>("POST", "/api/guard/clear"),
  login: () => request<{ ok: true }>("POST", "/api/session/login"),
  logout: () => request<{ ok: true }>("POST", "/api/session/logout"),
  pauseSession: (minutes: number | null) => request<{ ok: true }>("POST", "/api/session/pause", { minutes }),
  rehearsal: (term: string) => request<RehearsalReport>("POST", "/api/rehearsal", { term }),
  live: (enabled: boolean, confirmText?: string) =>
    request<PublicSettings>("POST", "/api/live", { enabled, confirmText }),

  putSettings: (patch: SettingsPatch) => request<PublicSettings>("PUT", "/api/settings", patch),
  detectTicket: (term: string) => request<TicketDetectResult>("POST", "/api/ticket/detect", { term }),
  testNotify: (channel: "discord" | "push") =>
    request<{ ok: boolean; detail: string }>("POST", `/api/notify/test/${channel}`),
  vapid: () => request<{ publicKey: string }>("GET", "/api/push/vapid"),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<{ ok: true }>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>("POST", "/api/push/unsubscribe", { endpoint }),

  approve: (id: number) => request<{ ok: boolean; detail: string }>("POST", `/api/approvals/${id}/approve`),
  skip: (id: number) => request<{ ok: boolean; detail: string }>("POST", `/api/approvals/${id}/skip`),

  sim: () => request<SimState>("GET", "/api/sim"),
  simSeats: (body: { term: string; crn: string; available: number; max?: number }) =>
    request<{ ok: true }>("POST", "/api/sim/seats", body),
  simError: (body: { crn: string | null; message: string }) => request<{ ok: true }>("POST", "/api/sim/error", body),
};
