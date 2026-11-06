// Grade disparity helpers shared by the server and the web UI. Runtime safe for the browser bundle.

import type { CourseGrades, InstructorGrades, Meeting } from "./types";

/**
 * Comparable instructor key. Course Explorer writes "Erickson, J" or " Solomon, B" and the grade data
 * writes "Erickson, J.", so both become "erickson|j". Names without a comma use the whole name.
 */
export function instructorKey(name: string): string {
  const clean = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean === "all sections" || clean === "staff") return "";
  const comma = clean.indexOf(",");
  if (comma < 0) return clean;
  const last = clean.slice(0, comma).trim();
  const first = clean.slice(comma + 1).trim();
  return `${last}|${first.charAt(0)}`;
}

/** Grade rows for instructor names, in name order, skipping names without data. */
export function instructorGrades(grades: CourseGrades | null | undefined, names: string[]): InstructorGrades[] {
  if (!grades) return [];
  const out: InstructorGrades[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = instructorKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = grades.instructors.find(g => g.key === key);
    if (row) out.push(row);
  }
  return out;
}

/** Distinct instructor names of a section's meetings. */
export function sectionInstructors(section: { meetings: Pick<Meeting, "instructors">[] }): string[] {
  return [...new Set(section.meetings.flatMap(m => m.instructors))];
}

/**
 * Expected GPA of a bundle: the student-weighted average of every instructor with data across its
 * sections, or the course's all-sections average when none match.
 */
export function bundleGpa(
  grades: CourseGrades | null | undefined,
  sections: { meetings: Pick<Meeting, "instructors">[] }[],
): { gpa: number; source: "instructor" | "course" } | null {
  if (!grades) return null;
  const rows = instructorGrades(grades, sections.flatMap(sectionInstructors));
  const students = rows.reduce((n, r) => n + r.students, 0);
  if (rows.length && students > 0) {
    return { gpa: rows.reduce((sum, r) => sum + r.avg * r.students, 0) / students, source: "instructor" };
  }
  return { gpa: grades.overall.avg, source: "course" };
}

/** Tone of a sigma difference, matching the waf visualization's red ramp below -0.25. */
export function sigmaTone(sigma: number | null): "good" | "neutral" | "low" | "bad" {
  if (sigma === null) return "neutral";
  if (sigma <= -0.5) return "bad";
  if (sigma <= -0.25) return "low";
  if (sigma >= 0.1) return "good";
  return "neutral";
}
