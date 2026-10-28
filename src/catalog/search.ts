// Catalog search (FTS5 prefix queries) and course detail assembly.

import type { SeatSource } from "../core/contracts";
import type { Store } from "../core/db";
import type { CourseDetail, Meeting, SearchHit, Section } from "../core/types";
import type { LinkedSections } from "../banner/linked";
import type { Explorer } from "./explorer";
import { getStoredCourse, getStoredSections, saveCourses, storedLinkedOptions } from "./store";

type Row = Record<string, any>;

const DEFAULT_LIMIT = 25;

function summaryFromRow(row: Row): Omit<SearchHit, "matchedCrn" | "matchedInstructor"> {
  return {
    term: row.term,
    subject: row.subject,
    number: row.number,
    title: row.title,
    creditHours: row.credit_hours,
    sectionCount: row.section_count,
  };
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 8);
}

function ftsQuery(tokens: string[]): string {
  return tokens
    .map(token => {
      // Short numbers are course numbers ("225"); longer ones may be partial CRNs.
      if (/^\d{1,3}$/.test(token)) return `number : "${token}"*`;
      if (/^\d{4,5}$/.test(token)) return `{number crns} : "${token}"*`;
      return `"${token}"*`;
    })
    .join(" AND ");
}

/** Instructor names of a course whose last name starts with one of the tokens. */
function matchedInstructor(store: Store, term: string, subject: string, number: string, tokens: string[]): string | null {
  const alpha = tokens.filter(token => /^[a-z]{2,}$/.test(token));
  if (!alpha.length) return null;
  const rows = store.db
    .query("SELECT meetings FROM cat_sections WHERE term = ? AND subject = ? AND number = ?")
    .all(term, subject, number) as Row[];
  for (const row of rows) {
    for (const meeting of JSON.parse(row.meetings) as Meeting[]) {
      for (const name of meeting.instructors) {
        const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
        if (alpha.some(token => words.some(word => word.length > 1 && word.startsWith(token)))) return name;
      }
    }
  }
  return null;
}

/**
 * Search the catalog of one term. Order: exact CRN, exact course code, subject listing, then FTS relevance.
 * Matches "225", "cs 225", "cs225", "data struct", an instructor last name, or a CRN.
 */
export function search(store: Store, term: string, q: string, limit = DEFAULT_LIMIT): SearchHit[] {
  const query = q.trim();
  if (!query) return [];
  const hits = new Map<string, SearchHit>();
  const add = (row: Row, extra: Partial<SearchHit> = {}) => {
    const key = `${row.subject} ${row.number}`;
    if (hits.has(key) || hits.size >= limit) return;
    hits.set(key, { ...summaryFromRow(row), matchedCrn: null, matchedInstructor: null, ...extra });
  };

  // 1. Exact CRN.
  if (/^\d{5}$/.test(query)) {
    const row = store.db
      .query(
        `SELECT c.*, s.crn AS matched FROM cat_sections s JOIN cat_courses c
         ON c.term = s.term AND c.subject = s.subject AND c.number = s.number WHERE s.term = ? AND s.crn = ?`,
      )
      .get(term, query) as Row | null;
    if (row) add(row, { matchedCrn: row.matched });
  }

  // 2. Course code: "cs 225", "CS225", "cs 22".
  const code = /^([a-z]{2,5})\s*(\d{1,3}[a-z]?)$/i.exec(query);
  if (code) {
    const rows = store.db
      .query("SELECT * FROM cat_courses WHERE term = ? AND subject = ? AND number LIKE ? ORDER BY number LIMIT ?")
      .all(term, code[1]!.toUpperCase(), `${code[2]!.toUpperCase()}%`, limit) as Row[];
    rows.forEach(row => add(row));
  }

  // 3. Bare subject: "math" lists MATH courses first.
  if (/^[a-z]{2,5}$/i.test(query)) {
    const rows = store.db
      .query("SELECT * FROM cat_courses WHERE term = ? AND subject = ? ORDER BY number LIMIT ?")
      .all(term, query.toUpperCase(), limit) as Row[];
    rows.forEach(row => add(row));
  }

  // 4. Full-text prefix search.
  const tokens = tokenize(query);
  if (tokens.length && hits.size < limit) {
    let rows: Row[] = [];
    try {
      rows = store.db
        .query(
          `SELECT c.* FROM cat_fts f JOIN cat_courses c ON c.term = f.term AND c.subject = f.subject AND c.number = f.number
           WHERE cat_fts MATCH ? AND f.term = ?
           ORDER BY bm25(cat_fts, 0.0, 6.0, 8.0, 8.0, 4.0, 3.0, 1.0), c.subject, c.number LIMIT ?`,
        )
        .all(ftsQuery(tokens), term, limit * 2) as Row[];
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const crn = tokens.find(token => /^\d{5}$/.test(token));
      add(row, {
        matchedCrn: crn && (store.db.query("SELECT 1 FROM cat_sections WHERE term = ? AND crn = ?").get(term, crn) ? crn : null) || null,
        matchedInstructor: matchedInstructor(store, term, row.subject, row.number, tokens),
      });
    }
  }

  // Report instructor matches only when the title and code did not explain the hit.
  for (const hit of hits.values()) {
    if (!hit.matchedInstructor) continue;
    const words = `${hit.subject} ${hit.number} ${hit.title}`.toLowerCase().split(/[^a-z0-9]+/);
    if (tokens.every(token => words.some(word => word.startsWith(token)))) hit.matchedInstructor = null;
  }
  return [...hits.values()];
}

export interface CourseDetailOptions {
  /** Fetch the course from Course Explorer when it is not stored yet. */
  explorer?: Explorer;
  /** Fetch missing linked-section data from Banner (cached 24 h). */
  linked?: LinkedSections;
  /** Fetch live seats for every section and store them. Failures are ignored. */
  seatSource?: SeatSource;
}

/** Sections whose Banner linked data best describes the course: the type with the fewest sections. */
export function linkProbeCrns(sections: { crn: string; type: string }[], cap = 12): string[] {
  const byType = new Map<string, string[]>();
  for (const section of sections) byType.set(section.type, [...(byType.get(section.type) ?? []), section.crn]);
  if (byType.size === 0) return [];
  const [, crns] = [...byType.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))[0]!;
  return crns.slice(0, cap);
}

export async function courseDetail(
  store: Store,
  term: string,
  subject: string,
  number: string,
  options: CourseDetailOptions = {},
): Promise<CourseDetail | null> {
  const subj = subject.toUpperCase();
  let course = getStoredCourse(store, term, subj, number);
  if (!course && options.explorer) {
    const fetched = await options.explorer.course(term, subj, number);
    if (fetched) saveCourses(store, [fetched]);
    course = getStoredCourse(store, term, subj, number);
  }
  if (!course) return null;

  const stored = getStoredSections(store, term, subj, number);
  const crns = stored.map(section => section.crn);

  const linkedWork = async () => {
    if (!options.linked || !stored.length) return;
    // Three at a time and cached for 24 h by the fetcher, so repeat views cost nothing.
    const queue = linkProbeCrns(stored);
    const worker = async () => {
      for (let crn = queue.shift(); crn; crn = queue.shift()) await options.linked!.get(term, crn);
    };
    await Promise.all([worker(), worker(), worker()]);
  };
  const seatWork = async () => {
    if (!options.seatSource || !crns.length) return;
    try {
      const seats = await options.seatSource.fetchSeats(term, crns);
      store.tx(() => seats.forEach(seat => store.upsertSeat(seat)));
    } catch {
      // Seat counts are optional in the detail view.
    }
  };
  await Promise.all([linkedWork(), seatWork()]);

  const sections: Section[] = stored.map(section => ({ ...section, seats: store.getSeat(term, section.crn) }));
  return {
    term,
    subject: course.subject,
    number: course.number,
    title: course.title,
    creditHours: course.creditHours,
    sectionCount: course.sectionCount,
    description: course.description,
    scheduleInfo: course.scheduleInfo,
    sections,
    linkedOptions: storedLinkedOptions(store, term, crns),
  };
}
