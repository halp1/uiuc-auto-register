import { beforeEach, describe, expect, test } from "bun:test";
import { courseDetail } from "../../src/catalog/search";
import { Bus } from "../../src/core/bus";
import { Store } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { PlanPick } from "../../src/core/types";
import { PlanError, PlanService, SEAT_FRESH_MS } from "../../src/engine/plans";
import { TERM, seedCatalog } from "../fixtures/catalog";

let store: Store;
let service: PlanService;
let activeTerm: string | null;
let detailCalls: { subject: string; seats: boolean }[];
let now: number;

beforeEach(async () => {
  store = new Store(":memory:");
  now = Date.UTC(2026, 10, 2, 15);
  await seedCatalog(store, now);
  activeTerm = TERM;
  detailCalls = [];
  service = new PlanService({
    store,
    events: new Events(store, new Bus()),
    activeTerm: () => activeTerm,
    now: () => now,
    // Store-only: no explorer, no Banner. Seats are whatever the test stored.
    loadDetail: async (term, subject, number, opts) => {
      detailCalls.push({ subject: `${subject} ${number}`, seats: opts.seats });
      return courseDetail(store, term, subject, number);
    },
  });
});

function planWith(...courses: [string, string][]) {
  const plan = store.listPlans(TERM)[0]!;
  for (const [subject, number] of courses) store.addPlanCourse(plan.id, { subject, number, title: `${subject} ${number}` });
  return store.getPlan(plan.id)!;
}

const seat = (crn: string, available: number, checkedAt = now) =>
  store.upsertSeat({ term: TERM, crn, available, max: 30, enrolled: 30 - available, checkedAt });

describe("store", () => {
  test("Plan 1 is created on first list, deleting a plan unlinks wanted courses", () => {
    const plans = store.listPlans(TERM);
    expect(plans.map(p => p.name)).toEqual(["Plan 1"]);
    expect(store.listPlans(TERM).length).toBe(1);
    const wanted = store.createWanted({ term: TERM, subject: "CS", number: "225", title: "", kind: "bundles" });
    store.setWantedPlan(wanted.id, plans[0]!.id);
    expect(store.getWanted(wanted.id)!.planId).toBe(plans[0]!.id);
    store.deletePlan(plans[0]!.id);
    expect(store.getWanted(wanted.id)!.planId).toBeNull();
  });

  test("plan courses: unique per plan (case-insensitive), cascade on delete", () => {
    const plan = planWith(["CS", "225"]);
    expect(() => store.addPlanCourse(plan.id, { subject: "cs", number: "225", title: "" })).toThrow();
    store.deletePlan(plan.id);
    expect(store.db.query("SELECT COUNT(*) AS n FROM plan_courses").get()).toEqual({ n: 0 });
  });
});

describe("generate", () => {
  test("combines courses with real sections and reports per-course options", async () => {
    const plan = planWith(["CS", "225"], ["CS", "374"], ["MATH", "241"]);
    const result = await service.generate(plan.id);
    expect(result.courses.map(c => [c.subject, c.number, c.status])).toEqual([
      ["CS", "225", "ok"],
      ["CS", "374", "ok"],
      ["MATH", "241", "ok"],
    ]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.schedules.length).toBe(Math.min(200, result.total));
    const first = result.schedules[0]!;
    expect(first.picks.map(p => `${p.subject} ${p.number}`)).toEqual(["CS 225", "CS 374", "MATH 241"]);
    for (const crn of first.key.split(",")) expect(result.sections[crn]).toBeDefined();
    expect(result.sections["59777"]).toMatchObject({ subject: "CS", number: "225", section: "AL2" });
    // MWF 11:00 lectures conflict with each other: CS 225 lectures never pair with MATH 241 AL2 (46067) or CL1 (46075).
    for (const schedule of result.schedules) {
      const math = schedule.picks[2]!.crns[0];
      expect(["46067", "46075"]).not.toContain(math);
    }
  });

  test("excluded, locked, and not offered courses", async () => {
    const plan = planWith(["CS", "225"], ["CS", "374"], ["CS", "999"]);
    const [cs225, cs374] = plan.courses;
    store.updatePlanCourse(plan.id, cs225!.id, { locked: ["59777", "31225"] });
    store.updatePlanCourse(plan.id, cs374!.id, { included: false });
    const result = await service.generate(plan.id);
    expect(result.courses).toEqual([
      { subject: "CS", number: "225", options: 1, status: "ok" },
      { subject: "CS", number: "374", options: 0, status: "excluded" },
      { subject: "CS", number: "999", options: 0, status: "not_offered" },
    ]);
    // A not-offered included course just drops out; the rest still schedules.
    expect(result.schedules.map(s => s.key)).toEqual(["31225,59777"]);
  });

  test("registered courses are skipped and their CRNs become fixed blocks", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    store.addScheduleSnapshot(TERM, ["59777", "31225"], "rehearsal");
    const result = await service.generate(plan.id);
    expect(result.courses[0]).toMatchObject({ subject: "CS", number: "225", status: "registered" });
    expect(result.fixed).toEqual([
      { crn: "31225", subject: "CS", number: "225" },
      { crn: "59777", subject: "CS", number: "225" },
    ]);
    // MATH 241 lectures at MWF 11:00 clash with the fixed CS 225 lecture.
    const lectures = new Set(result.schedules.map(s => s.picks[0]!.crns[0]));
    expect(lectures.has("46067")).toBe(false);
    expect(lectures.has("46060")).toBe(true);
    // Ignoring registered classes brings CS 225 back.
    store.updatePlan(plan.id, { ignoreRegistered: true });
    const ignored = await service.generate(plan.id);
    expect(ignored.fixed).toEqual([]);
    expect(ignored.courses[0]!.status).toBe("ok");
  });

  test("breaks remove options and can leave a course with none", async () => {
    const plan = planWith(["CS", "225"]);
    store.updatePlan(plan.id, { breaks: [{ days: ["R"], start: "08:00", end: "18:00" }] });
    const result = await service.generate(plan.id);
    expect(result.courses[0]).toMatchObject({ status: "no_options", options: 0 });
    expect(result.schedules).toEqual([]);
  });

  test("openOnly and stats use stored seats", async () => {
    const plan = planWith(["CS", "225"]);
    seat("59777", 3);
    seat("31225", 0);
    seat("31234", 5);
    store.updatePlan(plan.id, { openOnly: true });
    const result = await service.generate(plan.id);
    expect(result.schedules.map(s => s.key)).toEqual(["31234,59777"]);
    expect(result.schedules[0]!.stats).toMatchObject({ closed: 0, minSeats: 3 });
  });

  test("skips the seat refresh when every section was checked in the last 10 minutes", async () => {
    const plan = planWith(["CS", "225"]);
    for (const crn of ["31208", "59777", "31234", "31222", "31225", "31227", "31229", "31231", "59778"]) seat(crn, 1);
    await service.generate(plan.id);
    expect(detailCalls).toEqual([{ subject: "CS 225", seats: false }]);
    now += SEAT_FRESH_MS + 1;
    await service.generate(plan.id);
    expect(detailCalls[1]).toEqual({ subject: "CS 225", seats: true });
  });
});

describe("target", () => {
  const picks = (): PlanPick[] => [
    { subject: "CS", number: "225", crns: ["59777", "31225"] },
    { subject: "MATH", number: "241", crns: ["46060", "46053"] },
  ];

  test("creates armed wanted courses with the pick first and fitting backups after", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    const result = await service.target(plan.id, picks());
    expect(result.wanted.map(w => `${w.subject} ${w.number}`)).toEqual(["CS 225", "MATH 241"]);
    for (const wanted of result.wanted) {
      expect(wanted).toMatchObject({ armed: true, kind: "bundles", planId: plan.id, state: "watching" });
      expect(wanted.bundles[0]!.generated).toBe(false);
      expect(wanted.bundles.slice(1).every(b => b.generated)).toBe(true);
    }
    const cs = result.wanted[0]!;
    expect(cs.bundles[0]!.crns).toEqual(["59777", "31225"]);
    expect(cs.bundles.length).toBeGreaterThan(1);
    expect(cs.bundles.length).toBeLessThanOrEqual(21);
    // MATH 241 backups never use lectures at MWF 11:00 (they clash with the CS 225 pick).
    const math = result.wanted[1]!;
    expect(math.bundles.some(b => b.crns.includes("46067") || b.crns.includes("46075"))).toBe(false);
    expect(result.plan.target?.picks).toEqual(picks());
    expect(store.listEvents().find(e => e.kind === "control")!.payload).toMatchObject({ planId: plan.id, picks: picks() });
  });

  test("backups off or locked gives exactly one bundle", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    store.updatePlanCourse(plan.id, plan.courses[0]!.id, { backups: false });
    store.updatePlanCourse(plan.id, plan.courses[1]!.id, { locked: ["46060", "46053"] });
    const result = await service.target(plan.id, picks());
    expect(result.wanted.map(w => w.bundles.length)).toEqual([1, 1]);
  });

  test("reuses existing wanted courses and disarms ones dropped from the plan target", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    const existing = store.createWanted({ term: TERM, subject: "CS", number: "225", title: "Data Structures", kind: "any" });
    await service.target(plan.id, picks());
    expect(store.listWanted(TERM).filter(w => w.subject === "CS").length).toBe(1);
    expect(store.getWanted(existing.id)!.kind).toBe("bundles");
    store.updatePlanCourse(plan.id, plan.courses[1]!.id, { included: false });
    await service.target(plan.id, [picks()[0]!]);
    const math = store.listWanted(TERM).find(w => w.subject === "MATH")!;
    expect(math.armed).toBe(false);
    expect(math.bundles.length).toBeGreaterThan(0);
  });

  // Each case trips a different rule. The fragment is the course or CRN the rule names, so the right rule is proven to fire.
  const math = (crns: string[]): PlanPick => ({ subject: "MATH", number: "241", crns });
  const cs = (crns: string[]): PlanPick => ({ subject: "CS", number: "225", crns });
  test.each<[string, () => PlanPick[], number, string | RegExp, ((planId: number) => void) | null]>([
    ["missing pick", () => [picks()[0]!], 400, "MATH 241", null],
    ["pick for a course not in the plan", () => [...picks(), { subject: "CS", number: "374", crns: ["65088"] }], 400, "CS 374", null],
    ["CRN from another course", () => [picks()[0]!, math(["46060", "31234"])], 400, "31234", null],
    ["picks overlap each other", () => [picks()[0]!, math(["46067", "46057"])], 400, /CS 225.*MATH 241/, null],
    ["course picked twice", () => [cs(["59777", "31225"]), cs(["31208"])], 400, "CS 225", null],
    ["lecture without its linked section", () => [cs(["59777"]), picks()[1]!], 400, "CS 225", null],
    [
      "pick overlaps a break",
      picks,
      400,
      "MATH 241",
      planId => store.updatePlan(planId, { breaks: [{ days: ["T"], start: "15:00", end: "16:00" }] }),
    ],
    [
      "pick overlaps a CRN on the schedule",
      () => [picks()[0]!, math(["55921", "46070"])],
      400,
      "65090",
      () => store.addScheduleSnapshot(TERM, ["65090"], "rehearsal"), // CS 374 AYB, WF 12:00
    ],
    ["plan term is not the active term", picks, 409, /./, () => (activeTerm = "120268")],
  ])("rejects without writing: %s", async (_name, pickList, status, fragment, arrange) => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    arrange?.(plan.id);
    const error = await service.target(plan.id, pickList()).catch(e => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error.status).toBe(status);
    expect(error.message).toMatch(fragment);
    expect(store.listWanted(TERM)).toEqual([]);
    expect(store.getPlan(plan.id)!.target).toBeNull();
  });

  test("409 while a course is registering or waiting for approval", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    const wanted = store.createWanted({ term: TERM, subject: "CS", number: "225", title: "", kind: "bundles" });
    const [bundle] = store.setBundles(wanted.id, [{ crns: ["31208", "31234"] }]);
    store.setBundleState(bundle!.id, "pending_approval");
    const error = await service.target(plan.id, picks()).catch(e => e);
    expect(error.status).toBe(409);
    expect(store.getWanted(wanted.id)!.bundles[0]!.crns).toEqual(["31208", "31234"]);
    expect(store.listWanted(TERM).length).toBe(1);
  });

  test("a registered plan course must not be picked", async () => {
    const plan = planWith(["CS", "225"], ["MATH", "241"]);
    store.addScheduleSnapshot(TERM, ["59777", "31225"], "rehearsal");
    const error = await service.target(plan.id, picks()).catch(e => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error.status).toBe(400);
    const ok = await service.target(plan.id, [picks()[1]!]);
    expect(ok.wanted.map(w => w.subject)).toEqual(["MATH"]);
  });
});
