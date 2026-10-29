// Pure schedule math: meeting conflicts (part-of-term aware), breaks, and the schedule generator.

import type {
  AnyFilters,
  CourseDetail,
  Meeting,
  PlanBreak,
  PlanPick,
  PlanSchedule,
  PlanScheduleStats,
  PlanSort,
  SeatInfo,
  Section,
} from "../core/types";
import { expandAny } from "./planner";

/** What the conflict math needs from a section. */
export type SchedSection = Pick<Section, "crn" | "meetings" | "partOfTerm"> & { seats?: Pick<SeatInfo, "available"> | null };

export const GENERATE_LIMITS = { maxSchedules: 5000, budgetMs: 1500, slice: 200, backups: 20 } as const;

/** "HH:MM" -> minutes after midnight, null when missing or malformed. */
export function minutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** A meeting with days and both times. Arranged or online meetings are untimed and never conflict. */
export function isTimed(meeting: Pick<Meeting, "days" | "start" | "end">): boolean {
  return meeting.days.length > 0 && minutes(meeting.start) !== null && minutes(meeting.end) !== null;
}

/** Same day and overlapping time (touching edges do not overlap). */
export function meetingsOverlap(a: Pick<Meeting, "days" | "start" | "end">, b: Pick<Meeting, "days" | "start" | "end">): boolean {
  if (![...a.days].some(day => b.days.includes(day))) return false;
  const as = minutes(a.start);
  const ae = minutes(a.end);
  const bs = minutes(b.start);
  const be = minutes(b.end);
  if (as === null || ae === null || bs === null || be === null) return false;
  return as < be && bs < ae;
}

const isFullTerm = (part: string | null | undefined) => part === null || part === undefined || part === "" || part === "1";

/** Parts of term overlap when equal or when either runs the full term ("1" or unknown). */
export function partsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  return isFullTerm(a) || isFullTerm(b) || a === b;
}

export function sectionsConflict(a: Pick<SchedSection, "meetings" | "partOfTerm">, b: Pick<SchedSection, "meetings" | "partOfTerm">): boolean {
  if (!partsOverlap(a.partOfTerm, b.partOfTerm)) return false;
  return a.meetings.some(ma => b.meetings.some(mb => meetingsOverlap(ma, mb)));
}

/** True when any timed meeting of the section overlaps a break. */
export function breakHit(section: Pick<SchedSection, "meetings">, breaks: PlanBreak[]): boolean {
  return breaks.some(entry => section.meetings.some(meeting => meetingsOverlap(meeting, { days: entry.days.join(""), start: entry.start, end: entry.end })));
}

/** CRNs in `others` that clash with any section of the bundle. */
export function planConflicts(bundle: SchedSection[], others: SchedSection[]): string[] {
  const out = new Set<string>();
  for (const other of others) {
    if (bundle.some(section => section.crn !== other.crn && sectionsConflict(section, other))) out.add(other.crn);
  }
  return [...out];
}

const NO_FILTERS: AnyFilters = { excludeDays: [], excludeTimes: [], excludeInstructors: [] };

/** Candidate bundles for one plan course: every valid combination minus excluded CRNs, or the locked bundle. */
export function courseOptions(
  course: Pick<CourseDetail, "sections" | "linkedOptions">,
  opts: { excludedCrns?: string[]; locked?: string[] | null } = {},
): string[][] {
  const known = new Set(course.sections.map(section => section.crn));
  if (opts.locked && opts.locked.length) return opts.locked.every(crn => known.has(crn)) ? [[...opts.locked]] : [];
  const excluded = new Set(opts.excludedCrns ?? []);
  return expandAny(course, NO_FILTERS).filter(bundle => !bundle.some(crn => excluded.has(crn)));
}

// ---------- stats and sorting ----------

export function scheduleStats(sections: SchedSection[]): PlanScheduleStats {
  const byDay = new Map<string, [number, number][]>();
  let start: number | null = null;
  let end: number | null = null;
  for (const section of sections) {
    for (const meeting of section.meetings) {
      if (!isTimed(meeting)) continue;
      const s = minutes(meeting.start)!;
      const e = minutes(meeting.end)!;
      start = start === null ? s : Math.min(start, s);
      end = end === null ? e : Math.max(end, e);
      for (const day of meeting.days) byDay.set(day, [...(byDay.get(day) ?? []), [s, e]]);
    }
  }
  let gapMin = 0;
  for (const intervals of byDay.values()) {
    intervals.sort((a, b) => a[0] - b[0]);
    let reach = intervals[0]![1];
    for (const [s, e] of intervals.slice(1)) {
      if (s > reach) gapMin += s - reach;
      reach = Math.max(reach, e);
    }
  }
  let closed = 0;
  let minSeats: number | null = null;
  for (const section of sections) {
    if (!section.seats) continue;
    if (section.seats.available <= 0) closed++;
    minSeats = minSeats === null ? section.seats.available : Math.min(minSeats, section.seats.available);
  }
  const hhmm = (value: number | null) =>
    value === null ? null : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return { days: byDay.size, start: hhmm(start), end: hhmm(end), gapMin, closed, minSeats };
}

const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
};

export function compareSchedules(sort: PlanSort) {
  return (a: PlanSchedule, b: PlanSchedule): number => {
    const x = a.stats;
    const y = b.stats;
    let primary = 0;
    switch (sort) {
      case "open":
        primary = x.closed - y.closed || nullsLast(x.minSeats, y.minSeats, -1);
        break;
      case "days":
        primary = x.days - y.days;
        break;
      case "start":
        primary = nullsLast(minutes(x.start), minutes(y.start), -1);
        break;
      case "end":
        primary = nullsLast(minutes(x.end), minutes(y.end), 1);
        break;
      case "gaps":
        primary = x.gapMin - y.gapMin;
        break;
    }
    return primary || x.gapMin - y.gapMin || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  };
}

// ---------- generator ----------

export interface GenerateInput {
  /** One entry per course to schedule, with its candidate bundles. */
  courses: { subject: string; number: string; options: string[][] }[];
  /** Section data by CRN. CRNs without data have no meetings (never conflict). */
  sections: Map<string, SchedSection>;
  /** Already registered sections that stay put. */
  fixed: SchedSection[];
  breaks: PlanBreak[];
  openOnly?: boolean;
  sort?: PlanSort;
  now?: () => number;
  maxSchedules?: number;
  budgetMs?: number;
  limit?: number;
}

export interface GenerateOutput {
  schedules: PlanSchedule[];
  total: number;
  truncated: boolean;
  /** Usable options per input course (after breaks and fixed blocks), in input order. */
  viable: number[];
}

function sectionsOf(crns: string[], sections: Map<string, SchedSection>): SchedSection[] {
  return crns.map(crn => sections.get(crn) ?? { crn, meetings: [], partOfTerm: null, seats: null });
}

function internallyValid(list: SchedSection[]): boolean {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (sectionsConflict(list[i]!, list[j]!)) return false;
  return true;
}

/** True when the option fits around the fixed blocks and breaks. */
function fits(list: SchedSection[], fixed: SchedSection[], breaks: PlanBreak[]): boolean {
  return internallyValid(list) && !list.some(section => breakHit(section, breaks)) && planConflicts(list, fixed).length === 0;
}

/**
 * Every conflict-free combination of one option per course. Depth-first with the most constrained
 * course first. Stops at maxSchedules or the time budget (truncated). Then openOnly, stats, sort, slice.
 */
export function generateSchedules(input: GenerateInput): GenerateOutput {
  const now = input.now ?? Date.now;
  const started = now();
  const maxSchedules = input.maxSchedules ?? GENERATE_LIMITS.maxSchedules;
  const budgetMs = input.budgetMs ?? GENERATE_LIMITS.budgetMs;
  const limit = input.limit ?? GENERATE_LIMITS.slice;

  // Options that fit on their own.
  const prepared = input.courses.map(course =>
    course.options
      .map(crns => ({ crns, sections: sectionsOf(crns, input.sections) }))
      .filter(option => fits(option.sections, input.fixed, input.breaks)),
  );
  const viable = prepared.map(options => options.length);
  if (input.courses.length === 0 || viable.some(count => count === 0)) {
    return { schedules: [], total: 0, truncated: false, viable };
  }

  const order = prepared.map((_, index) => index).sort((a, b) => viable[a]! - viable[b]! || a - b);
  const found: number[][] = []; // option index per course (input order)
  const chosen: number[] = new Array(input.courses.length).fill(-1);
  const picked: SchedSection[][] = [];
  let truncated = false;
  let nodes = 0;

  const walk = (depth: number): void => {
    if (truncated) return;
    if (depth === order.length) {
      found.push([...chosen]);
      if (found.length >= maxSchedules) truncated = true;
      return;
    }
    const courseIndex = order[depth]!;
    const options = prepared[courseIndex]!;
    for (let i = 0; i < options.length; i++) {
      if ((++nodes & 255) === 0 && now() - started > budgetMs) {
        truncated = true;
        return;
      }
      const option = options[i]!;
      if (picked.some(other => other.some(a => option.sections.some(b => sectionsConflict(a, b))))) continue;
      chosen[courseIndex] = i;
      picked.push(option.sections);
      walk(depth + 1);
      picked.pop();
      chosen[courseIndex] = -1;
      if (truncated) return;
    }
  };
  walk(0);

  // "Open now only" means every section has a known open seat. Unknown seats do not count as open.
  const openNow = (choice: number[]) =>
    choice.every((optionIndex, courseIndex) =>
      prepared[courseIndex]![optionIndex]!.sections.every(section => (section.seats?.available ?? 0) > 0),
    );
  const kept = input.openOnly ? found.filter(openNow) : found;

  const schedules: PlanSchedule[] = kept.map(choice => {
    const picks: PlanPick[] = choice.map((optionIndex, courseIndex) => ({
      subject: input.courses[courseIndex]!.subject,
      number: input.courses[courseIndex]!.number,
      crns: [...prepared[courseIndex]![optionIndex]!.crns],
    }));
    const all = choice.flatMap((optionIndex, courseIndex) => prepared[courseIndex]![optionIndex]!.sections);
    return {
      key: picks.flatMap(pick => pick.crns).sort().join(","),
      picks,
      stats: scheduleStats(all),
    };
  });
  schedules.sort(compareSchedules(input.sort ?? "open"));
  return { schedules: schedules.slice(0, limit), total: schedules.length, truncated, viable };
}

/**
 * Lower-ranked alternates for one course when targeting: its other options that fit around the
 * other picks, the fixed blocks, and the breaks. Most open seats first (unknown last), then stable.
 */
export function backupBundles(input: {
  options: string[][];
  chosen: string[];
  others: SchedSection[];
  fixed: SchedSection[];
  breaks: PlanBreak[];
  sections: Map<string, SchedSection>;
  cap?: number;
}): string[][] {
  const chosenKey = [...input.chosen].sort().join(",");
  const blockers = [...input.others, ...input.fixed];
  return input.options
    .filter(crns => [...crns].sort().join(",") !== chosenKey)
    .map((crns, index) => ({ crns, index, sections: sectionsOf(crns, input.sections) }))
    .filter(option => fits(option.sections, blockers, input.breaks))
    .map(option => ({ ...option, seats: scheduleStats(option.sections).minSeats }))
    .sort((a, b) => nullsLast(a.seats, b.seats, -1) || a.index - b.index)
    .slice(0, input.cap ?? GENERATE_LIMITS.backups)
    .map(option => option.crns);
}
