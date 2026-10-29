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
  planId: number | null; // set when a plan targeted this course
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
  discord: boolean; // bot DM
  push: boolean;
  webhook: boolean; // Discord channel webhook
}

export type OnboardingStep = "security" | "account" | "login" | "test" | "live" | "notify" | "done";
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ["security", "account", "login", "test", "live", "notify", "done"];

// ---------- app access (who may open this app) ----------

/** "password": a password (and any passkeys) is needed to open the app. "none": anyone who can reach it. */
export type AuthMode = "none" | "password";

/** GET /api/auth/status. Public, so it says nothing beyond what the sign-in screen needs. */
export interface AuthStatus {
  /** null until setup's first step chooses. The app is open until then. */
  mode: AuthMode | null;
  /** This browser may use the app (always true when mode is not "password"). */
  authenticated: boolean;
  /** At least one passkey is registered for this address, so the sign-in screen offers it. */
  passkeyLogin: boolean;
  /** This address can use passkeys at all: https or localhost, never a bare IP like 127.0.0.1. */
  passkeysSupported: boolean;
  /** Unused recovery codes. Only when authenticated in password mode, otherwise null. */
  recoveryCodesLeft: number | null;
}

/** A signed-in browser, for Settings, Security. */
export interface AuthSessionInfo {
  id: string; // public id, not the cookie
  current: boolean;
  device: string; // e.g. "Chrome on macOS"
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  remember: boolean;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** The address it works on (passkeys are tied to the domain). */
  host: string;
}

export interface Settings {
  mode: Mode; // switched in Settings, the app restarts its Banner side on change
  netid: string | null;
  password: string | null; // encrypted at rest, never sent to the client
  totpSecret: string | null; // encrypted at rest, never sent to the client
  onboardingStep: OnboardingStep; // starts at "security"
  approvalMode: "auto" | "approve";
  approvalAutoAfterMin: number | null; // approve mode: auto-register after N minutes, null = never
  pollIntervalSec: number; // >= 10
  jitterPct: number; // 0..50
  overnightSlow: boolean;
  activeTerm: string | null;
  ticketAt: string | null; // ISO timestamp of registration window opening
  ticketAuto: boolean; // keep ticketAt in sync with Banner's Prepare for Registration page
  ticketSource: "manual" | "banner" | null; // where ticketAt came from (server-managed)
  ticketCheckedAt: number | null; // last Banner check (server-managed)
  ticketCheckedTerm: string | null; // term of the last Banner check (server-managed)
  liveEnabled: boolean;
  liveTerm: string | null;
  swapsUnlocked: boolean;
  globalPaused: boolean;
  sessionLoggedOut: boolean; // the user pressed Log out (server-managed)
  discordToken: string | null; // never sent to the client
  discordUserId: string | null;
  discordWebhookUrl: string | null; // never sent to the client
  routing: Record<NotifyEvent, Route>;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null; // never sent to the client
}

// What the client receives.
export type PublicSettings = Omit<Settings, "password" | "totpSecret" | "discordToken" | "discordWebhookUrl" | "vapidPrivateKey"> & {
  passwordSet: boolean;
  totpSet: boolean;
  discordTokenHint: string | null; // e.g. "4f2a" (last 4) when set
  discordWebhookHint: string | null; // last 4 of the webhook token when set
};

export type SettingsPatch = Partial<
  Omit<Settings, "mode" | "netid" | "password" | "totpSecret" | "onboardingStep" | "vapidPublicKey" | "vapidPrivateKey" | "liveEnabled" | "liveTerm" | "swapsUnlocked" | "sessionLoggedOut" | "ticketSource" | "ticketCheckedAt" | "ticketCheckedTerm">
>;

/** POST /api/setup/login. reason is a fixed code such as browser_launch_failed or password_rejected. */
export type SetupLoginResult = { ok: true } | { ok: false; reason: string };

/** One registration window from Banner's Prepare for Registration page. ISO timestamps. */
export interface TicketWindow {
  start: string;
  end: string | null;
}

/** What the Prepare for Registration page said about the time ticket. */
export type TicketParse =
  | { status: "found"; windows: TicketWindow[] }
  | { status: "none" } // Banner says there is no time ticket
  | { status: "unreadable" };

export interface TicketDetectResult {
  term: string;
  found: boolean;
  ticketAt: string | null; // the window that applies now or next
  windows: TicketWindow[];
  applied: boolean; // settings.ticketAt was updated
  checkedAt: number;
}

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
export type SessionState = "cold" | "logging_in" | "warm" | "error";

export interface SystemStatus {
  mode: Mode; // the mode the running app was started in
  restarting: boolean; // a mode change is in progress
  hotReload: boolean; // started with bun --hot: Live cannot be turned on
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
    loggedOut: boolean; // the user logged out, so the app does not keep a session open on its own
    lastError: string | null;
    stage: string | null;
  };
  ticket: { at: string | null; phase: "none" | "waiting" | "prewarm" | "firing" | "done" };
  catalog: { term: string | null; syncedAt: number | null; courses: number; syncing: boolean };
  progress: ScheduleProgress | null; // active term only
  startedAt: number;
}

/**
 * How close the active term is to the schedule the user wants. The goal is the targeted plan when there is
 * one, otherwise every armed course on the watchlist. Credits are catalog credit hours (lowest value of a range).
 */
export interface ScheduleProgress {
  term: string;
  source: "plan" | "watchlist";
  planId: number | null;
  planName: string | null;
  courses: { subject: string; number: string; credits: number | null; variable: boolean; state: "registered" | "watching" | "unarmed" | "blocked" }[];
  registeredCourses: number;
  totalCourses: number;
  registeredCredits: number;
  totalCredits: number;
  creditsKnown: boolean; // false when some course has no credit hours in the catalog
  scheduleCheckedAt: number | null; // last time Banner's schedule was read for this term
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
  | { type: "settings"; settings: PublicSettings }
  | { type: "plans"; term: string; plans: Plan[] };

// Schedule planner
export interface PlanBreak {
  days: Day[];
  start: string; // "HH:MM" 24h
  end: string;
}

export type PlanSort = "open" | "days" | "start" | "end" | "gaps";

export interface PlanCourse {
  id: number;
  planId: number;
  subject: string;
  number: string;
  title: string;
  included: boolean;
  excludedCrns: string[];
  locked: string[] | null; // one exact bundle, or null
  backups: boolean; // add fitting alternates as lower ranked bundles when targeting
  position: number;
}

export interface PlanPick {
  subject: string;
  number: string;
  crns: string[];
}

export interface PlanTarget {
  at: number;
  picks: PlanPick[];
}

export interface Plan {
  id: number;
  term: string;
  name: string;
  position: number;
  breaks: PlanBreak[];
  ignoreRegistered: boolean;
  openOnly: boolean;
  sort: PlanSort;
  target: PlanTarget | null;
  courses: PlanCourse[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanScheduleStats {
  days: number; // distinct days with timed meetings
  start: string | null; // earliest timed meeting start
  end: string | null; // latest timed meeting end
  gapMin: number; // idle minutes between meetings, summed over days
  closed: number; // sections known to have no open seat
  minSeats: number | null; // lowest known availability
}

export interface PlanSchedule {
  key: string; // sorted CRNs joined by ","
  picks: PlanPick[];
  stats: PlanScheduleStats;
}

export type PlanCourseStatus = "ok" | "no_options" | "not_offered" | "registered" | "excluded";

export type PlanSection = Section & { subject: string; number: string };

export interface PlanGenerateResult {
  schedules: PlanSchedule[]; // sorted, at most 200
  total: number; // valid schedules found before slicing
  truncated: boolean; // search stopped at the cap or time budget
  courses: { subject: string; number: string; options: number; status: PlanCourseStatus }[];
  fixed: { crn: string; subject: string | null; number: string | null }[];
  sections: Record<string, PlanSection>; // every referenced CRN, for the calendar
  generatedAt: number;
}

export interface Snapshot {
  status: SystemStatus;
  settings: PublicSettings;
  wanted: WantedCourse[];
  seats: SeatInfo[];
  approvals: Approval[];
  events: AppEvent[];
  terms: Term[];
}
