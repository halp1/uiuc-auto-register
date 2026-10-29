// Schedule planner service: builds schedules from the catalog and turns a chosen one into armed bundles.
// Reads only the local catalog, stored seats, and existing anonymous lookups. Never registers anything.

import type { Store } from "../core/db";
import type { Events } from "../core/events";
import { termLabel } from "../core/terms";
import type {
  CourseDetail,
  Plan,
  PlanCourse,
  PlanCourseStatus,
  PlanGenerateResult,
  PlanPick,
  PlanSection,
  WantedCourse,
} from "../core/types";
import { courseForCrn, getStoredSections, sectionsByCrn } from "../catalog/store";
import { backupBundles, breakHit, courseOptions, generateSchedules, planConflicts, sectionsConflict, type SchedSection } from "./schedule";

export const SEAT_FRESH_MS = 10 * 60 * 1000;
const DETAIL_CONCURRENCY = 3;

export class PlanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export interface PlanServiceDeps {
  store: Store;
  events: Events;
  /** Course detail from the catalog (fetched on demand when missing). seats: also refresh live seats. */
  loadDetail: (term: string, subject: string, number: string, opts: { seats: boolean }) => Promise<CourseDetail | null>;
  activeTerm: () => string | null;
  now?: () => number;
}

interface LoadedCourse {
  course: PlanCourse;
  detail: CourseDetail | null;
  status: PlanCourseStatus;
  options: string[][];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const courseKey = (subject: string, number: string) => `${subject.toUpperCase()} ${number}`;

export class PlanService {
  private now: () => number;

  constructor(private deps: PlanServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  plan(planId: number): Plan {
    const plan = this.deps.store.getPlan(planId);
    if (!plan) throw new PlanError(404, "That plan no longer exists.");
    return plan;
  }

  /** CRNs that stay put: the latest schedule snapshot plus registered watchlist bundles. Empty when ignored. */
  fixedCrns(plan: Plan): string[] {
    if (plan.ignoreRegistered) return [];
    const { store } = this.deps;
    const crns = new Set(store.latestSchedule(plan.term)?.crns ?? []);
    for (const wanted of store.listWanted(plan.term)) {
      if (wanted.state !== "registered") continue;
      for (const bundle of wanted.bundles) if (bundle.state === "registered") bundle.crns.forEach(crn => crns.add(crn));
    }
    return [...crns].sort();
  }

  /** Plan courses that are already registered (watchlist state, or a fixed CRN of that course). */
  private registeredKeys(plan: Plan, fixed: string[]): Set<string> {
    const { store } = this.deps;
    const keys = new Set<string>();
    for (const wanted of store.listWanted(plan.term)) if (wanted.state === "registered") keys.add(courseKey(wanted.subject, wanted.number));
    for (const crn of fixed) {
      const owner = courseForCrn(store, plan.term, crn);
      if (owner) keys.add(courseKey(owner.subject, owner.number));
    }
    return keys;
  }

  /** Seats count as fresh when every stored section of the course was checked in the last 10 minutes. */
  private seatsFresh(term: string, subject: string, number: string): boolean {
    const sections = getStoredSections(this.deps.store, term, subject, number);
    if (!sections.length) return false;
    const cutoff = this.now() - SEAT_FRESH_MS;
    return sections.every(section => (this.deps.store.getSeat(term, section.crn)?.checkedAt ?? 0) >= cutoff);
  }

  private async loadCourses(plan: Plan, registered: Set<string>, opts: { seats: boolean }): Promise<LoadedCourse[]> {
    return mapLimit(plan.courses, DETAIL_CONCURRENCY, async (course): Promise<LoadedCourse> => {
      const key = courseKey(course.subject, course.number);
      if (!course.included) return { course, detail: null, status: "excluded", options: [] };
      if (registered.has(key)) return { course, detail: null, status: "registered", options: [] };
      const seats = opts.seats && !this.seatsFresh(plan.term, course.subject, course.number);
      let detail: CourseDetail | null = null;
      try {
        detail = await this.deps.loadDetail(plan.term, course.subject, course.number, { seats });
      } catch {
        detail = null;
      }
      if (!detail || detail.sections.length === 0) return { course, detail, status: "not_offered", options: [] };
      const options = courseOptions(detail, { excludedCrns: course.excludedCrns, locked: course.locked });
      return { course, detail, status: options.length ? "ok" : "no_options", options };
    });
  }

  private fixedSections(term: string, fixed: string[]): SchedSection[] {
    const known = sectionsByCrn(this.deps.store, term, fixed);
    return fixed.map(crn => {
      const section = known.get(crn);
      return section ? { ...section, seats: null } : { crn, meetings: [], partOfTerm: null, seats: null };
    });
  }

  async generate(planId: number): Promise<PlanGenerateResult> {
    const plan = this.plan(planId);
    const fixed = this.fixedCrns(plan);
    const registered = this.registeredKeys(plan, fixed);
    const loaded = await this.loadCourses(plan, registered, { seats: true });

    const sections: Record<string, PlanSection> = {};
    const sched = new Map<string, SchedSection>();
    for (const entry of loaded) {
      for (const section of entry.detail?.sections ?? []) {
        const full: PlanSection = { ...section, subject: entry.detail!.subject, number: entry.detail!.number };
        sections[section.crn] = full;
        sched.set(section.crn, full);
      }
    }
    const fixedKnown = sectionsByCrn(this.deps.store, plan.term, fixed);
    for (const crn of fixed) {
      const section = fixedKnown.get(crn);
      if (section && !sections[crn]) sections[crn] = { ...section, seats: this.deps.store.getSeat(plan.term, crn) };
    }

    const active = loaded.filter(entry => entry.status === "ok");
    const output = generateSchedules({
      courses: active.map(entry => ({ subject: entry.course.subject, number: entry.course.number, options: entry.options })),
      sections: sched,
      fixed: this.fixedSections(plan.term, fixed),
      breaks: plan.breaks,
      openOnly: plan.openOnly,
      sort: plan.sort,
    });
    const viableBy = new Map(active.map((entry, index) => [entry.course.id, output.viable[index] ?? 0]));

    return {
      schedules: output.schedules,
      total: output.total,
      truncated: output.truncated,
      courses: loaded.map(entry => {
        const options = entry.status === "ok" ? viableBy.get(entry.course.id) ?? 0 : 0;
        const status: PlanCourseStatus = entry.status === "ok" && options === 0 ? "no_options" : entry.status;
        return { subject: entry.course.subject, number: entry.course.number, options, status };
      }),
      fixed: fixed.map(crn => {
        const owner = courseForCrn(this.deps.store, plan.term, crn);
        return { crn, subject: owner?.subject ?? null, number: owner?.number ?? null };
      }),
      sections,
      generatedAt: this.now(),
    };
  }

  /**
   * Validate the picks and make them the watchlist for the plan's courses: chosen bundle first, then
   * backups that still fit. Every picked course is armed. Returns the changed wanted courses.
   */
  async target(planId: number, picks: PlanPick[]): Promise<{ plan: Plan; wanted: WantedCourse[] }> {
    const { store, events } = this.deps;
    const plan = this.plan(planId);
    if (plan.term !== this.deps.activeTerm()) {
      throw new PlanError(409, `Switch the active term to ${termLabel(plan.term)} before targeting this plan.`);
    }
    const fixed = this.fixedCrns(plan);
    const registered = this.registeredKeys(plan, fixed);
    const required = plan.courses.filter(course => course.included && !registered.has(courseKey(course.subject, course.number)));
    if (!required.length) throw new PlanError(400, "This plan has no courses left to register.");

    // Picks cover exactly the included, unregistered courses.
    const byKey = new Map<string, PlanPick>();
    for (const pick of picks) {
      const key = courseKey(pick.subject, pick.number);
      if (byKey.has(key)) throw new PlanError(400, `${key} is picked twice.`);
      byKey.set(key, { subject: pick.subject.toUpperCase(), number: pick.number, crns: [...pick.crns] });
    }
    const missing = required.filter(course => !byKey.has(courseKey(course.subject, course.number)));
    if (missing.length) throw new PlanError(400, `Pick sections for ${missing.map(c => courseKey(c.subject, c.number)).join(", ")}.`);
    const requiredKeys = new Set(required.map(course => courseKey(course.subject, course.number)));
    const extra = [...byKey.keys()].filter(key => !requiredKeys.has(key));
    if (extra.length) throw new PlanError(400, `${extra.join(", ")} is not an included course in this plan.`);

    // CRNs belong to their course, and a CRN is used once.
    const allCrns = [...byKey.values()].flatMap(pick => pick.crns);
    if (new Set(allCrns).size !== allCrns.length) throw new PlanError(400, "A CRN appears in more than one pick.");
    const known = sectionsByCrn(store, plan.term, allCrns);
    for (const pick of byKey.values()) {
      for (const crn of pick.crns) {
        const section = known.get(crn);
        if (!section || section.subject !== pick.subject || section.number !== pick.number) {
          throw new PlanError(400, `CRN ${crn} is not a section of ${pick.subject} ${pick.number}.`);
        }
      }
    }

    // Conflict-free against each other, breaks, and fixed blocks.
    const pickSections = new Map([...byKey].map(([key, pick]) => [key, pick.crns.map(crn => ({ ...known.get(crn)!, seats: null }))]));
    const fixedSections = this.fixedSections(plan.term, fixed);
    const entries = [...pickSections.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [key, list] = entries[i]!;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          if (sectionsConflict(list[a]!, list[b]!)) throw new PlanError(400, `${key} has overlapping sections.`);
        }
      }
      if (list.some(section => breakHit(section, plan.breaks))) throw new PlanError(400, `${key} overlaps one of your breaks.`);
      const clash = planConflicts(list, fixedSections);
      if (clash.length) throw new PlanError(400, `${key} overlaps CRN ${clash.join(", ")} on your schedule.`);
      for (let j = i + 1; j < entries.length; j++) {
        const [otherKey, other] = entries[j]!;
        if (planConflicts(list, other).length) throw new PlanError(400, `${key} and ${otherKey} overlap.`);
      }
    }

    // Never rewrite a course in the middle of a registration or an approval.
    const wantedByKey = new Map(store.listWanted(plan.term).map(course => [courseKey(course.subject, course.number), course]));
    const previous = store.listWanted(plan.term).filter(course => course.planId === plan.id);
    for (const key of [...byKey.keys(), ...previous.map(course => courseKey(course.subject, course.number))]) {
      const wanted = wantedByKey.get(key);
      if (wanted?.bundles.some(bundle => bundle.state === "registering" || bundle.state === "pending_approval")) {
        throw new PlanError(409, `${key} is registering or waiting for approval. Try again after it settles.`);
      }
    }

    // Backups need every option of each course. Loaded from the catalog without a seat refresh.
    const loaded = await this.loadCourses({ ...plan, courses: required }, new Set(), { seats: false });
    const sched = new Map<string, SchedSection>();
    for (const entry of loaded) for (const section of entry.detail?.sections ?? []) sched.set(section.crn, section);
    const backups = new Map<string, string[][]>();
    const bundleKey = (crns: string[]) => [...crns].sort().join(",");
    for (const entry of loaded) {
      const key = courseKey(entry.course.subject, entry.course.number);
      const pick = byKey.get(key)!;
      // A pick must be one complete bundle of the course (every required linked section), not loose CRNs.
      if (!entry.options.some(option => bundleKey(option) === bundleKey(pick.crns))) {
        throw new PlanError(400, `${key} needs one complete section combination. Generate again and pick a schedule.`);
      }
      if (!entry.course.backups || entry.course.locked) {
        backups.set(key, []);
        continue;
      }
      const others = entries.filter(([otherKey]) => otherKey !== key).flatMap(([, list]) => list);
      backups.set(
        key,
        backupBundles({ options: entry.options, chosen: pick.crns, others, fixed: fixedSections, breaks: plan.breaks, sections: sched }),
      );
    }

    const titles = new Map(required.map(course => [courseKey(course.subject, course.number), course.title]));
    const at = this.now();
    store.tx(() => {
      // Re-check inside the transaction: the orchestrator may have started on a course while details loaded.
      const fresh = store.listWanted(plan.term);
      for (const course of fresh) {
        const key = courseKey(course.subject, course.number);
        if (!byKey.has(key) && course.planId !== plan.id) continue;
        if (course.bundles.some(bundle => bundle.state === "registering" || bundle.state === "pending_approval")) {
          throw new PlanError(409, `${key} is registering or waiting for approval. Try again after it settles.`);
        }
      }
      const freshByKey = new Map(fresh.map(course => [courseKey(course.subject, course.number), course]));
      for (const [key, pick] of byKey) {
        let wanted = freshByKey.get(key);
        if (!wanted) {
          wanted = store.createWanted({ term: plan.term, subject: pick.subject, number: pick.number, title: titles.get(key) ?? "", kind: "bundles" });
        }
        store.setBundles(wanted.id, [{ crns: pick.crns }, ...(backups.get(key) ?? []).map(crns => ({ crns, generated: true }))]);
        store.updateWanted(wanted.id, { kind: "bundles", armed: true, ...(wanted.state === "blocked" ? { state: "watching" as const } : {}) });
        store.setWantedPlan(wanted.id, plan.id);
      }
      for (const course of previous) {
        if (byKey.has(courseKey(course.subject, course.number))) continue;
        store.updateWanted(course.id, { armed: false });
      }
      store.updatePlan(plan.id, { target: { at, picks: [...byKey.values()] } });
    });

    const crns = [...byKey.values()].flatMap(pick => pick.crns);
    const backupCount = [...backups.values()].reduce((sum, list) => sum + list.length, 0);
    events.emit({
      kind: "control",
      severity: "info",
      title: `Targeted ${plan.name}`,
      detail: `${[...byKey.values()].map(pick => `${pick.subject} ${pick.number} ${pick.crns.join(" + ")}`).join(", ")}. ${backupCount} backup ${
        backupCount === 1 ? "bundle" : "bundles"
      }. Armed.`,
      crns,
      payload: { planId: plan.id, picks: [...byKey.values()] },
    });

    // The whole watchlist for the term (the client replaces its list with it).
    return { plan: store.getPlan(plan.id)!, wanted: store.listWanted(plan.term) };
  }
}
