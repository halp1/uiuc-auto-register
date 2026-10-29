// Fake backend used only when the URL has ?mock=1. Never imported otherwise.
import type { RehearsalReport } from "../../src/core/contracts";
import {
  NOTIFY_EVENTS,
  type AppEvent,
  type AuthSessionInfo,
  type AuthStatus,
  type PasskeyInfo,
  type Approval,
  type Bundle,
  type CourseDetail,
  type Meeting,
  type Day,
  type Plan,
  type PlanBreak,
  type PlanCourse,
  type PlanGenerateResult,
  type PlanPick,
  type PlanSchedule,
  type PlanSection,
  type PlanSort,
  type PublicSettings,
  type SearchHit,
  type SeatInfo,
  type Section,
  type Snapshot,
  type StreamMessage,
  type SystemStatus,
  type WantedCourse,
} from "../../src/core/types";

const TERM = "120271";
const now = Date.now();
const min = 60_000;

type SectionSeed = [crn: string, section: string, type: string, days: string, start: string | null, end: string | null, building: string, room: string, instructor: string, available: number, max: number];

const typeNames: Record<string, string> = {
  LEC: "Lecture",
  LBD: "Laboratory-Discussion",
  DIS: "Discussion/Recitation",
  LAB: "Laboratory",
  "ONL": "Online",
};

interface CourseSeed {
  subject: string;
  number: string;
  title: string;
  credits: string;
  description: string;
  sections: SectionSeed[];
  linked: Record<string, string[][]>;
}

const courses: CourseSeed[] = [
  {
    subject: "CS",
    number: "225",
    title: "Data Structures",
    credits: "4",
    description:
      "Data abstractions: elementary data structures (lists, stacks, queues, and trees) and their implementation using an object-oriented programming language.",
    sections: [
      ["31208", "AL1", "LEC", "MWF", "10:00", "10:50", "Lincoln Hall", "Theater", "Evans, G", 3, 400],
      ["31209", "AL2", "LEC", "MWF", "14:00", "14:50", "Foellinger Auditorium", "", "Fagen-Ulmschneider, W", 0, 450],
      ["31232", "AYA", "LBD", "W", "08:00", "09:50", "Siebel Center", "0218", "Evans, G", 0, 24],
      ["31233", "AYB", "LBD", "W", "10:00", "11:50", "Siebel Center", "0218", "Evans, G", 0, 24],
      ["31234", "AYC", "LBD", "W", "12:00", "13:50", "Siebel Center", "0220", "Evans, G", 2, 24],
      ["31235", "AYD", "LBD", "R", "16:00", "17:50", "Siebel Center", "0220", "Fagen-Ulmschneider, W", 1, 24],
      ["31236", "AYE", "LBD", "R", "18:00", "19:50", "Siebel Center", "0222", "Fagen-Ulmschneider, W", 0, 24],
    ],
    linked: {
      "31208": [["31232"], ["31233"], ["31234"]],
      "31209": [["31235"], ["31236"]],
    },
  },
  {
    subject: "CS",
    number: "374",
    title: "Intro to Algs & Models of Comp",
    credits: "4",
    description: "Analysis of algorithms, major paradigms of algorithm design, and models of computation.",
    sections: [
      ["65088", "AL1", "LEC", "TR", "09:30", "10:45", "Electrical & Computer Eng Bldg", "1002", "Erickson, J", 0, 380],
      ["65093", "AYA", "DIS", "W", "09:00", "09:50", "Siebel Center", "1109", "Chandra, C", 0, 40],
      ["65094", "AYB", "DIS", "W", "11:00", "11:50", "Siebel Center", "1109", "Chandra, C", 0, 40],
      ["65095", "AYC", "DIS", "F", "13:00", "13:50", "Siebel Center", "1131", "Chandra, C", 0, 40],
    ],
    linked: { "65088": [["65093"], ["65094"], ["65095"]] },
  },
  {
    subject: "MATH",
    number: "241",
    title: "Calculus III",
    credits: "4",
    description: "Third course in calculus and analytic geometry including vector analysis.",
    sections: [
      ["58423", "BL1", "LEC", "MWF", "11:00", "11:50", "Altgeld Hall", "314", "Kirkpatrick, K", 12, 200],
      ["58431", "BDA", "DIS", "TR", "08:00", "08:50", "Altgeld Hall", "143", "Staff", 4, 30],
      ["58432", "BDB", "DIS", "TR", "09:00", "09:50", "Altgeld Hall", "143", "Staff", 0, 30],
    ],
    linked: { "58423": [["58431"], ["58432"]] },
  },
  {
    subject: "STAT",
    number: "400",
    title: "Statistics and Probability I",
    credits: "4",
    description: "Introduction to mathematical statistics.",
    sections: [["40121", "X1", "LEC", "TR", "12:30", "13:45", "Lincoln Hall", "1092", "Stepanov, A", 0, 120]],
    linked: {},
  },
  {
    subject: "CS",
    number: "411",
    title: "Database Systems",
    credits: "3 OR 4",
    description: "Examination of the logical organization of databases.",
    sections: [
      ["31352", "Q3", "LEC", "TR", "14:00", "15:15", "Siebel Center", "1404", "Alawini, A", 0, 300],
      ["31353", "Q4", "LEC", "TR", "14:00", "15:15", "Siebel Center", "1404", "Alawini, A", 1, 60],
    ],
    linked: {},
  },
  {
    subject: "CS",
    number: "222",
    title: "Software Design Lab",
    credits: "1",
    description: "Design and implementation of novel software solutions.",
    sections: [["30101", "AL1", "LBD", "", null, null, "", "", "Woodley, M", 22, 400]],
    linked: {},
  },
  {
    subject: "CS",
    number: "173",
    title: "Discrete Structures",
    credits: "3",
    description: "Discrete mathematical structures frequently encountered in the study of computer science.",
    sections: [
      ["39311", "AL1", "LEC", "TR", "12:30", "13:45", "Lincoln Hall", "Theater", "Fleck, M", 6, 350],
      ["39312", "AL2", "LEC", "TR", "15:30", "16:45", "Foellinger Auditorium", "", "Mattox, B", 0, 350],
      ["39320", "ADA", "DIS", "F", "09:00", "09:50", "Siebel Center", "1302", "Staff", 3, 30],
      ["39321", "ADB", "DIS", "F", "11:00", "11:50", "Siebel Center", "1302", "Staff", 0, 30],
      ["39322", "ADC", "DIS", "F", "14:00", "14:50", "Siebel Center", "1304", "Staff", 5, 30],
      ["39323", "ADD", "DIS", "R", "17:00", "17:50", "Siebel Center", "1304", "Staff", 1, 30],
    ],
    linked: {
      "39311": [["39320"], ["39321"], ["39322"]],
      "39312": [["39322"], ["39323"]],
    },
  },
  {
    subject: "CS",
    number: "233",
    title: "Computer Architecture",
    credits: "4",
    description: "Fundamentals of computer architecture.",
    sections: [
      ["31244", "AL1", "LEC", "TR", "11:00", "12:15", "Siebel Center", "1404", "Herman, G", 9, 300],
      ["31246", "AYA", "LBD", "M", "09:00", "10:50", "Siebel Center", "0218", "Herman, G", 3, 24],
    ],
    linked: { "31244": [["31246"]] },
  },
];

// ---------- mutable mock state ----------

const seats = new Map<string, SeatInfo>();
for (const c of courses)
  for (const s of c.sections)
    seats.set(s[0], {
      term: TERM,
      crn: s[0],
      available: s[9],
      max: s[10],
      enrolled: s[10] - s[9],
      checkedAt: now - 4000,
      changedAt: now - 30 * min,
    });

let bundleId = 100;
const mkBundle = (courseId: number, rank: number, crns: string[], state: Bundle["state"] = "watching", extra: Partial<Bundle> = {}): Bundle => ({
  id: ++bundleId,
  courseId,
  rank,
  crns,
  state,
  blockedReason: null,
  generated: false,
  ...extra,
});

const noFilters = { excludeDays: [], excludeTimes: [], excludeInstructors: [] };

let wanted: WantedCourse[] = [
  {
    id: 1,
    term: TERM,
    subject: "CS",
    number: "225",
    title: "Data Structures",
    priority: 0,
    armed: true,
    kind: "bundles",
    filters: noFilters,
    swapDropCrn: null,
    planId: null,
    state: "watching",
    createdAt: now - 3 * 86400_000,
    updatedAt: now - 2 * min,
    bundles: [],
  },
  {
    id: 2,
    term: TERM,
    subject: "CS",
    number: "374",
    title: "Intro to Algs & Models of Comp",
    priority: 1,
    armed: true,
    kind: "any",
    filters: { excludeDays: ["F"], excludeTimes: [{ start: "08:00", end: "09:00" }], excludeInstructors: [] },
    swapDropCrn: null,
    planId: null,
    state: "watching",
    createdAt: now - 3 * 86400_000,
    updatedAt: now - 60 * min,
    bundles: [],
  },
  {
    id: 3,
    term: TERM,
    subject: "MATH",
    number: "241",
    title: "Calculus III",
    priority: 2,
    armed: false,
    kind: "bundles",
    filters: noFilters,
    swapDropCrn: null,
    planId: null,
    state: "watching",
    createdAt: now - 2 * 86400_000,
    updatedAt: now - 5 * 60 * min,
    bundles: [],
  },
  {
    id: 4,
    term: TERM,
    subject: "CS",
    number: "411",
    title: "Database Systems",
    priority: 3,
    armed: true,
    kind: "bundles",
    filters: noFilters,
    swapDropCrn: null,
    planId: null,
    state: "blocked",
    createdAt: now - 2 * 86400_000,
    updatedAt: now - 20 * min,
    bundles: [],
  },
  {
    id: 5,
    term: TERM,
    subject: "STAT",
    number: "400",
    title: "Statistics and Probability I",
    priority: 4,
    armed: true,
    kind: "bundles",
    filters: noFilters,
    swapDropCrn: null,
    planId: null,
    state: "registered",
    createdAt: now - 4 * 86400_000,
    updatedAt: now - 26 * 60 * min,
    bundles: [],
  },
];
wanted[0]!.bundles = [mkBundle(1, 0, ["31208", "31233"]), mkBundle(1, 1, ["31208", "31234"], "pending_approval"), mkBundle(1, 2, ["31209", "31235"])];
wanted[1]!.bundles = [
  mkBundle(2, 0, ["65088", "65093"], "watching", { generated: true }),
  mkBundle(2, 1, ["65088", "65094"], "watching", { generated: true }),
];
wanted[2]!.bundles = [mkBundle(3, 0, ["58423", "58431"]), mkBundle(3, 1, ["58423", "58432"])];
wanted[3]!.bundles = [
  mkBundle(4, 0, ["31353"], "blocked", { blockedReason: "Restricted to Graduate students" }),
  mkBundle(4, 1, ["31352"], "blocked", { blockedReason: "Restricted to Graduate students" }),
];
wanted[4]!.bundles = [mkBundle(5, 0, ["40121"], "registered")];

let approvals: Approval[] = [
  {
    id: 9,
    bundleId: wanted[0]!.bundles[1]!.id,
    courseId: 1,
    crns: ["31208", "31234"],
    label: "CS 225 AL1 + AYC",
    state: "pending",
    createdAt: now - 40_000,
    remindAt: now + 4 * min,
    autoAt: now + 9 * min + 20_000,
    resolvedAt: null,
  },
];

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") as SystemStatus["mode"]) ?? "live";
const scenario = params.get("scenario");
/** ?setup=1 starts a fresh install at the first setup step with nothing saved. */
const fresh = params.get("setup") === "1";

let settings: PublicSettings = {
  mode,
  netid: fresh ? null : "jdoe2",
  passwordSet: !fresh,
  totpSet: !fresh,
  onboardingStep: fresh ? "security" : "done",
  approvalMode: "approve",
  approvalAutoAfterMin: 10,
  pollIntervalSec: 10,
  jitterPct: 20,
  overnightSlow: true,
  activeTerm: TERM,
  ticketAt: new Date(now + 2 * 86400_000 + 3 * 3600_000).toISOString(),
  ticketAuto: true,
  ticketSource: "banner",
  ticketCheckedAt: now - 47 * min,
  ticketCheckedTerm: TERM,
  sessionLoggedOut: false,
  liveEnabled: false,
  liveTerm: null,
  swapsUnlocked: false,
  globalPaused: false,
  discordUserId: "184392011734581248",
  discordTokenHint: "4f2a",
  discordWebhookHint: null,
  routing: Object.fromEntries(
    NOTIFY_EVENTS.map(e => [e, { discord: ["approval_needed", "registered", "registration_failed"].includes(e), push: e === "approval_needed", webhook: false }]),
  ) as PublicSettings["routing"],
  vapidPublicKey: null,
};


if (fresh) {
  settings.discordTokenHint = null;
  settings.discordUserId = null;
  settings.discordWebhookHint = null;
  for (const e of NOTIFY_EVENTS) settings.routing[e] = { discord: false, push: false, webhook: false };
}

let status: SystemStatus = {
  mode,
  restarting: false,
  hotReload: params.get("hot") === "1",
  globalPaused: false,
  liveEnabled: false,
  liveTerm: null,
  guardTripped:
    scenario === "guard"
      ? { at: now - 3 * min, detail: "Schedule after submit had 31110 missing. Expected only 31208 and 31234 to change." }
      : null,
  poller: {
    state: "running",
    source: mode === "simulated" ? "simulated" : "anonymous",
    intervalSec: 10,
    lastCycleAt: now - 4000,
    nextCycleAt: now + 6000,
    lastCycleMs: 412,
    watchedCrns: 9,
    errorStreak: 0,
  },
  session: {
    state: "warm",
    since: now - 42 * min,
    lastKeepaliveAt: now - 3 * min,
    loggedOut: false,
    lastError: null,
    stage: null,
  },
  ticket: { at: settings.ticketAt, phase: "waiting" },
  catalog: { term: TERM, syncedAt: now - 5 * 3600_000, courses: 4211, syncing: false },
  progress:
    scenario === "empty" || fresh
      ? null
      : {
          term: TERM,
          source: "plan",
          planId: 1,
          planName: "Plan 1",
          courses: [
            { subject: "CS", number: "225", credits: 4, variable: false, state: "watching" },
            { subject: "CS", number: "173", credits: 3, variable: false, state: "registered" },
            { subject: "MATH", number: "241", credits: 4, variable: false, state: "unarmed" },
            { subject: "STAT", number: "400", credits: 3, variable: false, state: "registered" },
          ],
          registeredCourses: 2,
          totalCourses: 4,
          registeredCredits: 6,
          totalCredits: 14,
          creditsKnown: true,
          scheduleCheckedAt: mode === "simulated" ? null : now - 12 * min,
        },
  startedAt: now - 3 * 3600_000,
};

let eventId = 500;
const ev = (ago: number, e: Partial<AppEvent> & Pick<AppEvent, "kind" | "severity" | "title">): AppEvent => ({
  id: ++eventId,
  ts: now - ago,
  detail: null,
  courseId: null,
  bundleId: null,
  crns: [],
  payload: null,
  ...e,
});

let events: AppEvent[] = [
  ev(40_000, { kind: "approval_needed", severity: "info", title: "Approval needed for CS 225 AL1 + AYC", courseId: 1, crns: ["31208", "31234"], detail: "Auto registers in 10 min" }),
  ev(42_000, { kind: "bundle_opened", severity: "success", title: "CS 225 AL1 + AYC opened", detail: "31234 went from 0 to 2 seats", courseId: 1, crns: ["31234"] }),
  ev(3 * min, { kind: "seat_changed", severity: "info", title: "MATH 241 BDA seats 5 to 4", crns: ["58431"] }),
  ev(20 * min, { kind: "registration_failed", severity: "warning", title: "CS 411 Q4 blocked", detail: "Restricted to Graduate students", courseId: 4, crns: ["31353"] }),
  ev(42 * min, { kind: "session_state", severity: "info", title: "Session warm", detail: "Logged in with TOTP in 6.2s" }),
  ev(43 * min, { kind: "login_stage", severity: "info", title: "Login started" }),
  ev(70 * min, { kind: "settings_changed", severity: "info", title: "Polling interval set to 10s" }),
  ev(3 * 3600_000, { kind: "restarted", severity: "info", title: "App started", detail: "Simulated mode" }),
  ev(5 * 3600_000, { kind: "catalog_synced", severity: "success", title: "Catalog synced for Spring 2027", detail: "4211 courses" }),
  ev(26 * 3600_000, { kind: "registered", severity: "success", title: "Registered STAT 400 X1", courseId: 5, crns: ["40121"], detail: "Verified on schedule in 1.8s" }),
];
for (let i = 0; i < 60; i++)
  events.push(
    ev(27 * 3600_000 + i * 17 * min, {
      kind: "seat_changed",
      severity: i % 9 === 0 ? "warning" : "info",
      title: i % 9 === 0 ? "Poller slowed down" : `CS 225 AYB seats ${i % 3} to ${(i + 1) % 3}`,
      detail: i % 9 === 0 ? "Banner returned 429, backing off 30s" : null,
    }),
  );
events.sort((a, b) => b.id - a.id);

const terms = [
  { code: "120271", description: "Spring 2027" },
  { code: "120270", description: "Winter 2027" },
  { code: "120268", description: "Fall 2026" },
];

if (scenario === "empty" || fresh) {
  wanted = [];
  approvals = [];
  events = events.slice(-3);
}
if (fresh) status.session = { ...status.session, state: "cold", since: null, lastKeepaliveAt: null };
if (scenario === "session") {
  status.session = { ...status.session, state: "error", lastError: "TOTP code rejected. Check UIUC_TOTP_SECRET." };
}

// ---------- helpers ----------

let emit: ((m: StreamMessage) => void) | null = null;
const push = (m: StreamMessage) => emit?.(m);
const clone = <T>(v: T): T => structuredClone(v);

function snapshot(): Snapshot {
  return {
    status: clone(status),
    settings: clone(settings),
    wanted: clone(wanted),
    seats: [...seats.values()].map(s => ({ ...s })),
    approvals: clone(approvals),
    events: events.slice(0, 50),
    terms,
  };
}

function toSection(s: SectionSeed): Section {
  const meeting: Meeting = {
    type: s[2],
    typeName: typeNames[s[2]] ?? s[2],
    days: s[3],
    start: s[4],
    end: s[5],
    building: s[6] || null,
    room: s[7] || null,
    instructors: [s[8]],
  };
  return {
    crn: s[0],
    section: s[1],
    type: s[2],
    typeName: typeNames[s[2]] ?? s[2],
    partOfTerm: "1",
    meetings: [meeting],
    seats: seats.get(s[0]) ?? null,
  };
}

function detail(subject: string, number: string): CourseDetail | null {
  const c = courses.find(x => x.subject === subject && x.number === number);
  if (!c) return null;
  return {
    term: TERM,
    subject: c.subject,
    number: c.number,
    title: c.title,
    creditHours: c.credits,
    sectionCount: c.sections.length,
    description: c.description,
    scheduleInfo: c.linked && Object.keys(c.linked).length ? "Students must register for one lecture and one linked section." : null,
    sections: c.sections.map(toSection),
    linkedOptions: c.linked,
  };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

class MockError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly auth: string | null = null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

let loginTimer: ReturnType<typeof setTimeout> | null = null;

function findWanted(id: number) {
  const w = wanted.find(x => x.id === id);
  if (!w) throw new MockError("That course is no longer on your watchlist.");
  return w;
}

function pushWanted() {
  push({ type: "wanted", wanted: clone(wanted) });
}

function addEvent(e: Omit<AppEvent, "id" | "ts" | "payload" | "courseId" | "bundleId" | "crns" | "detail"> & Partial<AppEvent>) {
  const full: AppEvent = { id: ++eventId, ts: Date.now(), detail: null, courseId: null, bundleId: null, crns: [], payload: null, ...e };
  events.unshift(full);
  push({ type: "event", event: full });
}

// ---------- request handler ----------

export async function mockRequest(method: string, path: string, body: any): Promise<unknown> {
  await wait(method === "GET" ? 250 : 350);
  const url = new URL(path, "http://x");
  const p = url.pathname;
  const key = `${method} ${p}`;
  let m: RegExpExecArray | null;

  if (p.startsWith("/api/auth/")) return authRequest(method, p, body);
  if (auth.mode === "password" && !auth.authenticated) throw new MockError("Sign in first.", 401, "required");
  if (key === "GET /api/state") return snapshot();
  if (p.startsWith("/api/plans")) return planRequest(method, url, body);
  if (key === "GET /api/events") {
    const before = Number(url.searchParams.get("before") ?? Infinity);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return events.filter(e => e.id < before).slice(0, limit);
  }
  if (key === "GET /api/search") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const term = url.searchParams.get("term");
    if (term !== TERM) return [];
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const c of courses) {
      const code = `${c.subject} ${c.number}`.toLowerCase();
      const crn = c.sections.find(s => s[0] === q)?.[0] ?? null;
      const instr = c.sections.find(s => s[8].toLowerCase().includes(q))?.[8] ?? null;
      if (code.includes(q) || code.replace(" ", "").includes(q.replace(" ", "")) || c.title.toLowerCase().includes(q) || crn || instr)
        hits.push({
          term: TERM,
          subject: c.subject,
          number: c.number,
          title: c.title,
          creditHours: c.credits,
          sectionCount: c.sections.length,
          matchedCrn: crn,
          matchedInstructor: crn ? null : instr,
        });
    }
    return hits;
  }
  if ((m = /^GET \/api\/course\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key))) {
    const d = detail(decodeURIComponent(m[2]!), decodeURIComponent(m[3]!));
    if (!d) throw new MockError("No course with that code in this term.");
    return d;
  }
  if (key === "POST /api/catalog/sync") {
    status = { ...status, catalog: { ...status.catalog, syncing: true } };
    push({ type: "status", status: clone(status) });
    setTimeout(() => {
      status = { ...status, catalog: { ...status.catalog, syncing: false, syncedAt: Date.now() } };
      push({ type: "status", status: clone(status) });
    }, 2500);
    return { ok: true };
  }
  if (key === "POST /api/wanted") {
    const id = Math.max(0, ...wanted.map(w => w.id)) + 1;
    const w: WantedCourse = {
      id,
      term: body.term,
      subject: body.subject,
      number: body.number,
      title: body.title,
      priority: wanted.length,
      armed: false,
      kind: body.kind,
      filters: body.filters ?? noFilters,
      swapDropCrn: null,
      planId: null,
      state: "watching",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bundles: (body.bundles ?? []).map((crns: string[], i: number) => mkBundle(id, i, crns)),
    };
    wanted.push(w);
    pushWanted();
    return w;
  }
  if (key === "POST /api/wanted/reorder") {
    const ids: number[] = body.ids;
    wanted = ids.map((id, i) => ({ ...findWanted(id), priority: i }));
    pushWanted();
    return { ok: true };
  }
  if ((m = /^(POST|PATCH|PUT|DELETE) \/api\/wanted\/(\d+)(?:\/(\w+))?$/.exec(key))) {
    const id = Number(m[2]);
    const action = m[3];
    const w = findWanted(id);
    if (m[1] === "DELETE" && !action) {
      wanted = wanted.filter(x => x.id !== id);
      pushWanted();
      return { ok: true };
    }
    if (action === "arm") w.armed = true;
    else if (action === "disarm") w.armed = false;
    else if (action === "reset") {
      w.state = "watching";
      for (const b of w.bundles) if (b.state === "blocked") Object.assign(b, { state: "watching", blockedReason: null });
    } else if (action === "bundles") w.bundles = body.bundles.map((crns: string[], i: number) => mkBundle(id, i, crns));
    else if (m[1] === "PATCH") Object.assign(w, body);
    w.updatedAt = Date.now();
    pushWanted();
    return clone(w);
  }
  if (key === "POST /api/control/pause" || key === "POST /api/control/resume") {
    const paused = key.endsWith("pause");
    status = { ...status, globalPaused: paused, poller: { ...status.poller, state: paused ? "paused" : "running" } };
    settings = { ...settings, globalPaused: paused };
    push({ type: "status", status: clone(status) });
    addEvent({ kind: "control", severity: "info", title: paused ? "Paused all" : "Resumed all" });
    return { ok: true };
  }
  if (key === "POST /api/guard/clear") {
    status = { ...status, guardTripped: null };
    push({ type: "status", status: clone(status) });
    return { ok: true };
  }
  if (key === "POST /api/session/login") {
    status = { ...status, session: { ...status.session, state: "logging_in", stage: "Duo TOTP", lastError: null, loggedOut: false } };
    push({ type: "status", status: clone(status) });
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      loginTimer = null;
      status = { ...status, session: { ...status.session, state: "warm", since: Date.now(), stage: null } };
      push({ type: "status", status: clone(status) });
    }, 2000);
    return { ok: true };
  }
  if (key === "POST /api/session/logout") {
    // Also cancels a login in progress.
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    status = { ...status, session: { ...status.session, state: "cold", since: Date.now(), loggedOut: true } };
    settings = { ...settings, sessionLoggedOut: true };
    push({ type: "settings", settings: clone(settings) });
    push({ type: "status", status: clone(status) });
    return { ok: true };
  }
  if (key === "POST /api/rehearsal") {
    await wait(1200);
    // Not open yet: Spring opens later, the schedule reader is proven on the open Fall term.
    const opens = new Date(Date.now() + 11 * 86400_000);
    opens.setUTCHours(13, 0, 0, 0);
    const r: RehearsalReport & { opensAt: string | null; readerTerm: string | null } = {
      ok: true,
      startedAt: Date.now() - 9400,
      finishedAt: Date.now(),
      term: body.term,
      steps: [
        { name: "login", ok: true, detail: "Logged in with TOTP", ms: 4570 },
        { name: "term_open", ok: true, detail: `Not open yet. Opens ${opens.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`, ms: 540 },
        { name: "read_schedule", ok: true, detail: "Fall 2026, 9 classes", ms: 910 },
        { name: "crn_31208", ok: true, detail: "CS 225 Data Structures", ms: 300 },
        { name: "crn_58423", ok: true, detail: "MATH 241 Calculus III", ms: 280 },
        { name: "no_writes", ok: true, detail: "0 writes blocked", ms: 4 },
      ],
      eligibility: null,
      schedule: ["70412", "70418", "41022", "41030", "58001", "58014", "31110", "31117", "66520"],
      crnChecks: [],
      blockedWrites: 0,
      opensAt: opens.toISOString(),
      readerTerm: "120268",
    };
    return r;
  }
  if (key === "POST /api/live") {
    if (status.mode !== "live") throw new MockError("Switch the mode to Live first.");
    if (status.hotReload) throw new MockError("Live can't be turned on while running with bun dev. Use bun start.");
    if (body.enabled && body.confirmText !== "Spring 2027") throw new MockError("Type the term exactly as shown.");
    settings = { ...settings, liveEnabled: body.enabled, liveTerm: body.enabled ? TERM : null };
    status = { ...status, liveEnabled: body.enabled, liveTerm: settings.liveTerm };
    push({ type: "settings", settings: clone(settings) });
    push({ type: "status", status: clone(status) });
    return clone(settings);
  }
  if (key === "POST /api/ticket/detect") {
    if (status.mode === "simulated") throw new MockError("Ticket detection needs Test or Live mode.");
    await wait(1400);
    // A ticket a few days out, on the hour, Central time.
    const at = new Date(Date.now() + 3 * 86400_000);
    at.setUTCMinutes(0, 0, 0);
    const ticketAt = at.toISOString();
    const checkedAt = Date.now();
    const applied = settings.ticketAuto;
    settings = {
      ...settings,
      ticketCheckedAt: checkedAt,
      ticketCheckedTerm: body.term,
      ...(applied ? { ticketAt, ticketSource: "banner" as const } : {}),
    };
    push({ type: "settings", settings: clone(settings) });
    if (applied) {
      status = { ...status, ticket: { at: ticketAt, phase: "waiting" } };
      push({ type: "status", status: clone(status) });
    }
    return { term: body.term, found: true, ticketAt, windows: [{ start: ticketAt, end: null }], applied, checkedAt };
  }
  if (key === "PUT /api/credentials") {
    if (body.totpSecret !== undefined && !/^[A-Z2-7 ]{16,}$/i.test(String(body.totpSecret).trim()))
      throw new MockError("That key doesn't look right. Copy the secret key from the Microsoft page again.");
    if (body.netid !== undefined && !/^[a-z][a-z0-9]{1,15}$/i.test(String(body.netid).trim()))
      throw new MockError("Enter your NetID without @illinois.edu.");
    settings = {
      ...settings,
      ...(body.netid !== undefined ? { netid: String(body.netid).trim().toLowerCase() } : {}),
      ...(body.password ? { passwordSet: true } : {}),
      ...(body.totpSecret ? { totpSet: true } : {}),
    };
    push({ type: "settings", settings: clone(settings) });
    return clone(settings);
  }
  if (key === "POST /api/setup/totp-code") {
    const secret = String(body.secret ?? "").replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z2-7]{16,}$/.test(secret)) throw new MockError("That key doesn't look right. Copy the secret key from the Microsoft page again.");
    // Fake but stable per 30 s window and per key.
    const window = Math.floor(Date.now() / 30_000);
    let h = window;
    for (const ch of secret) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000;
    return { code: String(h).padStart(6, "0"), secondsLeft: 30 - Math.floor((Date.now() / 1000) % 30) };
  }
  if (key === "POST /api/setup/login") {
    if (!settings.netid || !settings.passwordSet || !settings.totpSet) return { ok: false, reason: "missing_credentials" };
    const forced = params.get("loginFail");
    const stages = ["Opening Banner", "Microsoft sign in", "Authenticator code", "Loading registration"];
    for (const stage of stages) {
      status = { ...status, session: { ...status.session, state: "logging_in", stage, lastError: null } };
      push({ type: "status", status: clone(status) });
      await wait(500);
    }
    if (forced) {
      status = { ...status, session: { ...status.session, state: "error", stage: null, lastError: forced } };
      push({ type: "status", status: clone(status) });
      return { ok: false, reason: forced };
    }
    status = { ...status, session: { ...status.session, state: "warm", stage: null, since: Date.now(), loggedOut: false } };
    push({ type: "status", status: clone(status) });
    return { ok: true };
  }
  if (key === "PUT /api/setup/step") {
    settings = { ...settings, onboardingStep: body.step };
    push({ type: "settings", settings: clone(settings) });
    return clone(settings);
  }
  if (key === "PUT /api/mode") {
    const next = body.mode as SystemStatus["mode"];
    const changed = next !== status.mode;
    settings = { ...settings, mode: next, ...(next !== "live" ? { liveEnabled: false, liveTerm: null } : {}) };
    status = { ...status, restarting: changed, ...(next !== "live" ? { liveEnabled: false, liveTerm: null } : {}) };
    push({ type: "settings", settings: clone(settings) });
    push({ type: "status", status: clone(status) });
    if (changed)
      setTimeout(() => {
        status = {
          ...status,
          mode: next,
          restarting: false,
          poller: { ...status.poller, source: next === "simulated" ? "simulated" : "anonymous" },
          session: { ...status.session, state: next === "simulated" ? "cold" : status.session.state },
        };
        push({ type: "status", status: clone(status) });
      }, 2200);
    return { ok: true, restarting: changed };
  }
  if (key === "PUT /api/settings") {
    if (body.pollIntervalSec !== undefined && body.pollIntervalSec < 10) throw new MockError("Polling interval must be at least 10 seconds.");
    const { discordToken, discordWebhookUrl, ...rest } = body;
    if (typeof discordWebhookUrl === "string" && !/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(discordWebhookUrl))
      throw new MockError("That is not a Discord webhook URL.");
    const manualTicket = body.ticketAt !== undefined && body.ticketAt !== settings.ticketAt;
    settings = { ...settings, ...rest };
    if (manualTicket) {
      settings.ticketSource = body.ticketAt ? "manual" : null;
      if (body.ticketAuto !== true) settings.ticketAuto = false;
    }
    if (discordToken !== undefined) settings.discordTokenHint = discordToken ? String(discordToken).slice(-4) : null;
    if (discordWebhookUrl !== undefined)
      settings.discordWebhookHint = discordWebhookUrl ? String(discordWebhookUrl).replace(/\/$/, "").slice(-4) : null;
    push({ type: "settings", settings: clone(settings) });
    if (body.ticketAt !== undefined) {
      status = { ...status, ticket: { ...status.ticket, at: body.ticketAt, phase: body.ticketAt ? "waiting" : "none" } };
      push({ type: "status", status: clone(status) });
    }
    return clone(settings);
  }
  if ((m = /^POST \/api\/notify\/test\/(\w+)$/.exec(key))) {
    if (m[1] === "discord" && !settings.discordTokenHint) return { ok: false, detail: "No bot token set." };
    if (m[1] === "webhook") return settings.discordWebhookHint ? { ok: true, detail: "Posted to the channel." } : { ok: false, detail: "No webhook set." };
    return { ok: true, detail: m[1] === "discord" ? "Sent a DM to your account." : "Sent to 1 device." };
  }
  if (key === "GET /api/push/vapid") return { publicKey: "BOrYw0a2b8Zq3hK2yq8m9C4r7lJm2q8f9r3k1p0Qv5w6x7y8z9A0B1C2D3E4F5G6H7I8J9K0L1M2N3O4P5Q6R7S8" };
  if (key === "POST /api/push/subscribe" || key === "POST /api/push/unsubscribe") return { ok: true };
  if ((m = /^POST \/api\/approvals\/(\d+)\/(approve|skip)$/.exec(key))) {
    const a = approvals.find(x => x.id === Number(m![1]));
    if (!a) throw new MockError("That approval already resolved.");
    approvals = approvals.filter(x => x !== a);
    push({ type: "approvals", approvals: clone(approvals) });
    const w = wanted.find(x => x.id === a.courseId);
    if (w) {
      const b = w.bundles.find(x => x.id === a.bundleId);
      if (m[2] === "approve") {
        w.state = "registered";
        if (b) b.state = "registered";
        addEvent({ kind: "registered", severity: "success", title: `Registered ${a.label}`, detail: "Verified on schedule in 1.4s", crns: a.crns });
      } else if (b) b.state = "watching";
      pushWanted();
    }
    return { ok: true, detail: m[2] === "approve" ? "Registered" : "Skipped" };
  }
  if (key === "GET /api/sim") {
    if (status.mode !== "simulated") throw new MockError("Not found");
    return {
      seats: [...seats.values()].map(s => ({ crn: s.crn, term: s.term, available: s.available, max: s.max })),
      schedule: { [TERM]: ["40121", "31110", "58001"] },
    };
  }
  if (key === "POST /api/sim/seats") {
    const s = seats.get(body.crn);
    if (!s) throw new MockError("Unknown CRN");
    const next = { ...s, available: body.available, max: body.max ?? s.max, checkedAt: Date.now(), changedAt: Date.now() };
    seats.set(body.crn, next);
    push({ type: "seats", seats: [next] });
    return { ok: true };
  }
  if (key === "POST /api/sim/error" || key === "POST /api/sim/schedule") return { ok: true };

  throw new MockError(`Mock has no handler for ${key}`);
}

// ---------- fake stream ----------

export function startMockStream(apply: (m: StreamMessage) => void) {
  emit = apply;
  // Poller heartbeat
  setInterval(() => {
    if (status.globalPaused) return;
    const t = Date.now();
    status = { ...status, poller: { ...status.poller, lastCycleAt: t, nextCycleAt: t + 10_000 } };
    for (const [crn, s] of seats) seats.set(crn, { ...s, checkedAt: t });
    push({ type: "status", status: clone(status) });
  }, 10_000);
  // Occasional seat change on a watched CRN
  const watched = ["31233", "58431", "31235", "65093"];
  let i = 0;
  setInterval(() => {
    if (status.globalPaused) return;
    const crn = watched[i++ % watched.length]!;
    const s = seats.get(crn)!;
    const available = s.available > 0 ? s.available - 1 : 1;
    const next = { ...s, available, enrolled: s.max - available, changedAt: Date.now(), checkedAt: Date.now() };
    seats.set(crn, next);
    push({ type: "seats", seats: [next] });
    addEvent({ kind: "seat_changed", severity: "info", title: `Seats on ${crn} ${s.available} to ${available}`, crns: [crn] });
  }, 7000);
}

// ---------- schedule planner ----------

let planSeq = 0;
let planCourseSeq = 0;
const plans: Plan[] = [];

function newPlan(term: string, name: string): Plan {
  const t = Date.now();
  const plan: Plan = {
    id: ++planSeq,
    term,
    name,
    position: plans.filter(x => x.term === term).length,
    breaks: [],
    ignoreRegistered: false,
    openOnly: false,
    sort: "open",
    target: null,
    courses: [],
    createdAt: t,
    updatedAt: t,
  };
  plans.push(plan);
  return plan;
}

function planCourse(plan: Plan, subject: string, number: string): PlanCourse {
  const c = courses.find(x => x.subject === subject && x.number === number);
  return {
    id: ++planCourseSeq,
    planId: plan.id,
    subject,
    number,
    title: c?.title ?? "",
    included: true,
    excludedCrns: [],
    locked: null,
    backups: true,
    position: plan.courses.length,
  };
}

if (!fresh) {
  const p1 = newPlan(TERM, "Plan 1");
  p1.courses = [planCourse(p1, "CS", "225"), planCourse(p1, "CS", "173"), planCourse(p1, "MATH", "241")];
  p1.breaks = [{ days: ["M", "W", "F"], start: "12:00", end: "13:00" }];
  const p2 = newPlan(TERM, "Light Fridays");
  p2.courses = [planCourse(p2, "CS", "225"), planCourse(p2, "CS", "374")];
}

const pushPlans = (term: string) =>
  push({ type: "plans", term, plans: clone(plans.filter(x => x.term === term).sort((a, b) => a.position - b.position)) });

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function overlaps(a: Section, b: Section) {
  for (const x of a.meetings)
    for (const y of b.meetings) {
      if (!x.start || !x.end || !y.start || !y.end) continue;
      if (![...x.days].some(d => y.days.includes(d))) continue;
      if (minutesOf(x.start) < minutesOf(y.end) && minutesOf(y.start) < minutesOf(x.end)) return true;
    }
  return false;
}

function hitsBreak(s: Section, breaks: PlanBreak[]) {
  return s.meetings.some(m =>
    breaks.some(
      b =>
        m.start &&
        m.end &&
        [...m.days].some(d => b.days.includes(d as Day)) &&
        minutesOf(m.start) < minutesOf(b.end) &&
        minutesOf(b.start) < minutesOf(m.end),
    ),
  );
}

const FIXED = ["40121"]; // the simulated schedule's registered STAT 400

function generate(plan: Plan): PlanGenerateResult {
  const sections: Record<string, PlanSection> = {};
  const sec = (crn: string): PlanSection | undefined => {
    if (sections[crn]) return sections[crn];
    for (const c of courses) {
      const seed = c.sections.find(x => x[0] === crn);
      if (seed) return (sections[crn] = { ...toSection(seed), subject: c.subject, number: c.number });
    }
    return undefined;
  };
  const fixed = plan.ignoreRegistered ? [] : FIXED.map(crn => ({ crn, subject: "STAT", number: "400" }));
  const fixedSecs = fixed.map(f => sec(f.crn)!).filter(Boolean);
  const results: PlanGenerateResult["courses"] = [];
  const optionLists: { pc: PlanCourse; options: string[][] }[] = [];
  for (const pc of plan.courses) {
    const seed = courses.find(c => c.subject === pc.subject && c.number === pc.number);
    if (!pc.included) {
      results.push({ subject: pc.subject, number: pc.number, options: 0, status: "excluded" });
      continue;
    }
    if (!seed) {
      results.push({ subject: pc.subject, number: pc.number, options: 0, status: "not_offered" });
      continue;
    }
    if (wanted.some(w => w.term === plan.term && w.subject === pc.subject && w.number === pc.number && w.state === "registered")) {
      results.push({ subject: pc.subject, number: pc.number, options: 0, status: "registered" });
      continue;
    }
    let options: string[][] = Object.keys(seed.linked).length
      ? Object.entries(seed.linked).flatMap(([lec, opts]) => opts.map(o => [lec, ...o]))
      : seed.sections.map(x => [x[0]]);
    if (pc.locked) options = [pc.locked];
    options = options.filter(o =>
      o.every(crn => {
        const s = sec(crn);
        return s && !pc.excludedCrns.includes(crn) && !hitsBreak(s, plan.breaks) && !fixedSecs.some(f => overlaps(f, s));
      }),
    );
    for (const o of options) for (const crn of o) sec(crn);
    results.push({ subject: pc.subject, number: pc.number, options: options.length, status: options.length ? "ok" : "no_options" });
    if (options.length) optionLists.push({ pc, options });
  }
  const schedules: PlanSchedule[] = [];
  const blocked = results.some(r => r.status === "no_options");
  const walk = (i: number, picked: { pc: PlanCourse; crns: string[] }[]) => {
    if (i === optionLists.length) {
      const crns = picked.flatMap(p => p.crns);
      const secs = crns.map(c => sections[c]!);
      const timed = secs.flatMap(s => s.meetings).filter(m => m.start && m.end);
      const byDay: Record<string, [number, number][]> = {};
      for (const m of timed) for (const d of m.days) (byDay[d] ??= []).push([minutesOf(m.start!), minutesOf(m.end!)]);
      let gap = 0;
      for (const list of Object.values(byDay)) {
        list.sort((a, b) => a[0] - b[0]);
        for (let k = 1; k < list.length; k++) gap += Math.max(0, list[k]![0] - list[k - 1]![1]);
      }
      const starts = timed.map(m => m.start!).sort();
      const ends = timed.map(m => m.end!).sort();
      const avail = secs.map(s => seats.get(s.crn)?.available ?? null).filter((x): x is number => x !== null);
      schedules.push({
        key: [...crns].sort().join(","),
        picks: picked.map(p => ({ subject: p.pc.subject, number: p.pc.number, crns: p.crns })),
        stats: {
          days: Object.keys(byDay).length,
          start: starts[0] ?? null,
          end: ends[ends.length - 1] ?? null,
          gapMin: gap,
          closed: avail.filter(a => a <= 0).length,
          minSeats: avail.length ? Math.min(...avail) : null,
        },
      });
      return;
    }
    const { pc, options } = optionLists[i]!;
    for (const o of options) {
      const s = o.map(c => sections[c]!);
      if (picked.some(p => p.crns.some(c => s.some(x => overlaps(x, sections[c]!))))) continue;
      walk(i + 1, [...picked, { pc, crns: o }]);
    }
  };
  if (!blocked && optionLists.length) walk(0, []);
  let list = plan.openOnly ? schedules.filter(x => x.stats.closed === 0) : schedules;
  const cmp: Record<PlanSort, (a: PlanSchedule, b: PlanSchedule) => number> = {
    open: (a, b) => a.stats.closed - b.stats.closed || (b.stats.minSeats ?? 0) - (a.stats.minSeats ?? 0),
    days: (a, b) => a.stats.days - b.stats.days,
    start: (a, b) => (b.stats.start ?? "").localeCompare(a.stats.start ?? ""),
    end: (a, b) => (a.stats.end ?? "").localeCompare(b.stats.end ?? ""),
    gaps: (a, b) => a.stats.gapMin - b.stats.gapMin,
  };
  list = list.sort((a, b) => cmp[plan.sort](a, b) || a.stats.gapMin - b.stats.gapMin || a.key.localeCompare(b.key));
  for (const f of fixed) sec(f.crn);
  return {
    schedules: list.slice(0, 200),
    total: list.length,
    truncated: false,
    courses: results,
    fixed,
    sections,
    generatedAt: Date.now(),
  };
}

function findPlan(id: number) {
  const plan = plans.find(x => x.id === id);
  if (!plan) throw new MockError("That plan no longer exists.");
  return plan;
}

async function planRequest(method: string, url: URL, body: any): Promise<unknown> {
  const p = url.pathname;
  let m: RegExpExecArray | null;
  if (method === "GET" && p === "/api/plans") {
    const term = url.searchParams.get("term") ?? TERM;
    if (!plans.some(x => x.term === term)) newPlan(term, "Plan 1");
    return clone(plans.filter(x => x.term === term).sort((a, b) => a.position - b.position));
  }
  if (method === "POST" && p === "/api/plans") {
    if (plans.filter(x => x.term === body.term).length >= 10) throw new MockError("A term can have at most 10 plans.");
    const plan = newPlan(body.term, String(body.name).trim() || "Untitled");
    pushPlans(plan.term);
    return clone(plan);
  }
  if ((m = /^\/api\/plans\/(\d+)$/.exec(p))) {
    const plan = findPlan(Number(m[1]));
    if (method === "DELETE") {
      plans.splice(plans.indexOf(plan), 1);
      for (const w of wanted) if (w.planId === plan.id) w.planId = null;
      pushPlans(plan.term);
      pushWanted();
      return { ok: true };
    }
    if (method === "PATCH") {
      if (body.name !== undefined && !String(body.name).trim()) throw new MockError("Give the plan a name.");
      Object.assign(plan, body, { updatedAt: Date.now() });
      pushPlans(plan.term);
      return clone(plan);
    }
  }
  if ((m = /^\/api\/plans\/(\d+)\/courses$/.exec(p)) && method === "POST") {
    const plan = findPlan(Number(m[1]));
    if (plan.courses.length >= 12) throw new MockError("A plan can hold at most 12 courses.");
    if (plan.courses.some(c => c.subject === body.subject && c.number === body.number))
      throw new MockError(`${body.subject} ${body.number} is already in this plan.`);
    if (!courses.some(c => c.subject === body.subject && c.number === body.number))
      throw new MockError(`${body.subject} ${body.number} is not offered this term.`);
    plan.courses.push(planCourse(plan, body.subject, body.number));
    plan.updatedAt = Date.now();
    pushPlans(plan.term);
    return clone(plan);
  }
  if ((m = /^\/api\/plans\/(\d+)\/courses\/(\d+)$/.exec(p))) {
    const plan = findPlan(Number(m[1]));
    const pc = plan.courses.find(c => c.id === Number(m![2]));
    if (!pc) throw new MockError("That course is no longer in the plan.");
    if (method === "DELETE") plan.courses = plan.courses.filter(c => c !== pc);
    else Object.assign(pc, body);
    plan.updatedAt = Date.now();
    pushPlans(plan.term);
    return clone(plan);
  }
  if ((m = /^\/api\/plans\/(\d+)\/generate$/.exec(p)) && method === "POST") {
    await wait(500);
    return generate(findPlan(Number(m[1])));
  }
  if ((m = /^\/api\/plans\/(\d+)\/target$/.exec(p)) && method === "POST") {
    const plan = findPlan(Number(m[1]));
    const picks: PlanPick[] = body.picks;
    if (plan.term !== settings.activeTerm)
      throw new MockError("Targeting only works for the active term.");
    const busy = wanted.find(
      w => picks.some(pk => pk.subject === w.subject && pk.number === w.number) && w.bundles.some(b => b.state === "registering" || b.state === "pending_approval"),
    );
    if (busy) throw new MockError(`${busy.subject} ${busy.number} has a registration in progress. Resolve it first.`);
    const result = generate(plan);
    const changed: WantedCourse[] = [];
    for (const pk of picks) {
      let w = wanted.find(x => x.term === plan.term && x.subject === pk.subject && x.number === pk.number);
      if (!w) {
        const id = Math.max(0, ...wanted.map(x => x.id)) + 1;
        w = {
          id,
          term: plan.term,
          subject: pk.subject,
          number: pk.number,
          title: courses.find(c => c.subject === pk.subject && c.number === pk.number)?.title ?? "",
          priority: wanted.length,
          armed: true,
          kind: "bundles",
          filters: noFilters,
          swapDropCrn: null,
          planId: null,
          state: "watching",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bundles: [],
        };
        wanted.push(w);
      }
      const pc = plan.courses.find(c => c.subject === pk.subject && c.number === pk.number);
      const others = picks.filter(x => x !== pk).flatMap(x => x.crns);
      const backups =
        pc?.backups === false
          ? []
          : result.schedules
              .flatMap(s => s.picks.filter(x => x.subject === pk.subject && x.number === pk.number && x.crns.join() !== pk.crns.join()))
              .filter(x => x.crns.every(c => !others.some(o => overlaps(result.sections[c]!, result.sections[o]!))))
              .map(x => x.crns)
              .filter((x, i, all) => all.findIndex(y => y.join() === x.join()) === i)
              .slice(0, 20);
      const id = w.id;
      w.bundles = [mkBundle(id, 0, pk.crns), ...backups.map((crns, i) => mkBundle(id, i + 1, crns, "watching", { generated: true }))];
      w.kind = "bundles";
      w.armed = true;
      w.planId = plan.id;
      w.updatedAt = Date.now();
      changed.push(clone(w));
    }
    for (const w of wanted)
      if (w.planId === plan.id && !picks.some(pk => pk.subject === w.subject && pk.number === w.number)) w.armed = false;
    plan.target = { at: Date.now(), picks };
    pushPlans(plan.term);
    pushWanted();
    addEvent({ kind: "control", severity: "info", title: `Targeted ${plan.name}`, crns: picks.flatMap(x => x.crns) });
    return { plan: clone(plan), wanted: changed };
  }
  throw new MockError(`Mock has no plan handler for ${method} ${p}`);
}

// ---------- app access (auth) ----------

/** ?auth=signin shows the sign-in screen. ?setup=1 starts before a mode is chosen. */
const auth: AuthStatus = {
  mode: fresh ? null : "password",
  authenticated: params.get("auth") !== "signin",
  passkeyLogin: !fresh,
  passkeysSupported: true,
  recoveryCodesLeft: fresh ? null : 8,
};
let authFailures = 0;
let lockedUntil = 0;

const fakeCodes = () =>
  Array.from({ length: 10 }, () =>
    Array.from({ length: 2 }, () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "X")).join("-"),
  );

let passkeys: PasskeyInfo[] = fresh
  ? []
  : [
      { id: "pk1", name: "Chrome on macOS", createdAt: now - 6 * 86400_000, lastUsedAt: now - 2 * 3600_000, host: "localhost" },
      { id: "pk2", name: "iPhone", createdAt: now - 3 * 86400_000, lastUsedAt: null, host: "localhost" },
    ];
let authSessions: AuthSessionInfo[] = [
  { id: "s1", current: true, device: "Chrome on macOS", ip: "127.0.0.1", createdAt: now - 6 * 86400_000, lastSeenAt: now, remember: true },
  { id: "s2", current: false, device: "Safari on iOS", ip: "10.0.0.24", createdAt: now - 3 * 86400_000, lastSeenAt: now - 5 * 3600_000, remember: true },
  { id: "s3", current: false, device: "Firefox on Windows", ip: "73.44.120.9", createdAt: now - 20 * 86400_000, lastSeenAt: now - 9 * 86400_000, remember: false },
];

const authOut = (): AuthStatus => ({
  ...auth,
  recoveryCodesLeft: auth.mode === "password" && auth.authenticated ? auth.recoveryCodesLeft : null,
});

function checkPassword(password: string) {
  if (Date.now() < lockedUntil) throw new MockError("Too many tries.", 429, null, Math.ceil((lockedUntil - Date.now()) / 1000));
  if (password !== "password") {
    authFailures++;
    if (authFailures >= 3) {
      authFailures = 0;
      lockedUntil = Date.now() + 30_000;
      throw new MockError("Too many tries.", 429, null, 30);
    }
    throw new MockError("Wrong password.", 401);
  }
  authFailures = 0;
}

async function authRequest(method: string, p: string, body: any): Promise<unknown> {
  await wait(300);
  const key = `${method} ${p}`;
  let m: RegExpExecArray | null;
  if (key === "GET /api/auth/status") return authOut();
  if (key === "POST /api/auth/login") {
    checkPassword(String(body.password ?? ""));
    auth.authenticated = true;
    return authOut();
  }
  if (key === "POST /api/auth/passkeys/login/options") return { challenge: "mock" };
  if (key === "POST /api/auth/passkeys/login/verify") {
    auth.authenticated = true;
    return authOut();
  }
  if (key === "POST /api/auth/recover") {
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(String(body.code ?? "").trim())) throw new MockError("That recovery code doesn't work.", 401);
    if (String(body.newPassword ?? "").length < 8) throw new MockError("Use at least 8 characters.");
    auth.authenticated = true;
    auth.recoveryCodesLeft = Math.max(0, (auth.recoveryCodesLeft ?? 1) - 1);
    return authOut();
  }
  if (auth.mode === "password" && !auth.authenticated) throw new MockError("Sign in first.", 401, "required");
  if (key === "POST /api/auth/logout") {
    auth.authenticated = auth.mode !== "password";
    return authOut();
  }
  if (key === "POST /api/auth/configure") {
    if (body.mode === "none") {
      if (auth.mode === "password") checkPassword(String(body.currentPassword ?? ""));
      Object.assign(auth, { mode: "none", authenticated: true, passkeyLogin: false, recoveryCodesLeft: null });
      passkeys = [];
      authSessions = authSessions.filter(x => x.current);
      return { status: authOut(), recoveryCodes: null };
    }
    if (String(body.password ?? "").length < 8) throw new MockError("Use at least 8 characters.");
    const codes = fakeCodes();
    Object.assign(auth, { mode: "password", authenticated: true, recoveryCodesLeft: codes.length });
    return { status: authOut(), recoveryCodes: codes };
  }
  if (key === "POST /api/auth/password") {
    checkPassword(String(body.currentPassword ?? ""));
    authSessions = authSessions.filter(x => x.current);
    return authOut();
  }
  if (key === "POST /api/auth/recovery-codes") {
    checkPassword(String(body.currentPassword ?? ""));
    const codes = fakeCodes();
    auth.recoveryCodesLeft = codes.length;
    return { recoveryCodes: codes };
  }
  if (key === "GET /api/auth/sessions") return clone(authSessions);
  if ((m = /^DELETE \/api\/auth\/sessions\/(.+)$/.exec(key))) {
    authSessions = authSessions.filter(x => x.id !== decodeURIComponent(m![1]!));
    return { ok: true };
  }
  if (key === "POST /api/auth/sessions/revoke-others") {
    authSessions = authSessions.filter(x => x.current);
    return { ok: true };
  }
  if (key === "GET /api/auth/passkeys") return clone(passkeys);
  if (key === "POST /api/auth/passkeys/register/options") return { challenge: "mock" };
  if (key === "POST /api/auth/passkeys/register/verify") {
    const pk: PasskeyInfo = { id: `pk${Date.now()}`, name: body.name || "Passkey", createdAt: Date.now(), lastUsedAt: null, host: location.hostname };
    passkeys.push(pk);
    auth.passkeyLogin = true;
    return pk;
  }
  if ((m = /^(PATCH|DELETE) \/api\/auth\/passkeys\/(.+)$/.exec(key))) {
    const id = decodeURIComponent(m[2]!);
    const pk = passkeys.find(x => x.id === id);
    if (!pk) throw new MockError("That passkey is gone.", 404);
    if (m[1] === "DELETE") {
      passkeys = passkeys.filter(x => x !== pk);
      auth.passkeyLogin = passkeys.length > 0;
      return { ok: true };
    }
    pk.name = String(body.name ?? pk.name).trim() || pk.name;
    return clone(pk);
  }
  throw new MockError(`Mock has no auth handler for ${key}`, 404);
}
