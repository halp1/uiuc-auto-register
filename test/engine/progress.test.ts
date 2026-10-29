import { beforeEach, describe, expect, test } from "bun:test";
import { getStoredCourse } from "../../src/catalog/store";
import { Store } from "../../src/core/db";
import { parseCredits, scheduleProgress } from "../../src/engine/progress";
import { TERM, seedCatalog } from "../fixtures/catalog";

let store: Store;

beforeEach(async () => {
  store = new Store(":memory:");
  await seedCatalog(store);
});

const want = (subject: string, number: string, opts: { armed?: boolean; state?: "registered" | "blocked" } = {}) => {
  const w = store.createWanted({ term: TERM, subject, number, title: "", kind: "bundles" });
  store.setBundles(w.id, [{ crns: ["11111"] }]);
  store.updateWanted(w.id, { armed: opts.armed ?? true, ...(opts.state ? { state: opts.state } : {}) });
  return w;
};

test.each([
  ["3 hours", 3, false],
  ["1 TO 4 hours", 1, true],
  ["3 OR 4 hours", 3, true],
  ["", null, false],
  [null, null, false],
])("parseCredits(%p)", (raw, credits, variable) => {
  expect(parseCredits(raw)).toEqual({ credits, variable });
});

describe("scheduleProgress", () => {
  test("nothing wanted gives null", () => {
    expect(scheduleProgress(store, TERM)).toBeNull();
  });

  test("watchlist goal: armed and registered courses, unarmed ones left out", () => {
    want("CS", "225");
    want("MATH", "241", { state: "registered" });
    want("CS", "374", { armed: false });
    expect(scheduleProgress(store, TERM)!.creditsKnown).toBe(true);
    // A course missing from the catalog makes the credit total unknown.
    want("ZZZ", "999");
    const p = scheduleProgress(store, TERM)!;
    expect(p.source).toBe("watchlist");
    expect(p.courses.map(c => `${c.subject} ${c.number} ${c.state}`)).toEqual(["CS 225 watching", "MATH 241 registered", "ZZZ 999 watching"]);
    expect(p).toMatchObject({ registeredCourses: 1, totalCourses: 3, creditsKnown: false });
    expect(p.courses[2]!.credits).toBeNull();
    const cs = Number(getStoredCourse(store, TERM, "CS", "225")!.creditHours!.match(/\d+/)![0]);
    const math = Number(getStoredCourse(store, TERM, "MATH", "241")!.creditHours!.match(/\d+/)![0]);
    expect(p.totalCredits).toBe(cs + math);
    expect(p.registeredCredits).toBe(math);
  });

  test("a targeted plan is the goal, and a class registered by hand counts from the schedule snapshot", () => {
    const plan = store.listPlans(TERM)[0]!;
    store.addPlanCourse(plan.id, { subject: "CS", number: "225", title: "" });
    store.addPlanCourse(plan.id, { subject: "CS", number: "374", title: "" });
    store.updatePlan(plan.id, {
      target: {
        at: 1,
        picks: [
          { subject: "CS", number: "225", crns: ["59777", "31225"] },
          { subject: "CS", number: "374", crns: ["65088", "65089"] },
        ],
      },
    });
    want("CS", "225", { armed: true });
    want("CS", "374", { armed: false });
    // Not on the watchlist goal (unarmed), but on Banner's schedule.
    store.addScheduleSnapshot(TERM, ["65088", "65089"], "rehearsal");
    const p = scheduleProgress(store, TERM)!;
    expect(p.source).toBe("plan");
    expect(p.planName).toBe("Plan 1");
    expect(p.courses.find(c => c.number === "374")!.state).toBe("registered");
    expect(p.courses.find(c => c.number === "225")!.state).toBe("watching");
    expect(p.registeredCourses).toBe(1);
    expect(p.scheduleCheckedAt).not.toBeNull();
  });

});
