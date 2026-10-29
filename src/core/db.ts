import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  NOTIFY_EVENTS,
  type AnyFilters,
  type AppEvent,
  type Approval,
  type ApprovalState,
  type Bundle,
  type BundleState,
  type CourseState,
  type NewEvent,
  type NotifyEvent,
  type Plan,
  type PlanBreak,
  type PlanCourse,
  type PlanSort,
  type PlanTarget,
  type PublicSettings,
  type Route,
  type SeatInfo,
  type Settings,
  type WantedCourse,
} from "./types";

const EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE wanted_courses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     term TEXT NOT NULL, subject TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
     priority INTEGER NOT NULL DEFAULT 0, armed INTEGER NOT NULL DEFAULT 0,
     kind TEXT NOT NULL DEFAULT 'bundles', filters TEXT NOT NULL DEFAULT '{}',
     swap_drop_crn TEXT, state TEXT NOT NULL DEFAULT 'watching',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE bundles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     course_id INTEGER NOT NULL REFERENCES wanted_courses(id) ON DELETE CASCADE,
     rank INTEGER NOT NULL, crns TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'watching',
     blocked_reason TEXT, generated INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX bundles_course ON bundles(course_id, rank);
   CREATE TABLE seats (
     term TEXT NOT NULL, crn TEXT NOT NULL, available INTEGER NOT NULL, max INTEGER NOT NULL,
     enrolled INTEGER NOT NULL, checked_at INTEGER NOT NULL, changed_at INTEGER NOT NULL,
     PRIMARY KEY (term, crn));
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
     severity TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, course_id INTEGER, bundle_id INTEGER,
     crns TEXT NOT NULL DEFAULT '[]', payload TEXT);
   CREATE INDEX events_ts ON events(ts);
   CREATE TABLE attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, bundle_id INTEGER, mode TEXT NOT NULL,
     request TEXT NOT NULL, response TEXT, outcome TEXT NOT NULL, class TEXT, ms INTEGER);
   CREATE TABLE approvals (
     id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_id INTEGER NOT NULL, course_id INTEGER NOT NULL,
     crns TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
     remind_at INTEGER, auto_at INTEGER, resolved_at INTEGER, discord_message_id TEXT);
   CREATE TABLE schedule_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, term TEXT NOT NULL, crns TEXT NOT NULL,
     source TEXT NOT NULL);
   CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE cat_courses (
     term TEXT NOT NULL, subject TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL,
     credit_hours TEXT, description TEXT, schedule_info TEXT, section_count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (term, subject, number));
   CREATE TABLE cat_sections (
     term TEXT NOT NULL, crn TEXT NOT NULL, subject TEXT NOT NULL, number TEXT NOT NULL,
     section TEXT NOT NULL, type TEXT NOT NULL, type_name TEXT NOT NULL, part_of_term TEXT,
     meetings TEXT NOT NULL DEFAULT '[]', instructors TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (term, crn));
   CREATE INDEX cat_sections_course ON cat_sections(term, subject, number);
   CREATE VIRTUAL TABLE cat_fts USING fts5(term UNINDEXED, subject, number, code, title, instructors, crns,
     tokenize = 'unicode61 remove_diacritics 2', prefix = '1 2 3');
   CREATE TABLE cat_meta (term TEXT PRIMARY KEY, synced_at INTEGER NOT NULL, courses INTEGER NOT NULL);
   CREATE TABLE linked_options (term TEXT NOT NULL, crn TEXT NOT NULL, options TEXT NOT NULL,
     fetched_at INTEGER NOT NULL, PRIMARY KEY (term, crn));`,
  `CREATE TABLE plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, name TEXT NOT NULL,
     position INTEGER NOT NULL DEFAULT 0, breaks TEXT NOT NULL DEFAULT '[]',
     ignore_registered INTEGER NOT NULL DEFAULT 0, open_only INTEGER NOT NULL DEFAULT 0,
     sort TEXT NOT NULL DEFAULT 'open', target TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX plans_term ON plans(term, position);
   CREATE TABLE plan_courses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
     subject TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
     included INTEGER NOT NULL DEFAULT 1, excluded_crns TEXT NOT NULL DEFAULT '[]',
     locked TEXT, backups INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
     UNIQUE (plan_id, subject, number));
   ALTER TABLE wanted_courses ADD COLUMN plan_id INTEGER;`,
];

export const PLAN_LIMITS = { plansPerTerm: 10, coursesPerPlan: 12, breaks: 20, excludedCrns: 60 } as const;

const PLAN_SORTS: readonly PlanSort[] = ["open", "days", "start", "end", "gaps"];

export function defaultRouting(): Record<NotifyEvent, Route> {
  return Object.fromEntries(NOTIFY_EVENTS.map(event => [event, { discord: false, push: false }])) as Record<
    NotifyEvent,
    Route
  >;
}

export function defaultSettings(): Settings {
  return {
    approvalMode: "auto",
    approvalAutoAfterMin: null,
    pollIntervalSec: 10,
    jitterPct: 20,
    overnightSlow: true,
    activeTerm: null,
    ticketAt: null,
    ticketAuto: true,
    ticketSource: null,
    ticketCheckedAt: null,
    ticketCheckedTerm: null,
    liveEnabled: false,
    liveTerm: null,
    swapsUnlocked: false,
    globalPaused: false,
    sessionPausedUntil: null,
    discordToken: null,
    discordUserId: null,
    routing: defaultRouting(),
    vapidPublicKey: null,
    vapidPrivateKey: null,
  };
}

const emptyFilters = (): AnyFilters => ({ excludeDays: [], excludeTimes: [], excludeInstructors: [] });

type Row = Record<string, any>;

function bundleFromRow(row: Row): Bundle {
  return {
    id: row.id,
    courseId: row.course_id,
    rank: row.rank,
    crns: JSON.parse(row.crns),
    state: row.state,
    blockedReason: row.blocked_reason,
    generated: Boolean(row.generated),
  };
}

function eventFromRow(row: Row): AppEvent {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    courseId: row.course_id,
    bundleId: row.bundle_id,
    crns: JSON.parse(row.crns),
    payload: row.payload ? JSON.parse(row.payload) : null,
  };
}

function approvalFromRow(row: Row): Approval {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    courseId: row.course_id,
    crns: JSON.parse(row.crns),
    label: row.label,
    state: row.state,
    createdAt: row.created_at,
    remindAt: row.remind_at,
    autoAt: row.auto_at,
    resolvedAt: row.resolved_at,
  };
}

function seatFromRow(row: Row): SeatInfo {
  return {
    term: row.term,
    crn: row.crn,
    available: row.available,
    max: row.max,
    enrolled: row.enrolled,
    checkedAt: row.checked_at,
    changedAt: row.changed_at,
  };
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true });
    return new Store(join(dataDir, "app.sqlite"));
  }

  private migrate() {
    const version = (this.db.query("PRAGMA user_version").get() as Row).user_version as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- settings ----------
  getSettings(): Settings {
    const settings = defaultSettings();
    for (const row of this.db.query("SELECT key, value FROM settings").all() as Row[]) {
      if (row.key in settings) (settings as any)[row.key] = JSON.parse(row.value);
    }
    // Keep routing complete when new events are added later.
    settings.routing = { ...defaultRouting(), ...settings.routing };
    return settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        stmt.run(key, JSON.stringify(value));
      }
    });
    return this.getSettings();
  }

  publicSettings(settings = this.getSettings()): PublicSettings {
    const { discordToken, vapidPrivateKey, ...rest } = settings;
    return { ...rest, discordTokenHint: discordToken ? discordToken.slice(-4) : null };
  }

  // ---------- wanted courses & bundles ----------
  listWanted(term?: string): WantedCourse[] {
    const rows = (term
      ? this.db.query("SELECT * FROM wanted_courses WHERE term = ? ORDER BY priority, id").all(term)
      : this.db.query("SELECT * FROM wanted_courses ORDER BY priority, id").all()) as Row[];
    const bundles = this.db.query("SELECT * FROM bundles WHERE course_id = ? ORDER BY rank, id");
    return rows.map(row => ({
      id: row.id,
      term: row.term,
      subject: row.subject,
      number: row.number,
      title: row.title,
      priority: row.priority,
      armed: Boolean(row.armed),
      kind: row.kind,
      filters: { ...emptyFilters(), ...JSON.parse(row.filters) },
      swapDropCrn: row.swap_drop_crn,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      bundles: (bundles.all(row.id) as Row[]).map(bundleFromRow),
      planId: row.plan_id ?? null,
    }));
  }

  /** Link (or unlink with null) a wanted course to the plan that targeted it. */
  setWantedPlan(id: number, planId: number | null): void {
    this.db.query("UPDATE wanted_courses SET plan_id = ?, updated_at = ? WHERE id = ?").run(planId, Date.now(), id);
  }

  getWanted(id: number): WantedCourse | null {
    return this.listWanted().find(course => course.id === id) ?? null;
  }

  createWanted(input: {
    term: string;
    subject: string;
    number: string;
    title: string;
    kind: "bundles" | "any";
    filters?: AnyFilters;
    swapDropCrn?: string | null;
  }): WantedCourse {
    const now = Date.now();
    const max = this.db.query("SELECT COALESCE(MAX(priority), -1) AS p FROM wanted_courses WHERE term = ?").get(input.term) as Row;
    const result = this.db
      .query(
        `INSERT INTO wanted_courses (term, subject, number, title, priority, armed, kind, filters, swap_drop_crn, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'watching', ?, ?)`,
      )
      .run(
        input.term,
        input.subject.toUpperCase(),
        input.number,
        input.title,
        (max.p as number) + 1,
        input.kind,
        JSON.stringify(input.filters ?? emptyFilters()),
        input.swapDropCrn ?? null,
        now,
        now,
      );
    return this.getWanted(Number(result.lastInsertRowid))!;
  }

  updateWanted(
    id: number,
    patch: Partial<Pick<WantedCourse, "armed" | "kind" | "filters" | "swapDropCrn" | "state" | "title">>,
  ): WantedCourse | null {
    const map: Record<string, [string, (v: any) => unknown]> = {
      armed: ["armed", v => (v ? 1 : 0)],
      kind: ["kind", v => v],
      filters: ["filters", v => JSON.stringify(v)],
      swapDropCrn: ["swap_drop_crn", v => v],
      state: ["state", v => v],
      title: ["title", v => v],
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry || value === undefined) continue;
      sets.push(`${entry[0]} = ?`);
      values.push(entry[1](value));
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      values.push(Date.now(), id);
      this.db.query(`UPDATE wanted_courses SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getWanted(id);
  }

  deleteWanted(id: number): void {
    this.db.query("DELETE FROM wanted_courses WHERE id = ?").run(id);
  }

  reorderWanted(ids: number[]): void {
    const stmt = this.db.query("UPDATE wanted_courses SET priority = ?, updated_at = ? WHERE id = ?");
    this.tx(() => ids.forEach((id, index) => stmt.run(index, Date.now(), id)));
  }

  setBundles(courseId: number, bundles: { crns: string[]; generated?: boolean }[]): Bundle[] {
    this.tx(() => {
      this.db.query("DELETE FROM bundles WHERE course_id = ?").run(courseId);
      const stmt = this.db.query("INSERT INTO bundles (course_id, rank, crns, state, generated) VALUES (?, ?, ?, 'watching', ?)");
      bundles.forEach((bundle, rank) => stmt.run(courseId, rank, JSON.stringify(bundle.crns), bundle.generated ? 1 : 0));
    });
    return this.getWanted(courseId)?.bundles ?? [];
  }

  addBundle(courseId: number, crns: string[]): Bundle {
    const max = this.db.query("SELECT COALESCE(MAX(rank), -1) AS r FROM bundles WHERE course_id = ?").get(courseId) as Row;
    const result = this.db
      .query("INSERT INTO bundles (course_id, rank, crns, state, generated) VALUES (?, ?, ?, 'watching', 0)")
      .run(courseId, (max.r as number) + 1, JSON.stringify(crns));
    return this.getBundle(Number(result.lastInsertRowid))!;
  }

  getBundle(id: number): Bundle | null {
    const row = this.db.query("SELECT * FROM bundles WHERE id = ?").get(id) as Row | null;
    return row ? bundleFromRow(row) : null;
  }

  deleteBundle(id: number): void {
    this.db.query("DELETE FROM bundles WHERE id = ?").run(id);
  }

  reorderBundles(courseId: number, ids: number[]): void {
    const stmt = this.db.query("UPDATE bundles SET rank = ? WHERE id = ? AND course_id = ?");
    this.tx(() => ids.forEach((id, index) => stmt.run(index, id, courseId)));
  }

  setBundleState(id: number, state: BundleState, blockedReason: string | null = null): void {
    this.db.query("UPDATE bundles SET state = ?, blocked_reason = ? WHERE id = ?").run(state, blockedReason, id);
  }

  setCourseState(id: number, state: CourseState): void {
    this.db.query("UPDATE wanted_courses SET state = ?, updated_at = ? WHERE id = ?").run(state, Date.now(), id);
  }

  /** All CRNs in non-terminal bundles of armed, still-watching courses for a term. */
  armedCrns(term: string): string[] {
    const set = new Set<string>();
    for (const course of this.listWanted(term)) {
      if (!course.armed || course.state !== "watching") continue;
      for (const bundle of course.bundles) {
        if (bundle.state === "blocked" || bundle.state === "registered") continue;
        bundle.crns.forEach(crn => set.add(crn));
      }
    }
    return [...set];
  }

  // ---------- seats ----------
  /** Upsert a seat reading. Returns the previous reading (null if new). */
  upsertSeat(seat: Omit<SeatInfo, "changedAt">): { previous: SeatInfo | null; current: SeatInfo } {
    const previousRow = this.db.query("SELECT * FROM seats WHERE term = ? AND crn = ?").get(seat.term, seat.crn) as Row | null;
    const previous = previousRow ? seatFromRow(previousRow) : null;
    const changedAt = previous && previous.available === seat.available ? previous.changedAt : seat.checkedAt;
    this.db
      .query(
        `INSERT INTO seats (term, crn, available, max, enrolled, checked_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(term, crn) DO UPDATE SET available = excluded.available, max = excluded.max,
         enrolled = excluded.enrolled, checked_at = excluded.checked_at, changed_at = excluded.changed_at`,
      )
      .run(seat.term, seat.crn, seat.available, seat.max, seat.enrolled, seat.checkedAt, changedAt);
    return { previous, current: { ...seat, changedAt } };
  }

  getSeat(term: string, crn: string): SeatInfo | null {
    const row = this.db.query("SELECT * FROM seats WHERE term = ? AND crn = ?").get(term, crn) as Row | null;
    return row ? seatFromRow(row) : null;
  }

  listSeats(term: string): SeatInfo[] {
    return (this.db.query("SELECT * FROM seats WHERE term = ?").all(term) as Row[]).map(seatFromRow);
  }

  // ---------- events ----------
  addEvent(event: NewEvent): AppEvent {
    const ts = event.ts ?? Date.now();
    const result = this.db
      .query(
        `INSERT INTO events (ts, kind, severity, title, detail, course_id, bundle_id, crns, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        event.kind,
        event.severity,
        event.title,
        event.detail ?? null,
        event.courseId ?? null,
        event.bundleId ?? null,
        JSON.stringify(event.crns ?? []),
        event.payload === undefined ? null : JSON.stringify(event.payload),
      );
    return eventFromRow(this.db.query("SELECT * FROM events WHERE id = ?").get(Number(result.lastInsertRowid)) as Row);
  }

  listEvents(limit = 200, before?: number): AppEvent[] {
    const rows = (before
      ? this.db.query("SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit)
      : this.db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)) as Row[];
    return rows.map(eventFromRow);
  }

  pruneEvents(now = Date.now()): number {
    return this.db.query("DELETE FROM events WHERE ts < ?").run(now - EVENT_RETENTION_MS).changes;
  }

  // ---------- attempts ----------
  addAttempt(attempt: {
    bundleId: number | null;
    mode: string;
    request: unknown;
    response: unknown;
    outcome: string;
    classification: string | null;
    ms: number;
  }): void {
    this.db
      .query("INSERT INTO attempts (ts, bundle_id, mode, request, response, outcome, class, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        Date.now(),
        attempt.bundleId,
        attempt.mode,
        JSON.stringify(attempt.request),
        JSON.stringify(attempt.response ?? null),
        attempt.outcome,
        attempt.classification,
        attempt.ms,
      );
  }

  // ---------- approvals ----------
  createApproval(input: Omit<Approval, "id" | "state" | "resolvedAt">): Approval {
    const result = this.db
      .query(
        `INSERT INTO approvals (bundle_id, course_id, crns, label, state, created_at, remind_at, auto_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(input.bundleId, input.courseId, JSON.stringify(input.crns), input.label, input.createdAt, input.remindAt, input.autoAt);
    return this.getApproval(Number(result.lastInsertRowid))!;
  }

  getApproval(id: number): Approval | null {
    const row = this.db.query("SELECT * FROM approvals WHERE id = ?").get(id) as Row | null;
    return row ? approvalFromRow(row) : null;
  }

  pendingApprovals(): Approval[] {
    return (this.db.query("SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at").all() as Row[]).map(approvalFromRow);
  }

  pendingApprovalForBundle(bundleId: number): Approval | null {
    const row = this.db.query("SELECT * FROM approvals WHERE bundle_id = ? AND state = 'pending'").get(bundleId) as Row | null;
    return row ? approvalFromRow(row) : null;
  }

  resolveApproval(id: number, state: ApprovalState): boolean {
    return this.db
      .query("UPDATE approvals SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, Date.now(), id).changes > 0;
  }

  clearApprovalReminder(id: number): void {
    this.db.query("UPDATE approvals SET remind_at = NULL WHERE id = ?").run(id);
  }

  setApprovalDiscordMessage(id: number, messageId: string): void {
    this.db.query("UPDATE approvals SET discord_message_id = ? WHERE id = ?").run(messageId, id);
  }

  approvalDiscordMessage(id: number): string | null {
    const row = this.db.query("SELECT discord_message_id FROM approvals WHERE id = ?").get(id) as Row | null;
    return row?.discord_message_id ?? null;
  }

  // ---------- schedule plans ----------
  private planFromRow(row: Row): Plan {
    const courses = (this.db.query("SELECT * FROM plan_courses WHERE plan_id = ? ORDER BY position, id").all(row.id) as Row[]).map(
      (course): PlanCourse => ({
        id: course.id,
        planId: course.plan_id,
        subject: course.subject,
        number: course.number,
        title: course.title,
        included: Boolean(course.included),
        excludedCrns: JSON.parse(course.excluded_crns),
        locked: course.locked ? JSON.parse(course.locked) : null,
        backups: Boolean(course.backups),
        position: course.position,
      }),
    );
    return {
      id: row.id,
      term: row.term,
      name: row.name,
      position: row.position,
      breaks: JSON.parse(row.breaks) as PlanBreak[],
      ignoreRegistered: Boolean(row.ignore_registered),
      openOnly: Boolean(row.open_only),
      sort: (PLAN_SORTS as readonly string[]).includes(row.sort) ? row.sort : "open",
      target: row.target ? (JSON.parse(row.target) as PlanTarget) : null,
      courses,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Plans for a term in display order. Creates "Plan 1" when the term has none. */
  listPlans(term: string): Plan[] {
    const query = () => this.db.query("SELECT * FROM plans WHERE term = ? ORDER BY position, id").all(term) as Row[];
    let rows = query();
    if (rows.length === 0) {
      this.createPlan(term, "Plan 1");
      rows = query();
    }
    return rows.map(row => this.planFromRow(row));
  }

  getPlan(id: number): Plan | null {
    const row = this.db.query("SELECT * FROM plans WHERE id = ?").get(id) as Row | null;
    return row ? this.planFromRow(row) : null;
  }

  countPlans(term: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM plans WHERE term = ?").get(term) as Row).n as number;
  }

  createPlan(term: string, name: string): Plan {
    const now = Date.now();
    const max = this.db.query("SELECT COALESCE(MAX(position), -1) AS p FROM plans WHERE term = ?").get(term) as Row;
    const result = this.db
      .query("INSERT INTO plans (term, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(term, name, (max.p as number) + 1, now, now);
    return this.getPlan(Number(result.lastInsertRowid))!;
  }

  updatePlan(
    id: number,
    patch: Partial<Pick<Plan, "name" | "breaks" | "ignoreRegistered" | "openOnly" | "sort" | "target">>,
  ): Plan | null {
    const map: Record<string, [string, (v: any) => unknown]> = {
      name: ["name", v => v],
      breaks: ["breaks", v => JSON.stringify(v)],
      ignoreRegistered: ["ignore_registered", v => (v ? 1 : 0)],
      openOnly: ["open_only", v => (v ? 1 : 0)],
      sort: ["sort", v => v],
      target: ["target", v => (v === null ? null : JSON.stringify(v))],
    };
    this.setColumns("plans", id, patch, map);
    return this.getPlan(id);
  }

  /** Delete a plan. Wanted courses it targeted keep their bundles but lose the link. */
  deletePlan(id: number): void {
    this.tx(() => {
      this.db.query("UPDATE wanted_courses SET plan_id = NULL WHERE plan_id = ?").run(id);
      this.db.query("DELETE FROM plans WHERE id = ?").run(id);
    });
  }

  addPlanCourse(planId: number, input: { subject: string; number: string; title: string }): PlanCourse {
    const max = this.db.query("SELECT COALESCE(MAX(position), -1) AS p FROM plan_courses WHERE plan_id = ?").get(planId) as Row;
    const result = this.db
      .query("INSERT INTO plan_courses (plan_id, subject, number, title, position) VALUES (?, ?, ?, ?, ?)")
      .run(planId, input.subject.toUpperCase(), input.number, input.title, (max.p as number) + 1);
    this.touchPlan(planId);
    return this.getPlan(planId)!.courses.find(course => course.id === Number(result.lastInsertRowid))!;
  }

  updatePlanCourse(
    planId: number,
    courseId: number,
    patch: Partial<Pick<PlanCourse, "included" | "excludedCrns" | "locked" | "backups" | "title">>,
  ): PlanCourse | null {
    const map: Record<string, [string, (v: any) => unknown]> = {
      included: ["included", v => (v ? 1 : 0)],
      excludedCrns: ["excluded_crns", v => JSON.stringify(v)],
      locked: ["locked", v => (v === null ? null : JSON.stringify(v))],
      backups: ["backups", v => (v ? 1 : 0)],
      title: ["title", v => v],
    };
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry || value === undefined) continue;
      sets.push(`${entry[0]} = ?`);
      values.push(entry[1](value));
    }
    if (sets.length) {
      this.db.query(`UPDATE plan_courses SET ${sets.join(", ")} WHERE id = ? AND plan_id = ?`).run(...values, courseId, planId);
      this.touchPlan(planId);
    }
    return this.getPlan(planId)?.courses.find(course => course.id === courseId) ?? null;
  }

  deletePlanCourse(planId: number, courseId: number): boolean {
    const changed = this.db.query("DELETE FROM plan_courses WHERE id = ? AND plan_id = ?").run(courseId, planId).changes > 0;
    if (changed) this.touchPlan(planId);
    return changed;
  }

  private touchPlan(id: number): void {
    this.db.query("UPDATE plans SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  private setColumns(table: "plans", id: number, patch: Record<string, unknown>, map: Record<string, [string, (v: any) => unknown]>): void {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry || value === undefined) continue;
      sets.push(`${entry[0]} = ?`);
      values.push(entry[1](value));
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  // ---------- schedule snapshots ----------
  addScheduleSnapshot(term: string, crns: string[], source: string): void {
    this.db
      .query("INSERT INTO schedule_snapshots (ts, term, crns, source) VALUES (?, ?, ?, ?)")
      .run(Date.now(), term, JSON.stringify([...crns].sort()), source);
  }

  latestSchedule(term: string): { ts: number; crns: string[] } | null {
    const row = this.db.query("SELECT * FROM schedule_snapshots WHERE term = ? ORDER BY id DESC LIMIT 1").get(term) as Row | null;
    return row ? { ts: row.ts, crns: JSON.parse(row.crns) } : null;
  }

  // ---------- push subscriptions ----------
  addPushSubscription(subscription: { endpoint: string }): void {
    this.db
      .query("INSERT INTO push_subscriptions (endpoint, data, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data")
      .run(subscription.endpoint, JSON.stringify(subscription), Date.now());
  }

  removePushSubscription(endpoint: string): void {
    this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  listPushSubscriptions(): any[] {
    return (this.db.query("SELECT data FROM push_subscriptions").all() as Row[]).map(row => JSON.parse(row.data));
  }

  close(): void {
    this.db.close();
  }
}
