// Catalog persistence in the cat_* tables of the shared SQLite store.

import type { Store } from "../core/db";
import type { Meeting } from "../core/types";
import type { CatalogCourse, CatalogSection } from "./explorer";

type Row = Record<string, any>;

function sectionInstructors(section: CatalogSection): string[] {
  return [...new Set(section.meetings.flatMap(meeting => meeting.instructors))];
}

/** Instructor names as FTS text: "Erickson, J" -> "Erickson J". */
function instructorText(names: string[]): string {
  return names.map(name => name.replace(/[,]/g, " ").replace(/\s+/g, " ").trim()).join(" ");
}

function writeCourse(store: Store, course: CatalogCourse): void {
  const db = store.db;
  const { term, subject, number } = course;
  db.query(
    `INSERT INTO cat_courses (term, subject, number, title, credit_hours, description, schedule_info, section_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, subject, number) DO UPDATE SET title = excluded.title, credit_hours = excluded.credit_hours,
     description = excluded.description, schedule_info = excluded.schedule_info, section_count = excluded.section_count`,
  ).run(term, subject, number, course.title, course.creditHours, course.description, course.scheduleInfo, course.sections.length);
  db.query("DELETE FROM cat_sections WHERE term = ? AND subject = ? AND number = ?").run(term, subject, number);
  const insert = db.query(
    `INSERT INTO cat_sections (term, crn, subject, number, section, type, type_name, part_of_term, meetings, instructors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, crn) DO UPDATE SET subject = excluded.subject, number = excluded.number, section = excluded.section,
     type = excluded.type, type_name = excluded.type_name, part_of_term = excluded.part_of_term,
     meetings = excluded.meetings, instructors = excluded.instructors`,
  );
  const allInstructors = new Set<string>();
  for (const section of course.sections) {
    const names = sectionInstructors(section);
    names.forEach(name => allInstructors.add(name));
    insert.run(
      term,
      section.crn,
      subject,
      number,
      section.section,
      section.type,
      section.typeName,
      section.partOfTerm,
      JSON.stringify(section.meetings),
      instructorText(names),
    );
  }
  db.query("DELETE FROM cat_fts WHERE term = ? AND subject = ? AND number = ?").run(term, subject, number);
  db.query("INSERT INTO cat_fts (term, subject, number, code, title, instructors, crns) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    term,
    subject,
    number,
    `${subject}${number}`,
    course.title,
    instructorText([...allInstructors]),
    course.sections.map(section => section.crn).join(" "),
  );
}

/** Insert or replace courses (and their sections and FTS rows). */
export function saveCourses(store: Store, courses: CatalogCourse[]): void {
  store.tx(() => courses.forEach(course => writeCourse(store, course)));
}

/** Replace every course of one subject (removes courses no longer offered). */
export function replaceSubject(store: Store, term: string, subject: string, courses: CatalogCourse[]): void {
  store.tx(() => {
    const keep = new Set(courses.map(course => course.number));
    const existing = store.db.query("SELECT number FROM cat_courses WHERE term = ? AND subject = ?").all(term, subject) as Row[];
    for (const row of existing) {
      if (keep.has(row.number)) continue;
      store.db.query("DELETE FROM cat_courses WHERE term = ? AND subject = ? AND number = ?").run(term, subject, row.number);
      store.db.query("DELETE FROM cat_sections WHERE term = ? AND subject = ? AND number = ?").run(term, subject, row.number);
      store.db.query("DELETE FROM cat_fts WHERE term = ? AND subject = ? AND number = ?").run(term, subject, row.number);
    }
    courses.forEach(course => writeCourse(store, course));
  });
}

export function setCatalogMeta(store: Store, term: string, syncedAt: number): number {
  const count = (store.db.query("SELECT COUNT(*) AS n FROM cat_courses WHERE term = ?").get(term) as Row).n as number;
  store.db
    .query(
      `INSERT INTO cat_meta (term, synced_at, courses) VALUES (?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET synced_at = excluded.synced_at, courses = excluded.courses`,
    )
    .run(term, syncedAt, count);
  return count;
}

export function catalogMeta(store: Store, term: string): { syncedAt: number; courses: number } | null {
  const row = store.db.query("SELECT synced_at, courses FROM cat_meta WHERE term = ?").get(term) as Row | null;
  return row ? { syncedAt: row.synced_at, courses: row.courses } : null;
}

export function courseCount(store: Store, term: string): number {
  return (store.db.query("SELECT COUNT(*) AS n FROM cat_courses WHERE term = ?").get(term) as Row).n as number;
}

export interface StoredCourse {
  term: string;
  subject: string;
  number: string;
  title: string;
  creditHours: string | null;
  description: string | null;
  scheduleInfo: string | null;
  sectionCount: number;
}

export function getStoredCourse(store: Store, term: string, subject: string, number: string): StoredCourse | null {
  const row = store.db
    .query("SELECT * FROM cat_courses WHERE term = ? AND subject = ? AND number = ?")
    .get(term, subject.toUpperCase(), number) as Row | null;
  if (!row) return null;
  return {
    term: row.term,
    subject: row.subject,
    number: row.number,
    title: row.title,
    creditHours: row.credit_hours,
    description: row.description,
    scheduleInfo: row.schedule_info,
    sectionCount: row.section_count,
  };
}

export function getStoredSections(store: Store, term: string, subject: string, number: string): CatalogSection[] {
  const rows = store.db
    .query("SELECT * FROM cat_sections WHERE term = ? AND subject = ? AND number = ? ORDER BY section, crn")
    .all(term, subject.toUpperCase(), number) as Row[];
  return rows.map(row => ({
    crn: row.crn,
    section: row.section,
    type: row.type,
    typeName: row.type_name,
    partOfTerm: row.part_of_term,
    meetings: JSON.parse(row.meetings) as Meeting[],
  }));
}

/** Course that owns a CRN, if the catalog knows it. */
export function courseForCrn(store: Store, term: string, crn: string): { subject: string; number: string; section: string } | null {
  const row = store.db.query("SELECT subject, number, section FROM cat_sections WHERE term = ? AND crn = ?").get(term, crn) as Row | null;
  return row ? { subject: row.subject, number: row.number, section: row.section } : null;
}

export function storedLinkedOptions(store: Store, term: string, crns: string[]): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  const query = store.db.query("SELECT options FROM linked_options WHERE term = ? AND crn = ?");
  for (const crn of crns) {
    const row = query.get(term, crn) as Row | null;
    if (row) out[crn] = JSON.parse(row.options);
  }
  return out;
}
