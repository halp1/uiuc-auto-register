// Shared contract between backend modules, the API, and the web UI.
// Keep this file free of runtime imports so the browser bundle can import it.

export type Mode = "simulated" | "rehearsal" | "live";

export interface Term {
  code: string; // e.g. "120271"
  description: string; // e.g. "Spring 2027"
}

export type Day = "M" | "T" | "W" | "R" | "F" | "S" | "U";

export interface TimeRange {
  start: string; // "HH:MM" 24h
  end: string; // "HH:MM" 24h
}

export interface AnyFilters {
  excludeDays: Day[];
  excludeTimes: TimeRange[];
  excludeInstructors: string[];
}

export type CourseState = "watching" | "registered" | "blocked";
export type BundleState = "watching" | "open" | "pending_approval" | "registering" | "blocked" | "registered";

export interface Bundle {
  id: number;
  courseId: number;
  rank: number; // 0 = most preferred
  crns: string[];
  state: BundleState;
  blockedReason: string | null;
  generated: boolean; // produced by "any valid combination"
}

export interface WantedCourse {
  id: number;
  term: string;
  subject: string; // "CS"
  number: string; // "225"
  title: string;
  priority: number; // 0 = highest
  armed: boolean;
  kind: "bundles" | "any";
  filters: AnyFilters;
  swapDropCrn: string | null;
  state: CourseState;
  createdAt: number;
  updatedAt: number;
  bundles: Bundle[];
}

export interface SeatInfo {
  term: string;
  crn: string;
  available: number;
  max: number;
  enrolled: number;
  checkedAt: number; // epoch ms
  changedAt: number; // epoch ms of last change in `available`
}

// Events that can be routed to notification channels.
export const NOTIFY_EVENTS = [
  "bundle_opened",
  "approval_needed",
  "registered",
  "registration_failed",
  "session_error",
  "guard_tripped",
  "poller_degraded",
  "restarted",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type EventKind =
  | NotifyEvent
  | "seat_changed"
  | "approval_resolved"
  | "attempt"
  | "login_stage"
  | "session_state"
  | "rehearsal_result"
  | "settings_changed"
  | "control"
  | "catalog_synced"
  | "info";

export type Severity = "info" | "success" | "warning" | "critical";

export interface AppEvent {
  id: number;
  ts: number;
  kind: EventKind;
  severity: Severity;
  title: string;
  detail: string | null;
  courseId: number | null;
  bundleId: number | null;
  crns: string[];
  payload: unknown;
}

export type NewEvent = Omit<AppEvent, "id" | "ts" | "detail" | "courseId" | "bundleId" | "crns" | "payload"> & {
  ts?: number;
  detail?: string | null;
  courseId?: number | null;
  bundleId?: number | null;
  crns?: string[];
  payload?: unknown;
};

export interface Route {
  discord: boolean;
  push: boolean;
}

export interface Settings {
  approvalMode: "auto" | "approve";
  approvalAutoAfterMin: number | null; // approve mode: auto-register after N minutes, null = never
  pollIntervalSec: number; // >= 10
  jitterPct: number; // 0..50
  overnightSlow: boolean;
  activeTerm: string | null;
  ticketAt: string | null; // ISO timestamp of registration window opening
  liveEnabled: boolean;
  liveTerm: string | null;
  swapsUnlocked: boolean;
  globalPaused: boolean;
  sessionPausedUntil: number | null;
  discordToken: string | null; // never sent to the client
  discordUserId: string | null;
  routing: Record<NotifyEvent, Route>;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null; // never sent to the client
}

// What the client receives.
export type PublicSettings = Omit<Settings, "discordToken" | "vapidPrivateKey"> & {
  discordTokenHint: string | null; // e.g. "4f2a" (last 4) when set
};

export type SettingsPatch = Partial<Omit<Settings, "vapidPublicKey" | "vapidPrivateKey" | "liveEnabled" | "liveTerm" | "swapsUnlocked">>;

export type ApprovalState = "pending" | "approved" | "skipped" | "expired" | "auto";

export interface Approval {
  id: number;
  bundleId: number;
  courseId: number;
  crns: string[];
  label: string; // "CS 225 AL1 + AYB"
  state: ApprovalState;
  createdAt: number;
  remindAt: number | null;
  autoAt: number | null;
  resolvedAt: number | null;
}

export type FailureClass = "transient" | "permanent" | "unknown";

export interface RegisterRequest {
  term: string;
  bundleId: number;
  addCrns: string[];
  dropCrn: string | null;
}

export interface RegisterRowResult {
  crn: string;
  ok: boolean;
  message: string | null;
}

export interface RegisterResult {
  outcome: "success" | "failed" | "dry_run" | "aborted";
  rows: RegisterRowResult[];
  classification: FailureClass | null;
  message: string | null;
  ms: number;
}

export type PollerState = "idle" | "running" | "backoff" | "degraded" | "paused";
export type SessionState = "cold" | "logging_in" | "warm" | "paused" | "error";

export interface SystemStatus {
  mode: Mode; // effective env mode
  backend: "chrome" | "webkit";
  globalPaused: boolean;
  liveEnabled: boolean;
  liveTerm: string | null;
  guardTripped: { at: number; detail: string } | null;
  poller: {
    state: PollerState;
    source: "anonymous" | "authenticated" | "simulated";
    intervalSec: number;
    lastCycleAt: number | null;
    nextCycleAt: number | null;
    lastCycleMs: number | null;
    watchedCrns: number;
    errorStreak: number;
  };
  session: {
    state: SessionState;
    since: number | null;
    lastKeepaliveAt: number | null;
    pausedUntil: number | null;
    lastError: string | null;
    stage: string | null;
  };
  ticket: { at: string | null; phase: "none" | "waiting" | "prewarm" | "firing" | "done" };
  catalog: { term: string | null; syncedAt: number | null; courses: number; syncing: boolean };
  startedAt: number;
}

// Catalog / search
export interface Meeting {
  type: string; // "LEC" | "LBD" | "DIS" ...
  typeName: string;
  days: string; // "MWF"
  start: string | null; // "09:00" 24h
  end: string | null;
  building: string | null;
  room: string | null;
  instructors: string[];
}

export interface Section {
  crn: string;
  section: string; // "AL1"
  type: string; // primary meeting type code
  typeName: string;
  partOfTerm: string | null;
  meetings: Meeting[];
  seats: SeatInfo | null;
}

export interface CourseSummary {
  term: string;
  subject: string;
  number: string;
  title: string;
  creditHours: string | null;
  sectionCount: number;
}

export interface CourseDetail extends CourseSummary {
  description: string | null;
  scheduleInfo: string | null;
  sections: Section[];
  linkedOptions: Record<string, string[][]>; // crn -> options (each option = linked crns)
}

export interface SearchHit extends CourseSummary {
  matchedCrn: string | null;
  matchedInstructor: string | null;
}

// SSE messages from /api/stream
export type StreamMessage =
  | { type: "hello"; snapshot: Snapshot }
  | { type: "event"; event: AppEvent }
  | { type: "status"; status: SystemStatus }
  | { type: "seats"; seats: SeatInfo[] }
  | { type: "wanted"; wanted: WantedCourse[] }
  | { type: "approvals"; approvals: Approval[] }
  | { type: "settings"; settings: PublicSettings };

export interface Snapshot {
  status: SystemStatus;
  settings: PublicSettings;
  wanted: WantedCourse[];
  seats: SeatInfo[];
  approvals: Approval[];
  events: AppEvent[];
  terms: Term[];
}
