// Progress toward the schedule the user wants for the active term. Pure reads of the local store.

import type { Store } from "../core/db";
import type { Plan, ScheduleProgress, WantedCourse } from "../core/types";
import { courseForCrn, getStoredCourse } from "../catalog/store";

/** Catalog credit hours ("3 hours", "1 TO 4 hours", "3 OR 4 hours") to the lowest value, plus whether it varies. */
export function parseCredits(raw: string | null | undefined): { credits: number | null; variable: boolean } {
  if (!raw) return { credits: null, variable: false };
  const values = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0])).filter(Number.isFinite);
  if (!values.length) return { credits: null, variable: false };
  return { credits: Math.min(...values), variable: values.length > 1 };
}

const key = (subject: string, number: string) => `${subject.toUpperCase()} ${number}`;

export function scheduleProgress(store: Store, term: string): ScheduleProgress | null {
  const wanted = store.listWanted(term);
  const byKey = new Map(wanted.map(w => [key(w.subject, w.number), w]));
  // Courses already on the Banner schedule (last read), so a course registered by hand still counts.
  const snapshot = store.latestSchedule(term);
  const onSchedule = new Set<string>();
  for (const crn of snapshot?.crns ?? []) {
    const owner = courseForCrn(store, term, crn);
    if (owner) onSchedule.add(key(owner.subject, owner.number));
  }

  // The targeted plan wins. Otherwise armed courses, plus anything already registered by the app.
  const plan: Plan | undefined = store
    .listPlans(term)
    .filter(p => p.target)
    .sort((a, b) => (b.target!.at ?? 0) - (a.target!.at ?? 0))[0];
  let goal: { subject: string; number: string }[];
  if (plan) {
    goal = plan.target!.picks.map(p => ({ subject: p.subject, number: p.number }));
    // Plan courses skipped at target time because they were already registered are still part of the goal.
    for (const c of plan.courses) {
      const k = key(c.subject, c.number);
      if (c.included && (onSchedule.has(k) || byKey.get(k)?.state === "registered") && !goal.some(g => key(g.subject, g.number) === k)) {
        goal.push({ subject: c.subject, number: c.number });
      }
    }
  } else {
    goal = wanted.filter(w => w.armed || w.state === "registered").map(w => ({ subject: w.subject, number: w.number }));
  }
  if (!goal.length) return null;

  const courses = goal.map(g => {
    const w: WantedCourse | undefined = byKey.get(key(g.subject, g.number));
    const registered = w?.state === "registered" || onSchedule.has(key(g.subject, g.number));
    const state: ScheduleProgress["courses"][number]["state"] = registered
      ? "registered"
      : w?.state === "blocked"
        ? "blocked"
        : w?.armed
          ? "watching"
          : "unarmed";
    const { credits, variable } = parseCredits(getStoredCourse(store, term, g.subject, g.number)?.creditHours);
    return { subject: g.subject.toUpperCase(), number: g.number, credits, variable, state };
  });
  const done = courses.filter(c => c.state === "registered");
  const sum = (list: typeof courses) => list.reduce((total, c) => total + (c.credits ?? 0), 0);
  return {
    term,
    source: plan ? "plan" : "watchlist",
    planId: plan?.id ?? null,
    planName: plan?.name ?? null,
    courses,
    registeredCourses: done.length,
    totalCourses: courses.length,
    registeredCredits: sum(done),
    totalCredits: sum(courses),
    creditsKnown: courses.every(c => c.credits !== null),
    scheduleCheckedAt: snapshot?.ts ?? null,
  };
}
