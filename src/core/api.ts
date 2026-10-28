// HTTP API contract between src/api (server) and web/ (client). JSON everywhere.
// Errors: non-2xx with body { error: string } (a user-facing sentence).

import type {
  AnyFilters,
  AppEvent,
  CourseDetail,
  PublicSettings,
  SearchHit,
  SettingsPatch,
  Snapshot,
  Term,
  WantedCourse,
} from "./types";
import type { RehearsalReport } from "./contracts";

export interface Api {
  // state
  "GET /api/state": { res: Snapshot };
  "GET /api/events?before&limit": { res: AppEvent[] };
  // SSE: GET /api/stream -> StreamMessage frames (data: JSON), starts with { type: "hello", snapshot }

  // catalog
  "GET /api/terms": { res: Term[] };
  "GET /api/search?term&q": { res: SearchHit[] }; // q matches code ("cs 225", "225"), title, instructor, or CRN
  "GET /api/course/:term/:subject/:number": { res: CourseDetail }; // includes live seats fetched on demand
  "POST /api/catalog/sync": { body: { term: string }; res: { ok: true } };

  // watchlist
  "POST /api/wanted": {
    body: { term: string; subject: string; number: string; title: string; kind: "bundles" | "any"; bundles?: string[][]; filters?: AnyFilters };
    res: WantedCourse;
  };
  "PATCH /api/wanted/:id": { body: Partial<Pick<WantedCourse, "kind" | "filters" | "swapDropCrn">>; res: WantedCourse };
  "DELETE /api/wanted/:id": { res: { ok: true } };
  "POST /api/wanted/reorder": { body: { ids: number[] }; res: { ok: true } };
  "POST /api/wanted/:id/arm": { res: WantedCourse };
  "POST /api/wanted/:id/disarm": { res: WantedCourse };
  "POST /api/wanted/:id/reset": { res: WantedCourse }; // unblock bundles, back to watching
  "PUT /api/wanted/:id/bundles": { body: { bundles: string[][] }; res: WantedCourse }; // replace ranked list
  "DELETE /api/bundles/:id": { res: { ok: true } };

  // control
  "POST /api/control/pause": { res: { ok: true } };
  "POST /api/control/resume": { res: { ok: true } };
  "POST /api/guard/clear": { res: { ok: true } };
  "POST /api/session/login": { res: { ok: true } };
  "POST /api/session/logout": { res: { ok: true } };
  "POST /api/session/pause": { body: { minutes: number | null }; res: { ok: true } }; // null = resume now
  "POST /api/rehearsal": { body: { term: string }; res: RehearsalReport };
  "POST /api/live": { body: { enabled: boolean; confirmText?: string }; res: PublicSettings }; // confirmText must equal the term label, e.g. "Spring 2027"
  "POST /api/swaps/unlock": { body: { confirmText: string }; res: PublicSettings }; // only after a passing swap test

  // settings
  "GET /api/settings": { res: PublicSettings };
  "PUT /api/settings": { body: SettingsPatch; res: PublicSettings }; // discordToken: string sets, null removes
  "POST /api/notify/test/:channel": { res: { ok: boolean; detail: string } }; // channel = discord | push
  "GET /api/push/vapid": { res: { publicKey: string } };
  "POST /api/push/subscribe": { body: PushSubscriptionJSON; res: { ok: true } };
  "POST /api/push/unsubscribe": { body: { endpoint: string }; res: { ok: true } };

  // approvals
  "POST /api/approvals/:id/approve": { res: { ok: boolean; detail: string } };
  "POST /api/approvals/:id/skip": { res: { ok: boolean; detail: string } };

  // simulated mode only (404 otherwise)
  "GET /api/sim": { res: { seats: { crn: string; term: string; available: number; max: number }[]; schedule: Record<string, string[]> } };
  "POST /api/sim/seats": { body: { term: string; crn: string; available: number; max?: number }; res: { ok: true } };
  "POST /api/sim/error": { body: { crn: string | null; message: string }; res: { ok: true } };
  "POST /api/sim/schedule": { body: { term: string; crns: string[] }; res: { ok: true } };

  // health (public, plain text "ok")
  "GET /healthz": { res: string };
}
