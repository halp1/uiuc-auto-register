// Pure bundle logic: which bundles are fully open, and candidate bundles for "any valid combination".

import type { AnyFilters, Bundle, BundleState, CourseDetail, Meeting, SeatInfo, Section, WantedCourse } from "../core/types";
import { minutes, sectionsConflict } from "./schedule";

export type SeatLookup = (crn: string) => Pick<SeatInfo, "available"> | null | undefined;

/** True when every CRN in the list has at least one known open seat. */
export function isFullyOpen(crns: string[], seats: SeatLookup): boolean {
  return crns.length > 0 && crns.every(crn => (seats(crn)?.available ?? 0) > 0);
}

/** True when some CRN is known to be closed (a missing reading does not count as closed). */
export function hasClosedCrn(crns: string[], seats: SeatLookup): boolean {
  return crns.some(crn => {
    const seat = seats(crn);
    return seat !== null && seat !== undefined && seat.available <= 0;
  });
}

/** Bundles in rank order whose every CRN is open, limited to the given states (default: watching). */
export function openBundles(
  course: Pick<WantedCourse, "bundles">,
  seats: SeatLookup,
  states: BundleState[] = ["watching"],
): Bundle[] {
  return [...course.bundles]
    .sort((a, b) => a.rank - b.rank || a.id - b.id)
    .filter(bundle => states.includes(bundle.state) && isFullyOpen(bundle.crns, seats));
}

// ---------- "any valid combination" ----------

function meetingExcluded(meeting: Meeting, filters: AnyFilters): boolean {
  if (filters.excludeDays.some(day => meeting.days.includes(day))) return true;
  const start = minutes(meeting.start);
  const end = minutes(meeting.end);
  if (start !== null && end !== null) {
    for (const range of filters.excludeTimes) {
      const from = minutes(range.start);
      const to = minutes(range.end);
      if (from === null || to === null) continue;
      if (start < to && from < end) return true;
    }
  }
  const names = meeting.instructors.map(name => name.toLowerCase());
  return filters.excludeInstructors.some(pattern => {
    const needle = pattern.trim().toLowerCase();
    return needle.length > 0 && names.some(name => name.includes(needle));
  });
}

/** True when any meeting of the section violates the filters. */
export function sectionExcluded(section: Pick<Section, "meetings">, filters: AnyFilters): boolean {
  return section.meetings.some(meeting => meetingExcluded(meeting, filters));
}

const TYPE_PREFERENCE = ["LEC", "LCD", "ONL", "OLC", "SEM", "STU", "LBD", "LAB", "DIS", "QZ", "PR"];

function typeRank(type: string): number {
  const index = TYPE_PREFERENCE.indexOf(type);
  return index < 0 ? TYPE_PREFERENCE.length : index;
}

const MAX_BUNDLES = 300;

/** Combine one section of each type, restricted to matching section letters when that pattern fits UIUC's convention. */
function combineTypes(sections: Section[]): Section[][] {
  const byType = new Map<string, Section[]>();
  for (const section of sections) byType.set(section.type, [...(byType.get(section.type) ?? []), section]);
  const types = [...byType.keys()].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  if (types.length <= 1) return sections.map(section => [section]);

  // UIUC links sections by their first letter (AL1 with AYA, BL1 with BYB) when the course has groups.
  const letter = (section: Section) => section.section.charAt(0).toUpperCase();
  // Judge only letters that have a primary-type section; stray groups (e.g. an honors "CSP") do not count.
  const letters = new Set(byType.get(types[0]!)!.map(letter));
  const groupsComplete =
    letters.size > 1 && [...letters].every(l => types.every(type => byType.get(type)!.some(section => letter(section) === l)));

  const out: Section[][] = [];
  const walk = (index: number, picked: Section[]) => {
    if (out.length >= MAX_BUNDLES) return;
    if (index === types.length) {
      out.push(picked);
      return;
    }
    for (const section of byType.get(types[index]!)!) {
      if (groupsComplete && picked.length && letter(section) !== letter(picked[0]!)) continue;
      if (picked.some(other => sectionsConflict(other, section))) continue;
      walk(index + 1, [...picked, section]);
    }
  };
  walk(0, []);
  return out;
}

function minSeats(crns: string[], seats: Map<string, number | null>): number | null {
  let min: number | null = Infinity;
  for (const crn of crns) {
    const value = seats.get(crn);
    if (value === null || value === undefined) return null;
    min = Math.min(min, value);
  }
  return min === Infinity ? null : min;
}

/**
 * Candidate bundles for kind "any". Primary sections (lecture, or the type that has linked data)
 * are combined with each Banner linked option; sections that hit an exclusion are dropped. Courses
 * without linked data combine one section of each type. Ranked by most open seats when known.
 */
export function expandAny(course: Pick<CourseDetail, "sections" | "linkedOptions">, filters: AnyFilters): string[][] {
  const byCrn = new Map(course.sections.map(section => [section.crn, section]));
  const allowed = (crn: string) => {
    const section = byCrn.get(crn);
    return section ? !sectionExcluded(section, filters) : true; // unknown linked CRN: cannot filter, keep
  };

  const linkedTypes = new Set(
    course.sections.filter(section => course.linkedOptions[section.crn] !== undefined).map(section => section.type),
  );
  const bundles: string[][] = [];
  const seen = new Set<string>();
  const push = (crns: string[]) => {
    const key = [...crns].sort().join(",");
    if (seen.has(key) || bundles.length >= MAX_BUNDLES) return;
    seen.add(key);
    bundles.push(crns);
  };

  if (linkedTypes.size > 0) {
    const primaryType = [...linkedTypes].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b))[0]!;
    const primaries = course.sections.filter(section => section.type === primaryType);
    const unlinked: Section[] = [];
    for (const primary of primaries) {
      const options = course.linkedOptions[primary.crn];
      if (options === undefined) {
        unlinked.push(primary);
        continue;
      }
      if (!allowed(primary.crn)) continue;
      if (options.length === 0) {
        push([primary.crn]);
        continue;
      }
      for (const option of options) {
        if (!option.every(allowed)) continue;
        const partners = option.map(crn => byCrn.get(crn)).filter((s): s is Section => Boolean(s));
        if (partners.some(partner => sectionsConflict(primary, partner))) continue;
        push([primary.crn, ...option]);
      }
    }
    // Primaries without linked data yet: fall back to type combination within their letter group.
    if (unlinked.length) {
      const others = course.sections.filter(section => section.type !== primaryType);
      for (const combo of combineTypes([...unlinked, ...others])) {
        if (!combo.some(section => section.type === primaryType)) continue;
        if (combo.every(section => allowed(section.crn))) push(combo.map(section => section.crn));
      }
    }
  } else {
    const usable = course.sections.filter(section => allowed(section.crn));
    // Types present in the full course are all required; drop combos missing a type after filtering.
    const requiredTypes = new Set(course.sections.map(section => section.type));
    for (const combo of combineTypes(usable)) {
      if (new Set(combo.map(section => section.type)).size !== requiredTypes.size) continue;
      push(combo.map(section => section.crn));
    }
  }

  const seats = new Map(course.sections.map(section => [section.crn, section.seats ? section.seats.available : null]));
  return bundles
    .map((crns, index) => ({ crns, index, seats: minSeats(crns, seats) }))
    .sort((a, b) => {
      const as = a.seats ?? -1;
      const bs = b.seats ?? -1;
      return bs - as || a.index - b.index;
    })
    .map(entry => entry.crns);
}
