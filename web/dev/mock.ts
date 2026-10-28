// Fake backend used only when the URL has ?mock=1. Never imported otherwise.
import type { RehearsalReport } from "../../src/core/contracts";
import {
  NOTIFY_EVENTS,
  type AppEvent,
  type Approval,
  type Bundle,
  type CourseDetail,
  type Meeting,
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

let settings: PublicSettings = {
  approvalMode: "approve",
  approvalAutoAfterMin: 10,
  pollIntervalSec: 10,
  jitterPct: 20,
  overnightSlow: true,
  activeTerm: TERM,
  ticketAt: new Date(now + 2 * 86400_000 + 3 * 3600_000).toISOString(),
  liveEnabled: false,
  liveTerm: null,
  swapsUnlocked: false,
  globalPaused: false,
  sessionPausedUntil: null,
  discordUserId: "184392011734581248",
  discordTokenHint: "4f2a",
  routing: Object.fromEntries(
    NOTIFY_EVENTS.map(e => [e, { discord: ["approval_needed", "registered", "registration_failed"].includes(e), push: e === "approval_needed" }]),
  ) as PublicSettings["routing"],
  vapidPublicKey: null,
};

const mode = (new URLSearchParams(location.search).get("mode") as SystemStatus["mode"]) ?? "simulated";
const scenario = new URLSearchParams(location.search).get("scenario");

let status: SystemStatus = {
  mode,
  backend: "webkit",
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
    pausedUntil: null,
    lastError: null,
    stage: null,
  },
  ticket: { at: settings.ticketAt, phase: "waiting" },
  catalog: { term: TERM, syncedAt: now - 5 * 3600_000, courses: 4211, syncing: false },
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

if (scenario === "empty") {
  wanted = [];
  approvals = [];
  events = events.slice(-3);
}
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

class MockError extends Error {}

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

  if (key === "GET /api/state") return snapshot();
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
    status = { ...status, session: { ...status.session, state: "logging_in", stage: "Duo TOTP", lastError: null } };
    push({ type: "status", status: clone(status) });
    setTimeout(() => {
      status = { ...status, session: { ...status.session, state: "warm", since: Date.now(), stage: null } };
      push({ type: "status", status: clone(status) });
    }, 2000);
    return { ok: true };
  }
  if (key === "POST /api/session/logout") {
    status = { ...status, session: { ...status.session, state: "cold", since: Date.now() } };
    push({ type: "status", status: clone(status) });
    return { ok: true };
  }
  if (key === "POST /api/session/pause") {
    const until = body.minutes ? Date.now() + body.minutes * min : null;
    status = { ...status, session: { ...status.session, state: until ? "paused" : "cold", pausedUntil: until } };
    push({ type: "status", status: clone(status) });
    return { ok: true };
  }
  if (key === "POST /api/rehearsal") {
    await wait(1200);
    const r: RehearsalReport = {
      ok: true,
      startedAt: Date.now() - 9400,
      finishedAt: Date.now(),
      term: body.term,
      steps: [
        { name: "Open Banner", ok: true, detail: null, ms: 820 },
        { name: "Shibboleth login", ok: true, detail: null, ms: 2140 },
        { name: "Duo TOTP", ok: true, detail: "Code accepted", ms: 1610 },
        { name: "Select term", ok: true, detail: "Spring 2027", ms: 540 },
        { name: "Read eligibility", ok: true, detail: "Allowed to register", ms: 380 },
        { name: "Read schedule", ok: true, detail: "3 CRNs", ms: 910 },
        { name: "Check wanted CRNs", ok: true, detail: "9 of 9 exist", ms: 2400 },
        { name: "Write interceptor", ok: true, detail: "0 writes blocked", ms: 4 },
      ],
      eligibility: { allowed: true, messages: [] },
      schedule: ["40121", "31110", "58001"],
      crnChecks: [],
      blockedWrites: 0,
    };
    return r;
  }
  if (key === "POST /api/live") {
    if (status.mode !== "live") throw new MockError("Live mode needs REGISTRATION_MODE=live in the environment.");
    if (body.enabled && body.confirmText !== "Spring 2027") throw new MockError("Type the term exactly as shown.");
    settings = { ...settings, liveEnabled: body.enabled, liveTerm: body.enabled ? TERM : null };
    status = { ...status, liveEnabled: body.enabled, liveTerm: settings.liveTerm };
    push({ type: "settings", settings: clone(settings) });
    push({ type: "status", status: clone(status) });
    return clone(settings);
  }
  if (key === "PUT /api/settings") {
    if (body.pollIntervalSec !== undefined && body.pollIntervalSec < 10) throw new MockError("Polling interval must be at least 10 seconds.");
    const { discordToken, ...rest } = body;
    settings = { ...settings, ...rest };
    if (discordToken !== undefined) settings.discordTokenHint = discordToken ? String(discordToken).slice(-4) : null;
    push({ type: "settings", settings: clone(settings) });
    if (body.ticketAt !== undefined) {
      status = { ...status, ticket: { ...status.ticket, at: body.ticketAt, phase: body.ticketAt ? "waiting" : "none" } };
      push({ type: "status", status: clone(status) });
    }
    return clone(settings);
  }
  if ((m = /^POST \/api\/notify\/test\/(\w+)$/.exec(key))) {
    if (m[1] === "discord" && !settings.discordTokenHint) return { ok: false, detail: "No bot token set." };
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
