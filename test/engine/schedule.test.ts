import { describe, expect, test } from "bun:test";
import { parseCourseDetail } from "../../src/catalog/explorer";
import type { CourseDetail, Meeting, PlanBreak, PlanSchedule } from "../../src/core/types";
import {
  backupBundles,
  breakHit,
  compareSchedules,
  courseOptions,
  generateSchedules,
  partsOverlap,
  planConflicts,
  scheduleStats,
  sectionsConflict,
  type SchedSection,
} from "../../src/engine/schedule";

const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();

function meeting(days: string, start: string | null, end: string | null): Meeting {
  return { type: "LEC", typeName: "Lecture", days, start, end, building: null, room: null, instructors: [] };
}

function sec(crn: string, meetings: Meeting[], partOfTerm: string | null = "1", available?: number): SchedSection {
  return { crn, meetings, partOfTerm, seats: available === undefined ? null : { available } };
}

const map = (...sections: SchedSection[]) => new Map(sections.map(section => [section.crn, section]));

describe("conflicts", () => {
  test("part of term: full term overlaps everything, halves only themselves", () => {
    expect(partsOverlap("1", "A")).toBe(true);
    expect(partsOverlap(null, "B")).toBe(true);
    expect(partsOverlap("A", "A")).toBe(true);
    expect(partsOverlap("A", "B")).toBe(false);
  });

  test("same time in different halves of the term does not conflict", () => {
    const a = sec("10001", [meeting("MW", "09:00", "09:50")], "A");
    const b = sec("10002", [meeting("W", "09:30", "10:20")], "B");
    const full = sec("10003", [meeting("W", "09:30", "10:20")], "1");
    expect(sectionsConflict(a, b)).toBe(false);
    expect(sectionsConflict(a, full)).toBe(true);
    expect(sectionsConflict(a, { ...b, partOfTerm: "A" })).toBe(true);
  });

  test("untimed meetings never conflict, touching edges do not overlap", () => {
    const online = sec("10001", [meeting("", null, null)]);
    const lecture = sec("10002", [meeting("MWF", "09:00", "09:50")]);
    const next = sec("10003", [meeting("M", "09:50", "10:40")]);
    expect(sectionsConflict(online, lecture)).toBe(false);
    expect(sectionsConflict(lecture, next)).toBe(false);
  });

  test("breakHit and planConflicts", () => {
    const lunch: PlanBreak[] = [{ days: ["M", "W"], start: "12:00", end: "13:00" }];
    expect(breakHit(sec("1", [meeting("MWF", "12:30", "13:20")]), lunch)).toBe(true);
    expect(breakHit(sec("1", [meeting("TR", "12:30", "13:20")]), lunch)).toBe(false);
    expect(breakHit(sec("1", [meeting("", null, null)]), lunch)).toBe(false);
    const bundle = [sec("1", [meeting("TR", "09:00", "10:15")])];
    const others = [sec("2", [meeting("R", "10:00", "10:50")]), sec("3", [meeting("T", "10:15", "11:00")])];
    expect(planConflicts(bundle, others)).toEqual(["2"]);
  });
});

describe("stats and sorting", () => {
  test("days, span, gaps, seats", () => {
    const stats = scheduleStats([
      sec("1", [meeting("MW", "09:00", "09:50")], "1", 5),
      sec("2", [meeting("M", "11:00", "11:50")], "1", 0),
      sec("3", [meeting("", null, null)], "1", 2),
      sec("4", [meeting("F", "13:00", "14:15")]),
    ]);
    expect(stats).toEqual({ days: 3, start: "09:00", end: "14:15", gapMin: 70, closed: 1, minSeats: 0 });
  });

  test("overlapping meetings on one day do not create negative gaps", () => {
    expect(scheduleStats([sec("1", [meeting("M", "09:00", "11:00")]), sec("2", [meeting("M", "10:00", "10:30")])]).gapMin).toBe(0);
  });

  test("sort orders", () => {
    const make = (key: string, stats: Partial<PlanSchedule["stats"]>): PlanSchedule => ({
      key,
      picks: [],
      stats: { days: 3, start: "09:00", end: "15:00", gapMin: 60, closed: 0, minSeats: 5, ...stats },
    });
    const list = [
      make("a", { closed: 1, minSeats: 0, days: 2, start: "11:00", end: "13:00", gapMin: 0 }),
      make("b", { closed: 0, minSeats: 2, days: 4, start: "08:00", end: "17:00", gapMin: 120 }),
      make("c", { closed: 0, minSeats: 9, days: 3, start: "10:00", end: "14:00", gapMin: 30 }),
      make("d", { closed: 0, minSeats: null, days: 3, start: "10:00", end: "14:00", gapMin: 10 }),
    ];
    const order = (sort: Parameters<typeof compareSchedules>[0]) => [...list].sort(compareSchedules(sort)).map(s => s.key);
    expect(order("open")).toEqual(["c", "b", "d", "a"]);
    expect(order("days")).toEqual(["a", "d", "c", "b"]);
    expect(order("start")).toEqual(["a", "d", "c", "b"]);
    expect(order("end")).toEqual(["a", "d", "c", "b"]);
    expect(order("gaps")).toEqual(["a", "d", "c", "b"]);
  });
});

async function cs225(): Promise<CourseDetail> {
  const parsed = parseCourseDetail(await fixture("explorer-cs225-detail.xml"), "120271")!;
  const linked = [["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]];
  return {
    ...parsed,
    sectionCount: parsed.sections.length,
    sections: parsed.sections.map(section => ({ ...section, seats: null })),
    linkedOptions: { "59777": linked, "31208": linked },
  };
}

describe("courseOptions", () => {
  test("all combinations, minus excluded CRNs, or exactly the locked bundle", async () => {
    const course = await cs225();
    expect(courseOptions(course).length).toBe(14);
    const withoutAl1 = courseOptions(course, { excludedCrns: ["31208", "31234"] });
    expect(withoutAl1.length).toBe(6);
    expect(withoutAl1.every(bundle => !bundle.includes("31208") && !bundle.includes("31234"))).toBe(true);
    expect(courseOptions(course, { locked: ["59777", "31222"] })).toEqual([["59777", "31222"]]);
    expect(courseOptions(course, { locked: ["59777", "99999"] })).toEqual([]);
  });
});

describe("generateSchedules", () => {
  const A1 = sec("11111", [meeting("MWF", "09:00", "09:50")], "1", 3);
  const A2 = sec("11112", [meeting("MWF", "10:00", "10:50")], "1", 0);
  const B1 = sec("22221", [meeting("MWF", "09:30", "10:20")], "1", 8);
  const B2 = sec("22222", [meeting("TR", "09:00", "10:15")], "1", 1);
  const C1 = sec("33331", [meeting("", null, null)]);
  const sections = map(A1, A2, B1, B2, C1);
  const courses = [
    { subject: "AAA", number: "100", options: [["11111"], ["11112"]] },
    { subject: "BBB", number: "200", options: [["22221"], ["22222"]] },
    { subject: "CCC", number: "300", options: [["33331"]] },
  ];

  test("only conflict-free combinations, picks in course order, sorted by open", () => {
    const out = generateSchedules({ courses, sections, fixed: [], breaks: [] });
    // B1 conflicts with A1 and A2 -> only B2 works with each A.
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.viable).toEqual([2, 2, 1]);
    expect(out.schedules.map(s => s.key)).toEqual(["11111,22222,33331", "11112,22222,33331"]);
    expect(out.schedules[0]!.picks.map(p => `${p.subject} ${p.crns.join("+")}`)).toEqual(["AAA 11111", "BBB 22222", "CCC 33331"]);
    expect(out.schedules[1]!.stats.closed).toBe(1);
  });

  test("openOnly keeps only schedules whose every section is known open", () => {
    // C1 has no seat reading yet: nothing passes.
    expect(generateSchedules({ courses, sections, fixed: [], breaks: [], openOnly: true }).total).toBe(0);
    const known = new Map(sections);
    known.set("33331", { ...C1, seats: { available: 4 } });
    const out = generateSchedules({ courses, sections: known, fixed: [], breaks: [], openOnly: true });
    expect(out.schedules.map(s => s.key)).toEqual(["11111,22222,33331"]);
    expect(out.total).toBe(1);
  });

  test("fixed blocks and breaks prune options", () => {
    const fixed = [sec("44444", [meeting("TR", "10:00", "10:50")])];
    const blocked = generateSchedules({ courses, sections, fixed, breaks: [] });
    expect(blocked.viable).toEqual([2, 1, 1]);
    expect(blocked.total).toBe(0);
    const breaks: PlanBreak[] = [{ days: ["M"], start: "10:00", end: "11:00" }];
    const out = generateSchedules({ courses, sections, fixed: [], breaks });
    expect(out.viable).toEqual([1, 1, 1]);
    expect(out.schedules.map(s => s.key)).toEqual(["11111,22222,33331"]);
  });

  test("a course with no options yields nothing", () => {
    const out = generateSchedules({ courses: [...courses, { subject: "DDD", number: "400", options: [] }], sections, fixed: [], breaks: [] });
    expect(out).toMatchObject({ total: 0, schedules: [], viable: [2, 2, 1, 0] });
  });

  test("caps at maxSchedules and slices to limit", () => {
    const many = Array.from({ length: 4 }, (_, c) => ({
      subject: `S${c}`,
      number: "100",
      options: Array.from({ length: 10 }, (_, o) => [`${c}${String(o).padStart(4, "0")}`]),
    }));
    const out = generateSchedules({ courses: many, sections: new Map(), fixed: [], breaks: [], maxSchedules: 500, limit: 50 });
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(500);
    expect(out.schedules.length).toBe(50);
  });

  test("stops at the time budget using the injected clock", () => {
    let t = 0;
    const many = Array.from({ length: 6 }, (_, c) => ({
      subject: `S${c}`,
      number: "100",
      options: Array.from({ length: 10 }, (_, o) => [`${c}${String(o).padStart(4, "0")}`]),
    }));
    const out = generateSchedules({ courses: many, sections: new Map(), fixed: [], breaks: [], now: () => (t += 1000), budgetMs: 1500 });
    expect(out.truncated).toBe(true);
    expect(out.total).toBeGreaterThan(0);
    expect(out.total).toBeLessThan(5000);
  });

  test("CS 225 real data: lecture plus lab, with a morning break", async () => {
    const course = await cs225();
    const out = generateSchedules({
      courses: [{ subject: "CS", number: "225", options: courseOptions(course) }],
      sections: new Map(course.sections.map(section => [section.crn, section])),
      fixed: [],
      breaks: [{ days: ["R"], start: "08:00", end: "12:00" }],
    });
    // AYA 09:00, AYC/AYD 11:00 are out. 4 labs remain for 2 lectures.
    expect(out.total).toBe(8);
  });
});

describe("backupBundles", () => {
  test("other options that fit, most seats first, capped", () => {
    const sections = map(
      sec("11111", [meeting("MWF", "09:00", "09:50")], "1", 1),
      sec("11112", [meeting("MWF", "10:00", "10:50")], "1", 9),
      sec("11113", [meeting("MWF", "11:00", "11:50")], "1", 4),
      sec("11114", [meeting("MWF", "12:00", "12:50")]),
      sec("11115", [meeting("MWF", "13:00", "13:50")], "1", 50),
    );
    const others = [sec("22222", [meeting("M", "11:30", "12:20")])];
    const out = backupBundles({
      options: [["11111"], ["11112"], ["11113"], ["11114"], ["11115"]],
      chosen: ["11111"],
      others,
      fixed: [],
      breaks: [{ days: ["W"], start: "13:00", end: "14:00" }],
      sections,
    });
    expect(out).toEqual([["11112"]]);
    const capped = backupBundles({
      options: [["11111"], ["11112"], ["11113"], ["11114"], ["11115"]],
      chosen: ["11111"],
      others: [],
      fixed: [],
      breaks: [],
      sections,
      cap: 3,
    });
    expect(capped).toEqual([["11115"], ["11112"], ["11113"]]);
  });
});
