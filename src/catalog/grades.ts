// Instructor grade disparity from "Grade disparity between sections at UIUC" (Wade Fagen-Ulmschneider).
// Public JSON, read only. Refreshed weekly into grade_stats.

import type { FetchLike } from "../banner/enrollment";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import { instructorKey } from "../core/grades";
import type { CourseGrades, GradeBands, InstructorGrades } from "../core/types";

export const GRADES_URL = "https://waf.cs.illinois.edu/discovery/grade_disparity_between_sections_at_uiuc/data/out_full.json";
export const GRADES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GradeCourse {
  subject: string;
  number: string;
  overall: InstructorGrades;
  instructors: InstructorGrades[];
  spread: number | null;
}

type Raw = Record<string, unknown>;

const COURSE = /^([A-Z]{2,5}) (\d{3}[A-Z]?)$/;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function parseInstructor(raw: Raw): InstructorGrades | null {
  const name = typeof raw.instructor === "string" ? raw.instructor.trim() : "";
  const avg = num(raw.avgGPA);
  const students = num(raw.countGPA);
  if (!name || avg === null || students === null || students <= 0 || avg < 0 || avg > 4) return null;
  const band = (key: string, fallback: number) => num(raw[key]) ?? fallback;
  const bands: GradeBands = {
    min: band("gpa_bottom", avg),
    p12: band("gpa_7_8", avg),
    p17: band("gpa_5_6", avg),
    p25: band("bottomQuartGPA", avg),
    median: band("medianGPA", avg),
    p75: band("topQuartGPA", avg),
    p83: band("gpa_1_6", avg),
    p88: band("gpa_1_8", avg),
    max: band("gpa_top", avg),
  };
  const rawDist = Array.isArray(raw.gpaDist) ? raw.gpaDist.map(num) : [];
  const dist = (rawDist.length === 5 && rawDist.every(n => n !== null) ? rawDist : [0, 0, 0, 0, 0]) as InstructorGrades["dist"];
  const sigma = num(raw.stddevDiff);
  return {
    name,
    key: instructorKey(name),
    avg,
    students,
    sections: num(raw.sections) ?? 0,
    sigma: sigma === null || Math.abs(sigma) >= 1000 ? null : sigma,
    dist,
    bands,
  };
}

/** Parse out_full.json. Malformed courses and instructors are skipped. Throws when nothing usable is left. */
export function parseGradeData(json: unknown): GradeCourse[] {
  if (!Array.isArray(json)) throw new Error("Grade data is not a list");
  const out: GradeCourse[] = [];
  for (const entry of json as Raw[]) {
    const match = COURSE.exec(typeof entry?.course === "string" ? entry.course.trim() : "");
    if (!match || !Array.isArray(entry.instructors)) continue;
    let overall: InstructorGrades | null = null;
    const byKey = new Map<string, InstructorGrades>();
    for (const raw of entry.instructors as Raw[]) {
      const row = raw && typeof raw === "object" ? parseInstructor(raw) : null;
      if (!row) continue;
      if (row.name === "All Sections") {
        overall = { ...row, key: "", sigma: null };
        continue;
      }
      if (!row.key) continue;
      // Two instructors can share a last name and initial. Keep the larger sample.
      const existing = byKey.get(row.key);
      if (!existing || existing.students < row.students) byKey.set(row.key, row);
    }
    if (!overall) continue;
    out.push({
      subject: match[1]!,
      number: match[2]!,
      overall,
      instructors: [...byKey.values()].sort((a, b) => b.avg - a.avg),
      spread: num(entry.stdDevSpread),
    });
  }
  if (!out.length) throw new Error("Grade data has no usable courses");
  return out;
}

/** Replace all grade data in one transaction. */
export function replaceGrades(store: Store, courses: GradeCourse[], fetchedAt: number): void {
  store.tx(() => {
    store.db.exec("DELETE FROM grade_stats");
    const insert = store.db.query(
      `INSERT OR REPLACE INTO grade_stats (subject, number, instructor_key, name, avg, students, sections, sigma, dist, bands, spread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const course of courses) {
      for (const row of [course.overall, ...course.instructors]) {
        insert.run(
          course.subject,
          course.number,
          row.key,
          row.name,
          row.avg,
          row.students,
          row.sections,
          row.sigma,
          JSON.stringify(row.dist),
          JSON.stringify(row.bands),
          course.spread,
        );
      }
    }
    store.db
      .query("INSERT INTO grade_meta (id, fetched_at, courses) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, courses = excluded.courses")
      .run(fetchedAt, courses.length);
  });
}

export function gradeMeta(store: Store): { fetchedAt: number; courses: number } | null {
  const row = store.db.query("SELECT fetched_at, courses FROM grade_meta WHERE id = 1").get() as Raw | null;
  return row ? { fetchedAt: row.fetched_at as number, courses: row.courses as number } : null;
}

function rowToGrades(row: Raw): InstructorGrades {
  return {
    name: row.name as string,
    key: row.instructor_key as string,
    avg: row.avg as number,
    students: row.students as number,
    sections: row.sections as number,
    sigma: (row.sigma as number | null) ?? null,
    dist: JSON.parse(row.dist as string),
    bands: JSON.parse(row.bands as string),
  };
}

export function getCourseGrades(store: Store, subject: string, number: string): CourseGrades | null {
  const rows = store.db
    .query("SELECT * FROM grade_stats WHERE subject = ? AND number = ? ORDER BY avg DESC")
    .all(subject.toUpperCase(), number.toUpperCase()) as Raw[];
  const overall = rows.find(row => row.instructor_key === "");
  if (!overall) return null;
  return {
    subject: subject.toUpperCase(),
    number: number.toUpperCase(),
    overall: rowToGrades(overall),
    instructors: rows.filter(row => row.instructor_key !== "").map(rowToGrades),
    spread: (overall.spread as number | null) ?? null,
    fetchedAt: gradeMeta(store)?.fetchedAt ?? 0,
  };
}

export interface GradeSyncDeps {
  store: Store;
  events?: Events;
  fetch?: FetchLike;
  url?: string;
  now?: () => number;
}

export class GradeSync {
  private store: Store;
  private events: Events | undefined;
  private fetchImpl: FetchLike;
  private url: string;
  private now: () => number;
  private running: Promise<{ courses: number }> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failedAt: number | null = null;

  constructor(deps: GradeSyncDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.url = deps.url ?? GRADES_URL;
    this.now = deps.now ?? Date.now;
  }

  isStale(): boolean {
    const meta = gradeMeta(this.store);
    return !meta || this.now() - meta.fetchedAt >= GRADES_MAX_AGE_MS;
  }

  /** Fetch and store the grade data. Old data stays when anything fails. */
  sync(opts: { force?: boolean } = {}): Promise<{ courses: number }> {
    if (this.running) return this.running;
    if (!opts.force && !this.isStale()) return Promise.resolve({ courses: gradeMeta(this.store)?.courses ?? 0 });
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<{ courses: number }> {
    try {
      const response = await this.fetchImpl(this.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const courses = parseGradeData(await response.json());
      replaceGrades(this.store, courses, this.now());
      this.failedAt = null;
      this.events?.emit({
        kind: "catalog_synced",
        severity: "info",
        title: "Grade data updated",
        detail: `${courses.length} courses`,
        payload: { grades: courses.length },
      });
      return { courses: courses.length };
    } catch (error) {
      this.failedAt = this.now();
      this.events?.emit({
        kind: "catalog_synced",
        severity: "warning",
        title: "Grade data update failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Check hourly and refresh once the data is a week old. Also checks right away. */
  startDaily(checkEveryMs = 60 * 60 * 1000): void {
    this.stop();
    const check = () => {
      // After a failure, wait six hours before trying again on its own.
      if (this.failedAt !== null && this.now() - this.failedAt < 6 * 60 * 60 * 1000) return;
      if (!this.running && this.isStale()) this.sync().catch(() => undefined);
    };
    check();
    this.timer = setInterval(check, checkEveryMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
