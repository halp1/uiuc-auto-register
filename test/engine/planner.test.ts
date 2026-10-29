import { describe, expect, test } from "bun:test";
import { parseCourseDetail } from "../../src/catalog/explorer";
import type { AnyFilters, Bundle, CourseDetail, SeatInfo, Section } from "../../src/core/types";
import { expandAny, openBundles, sectionExcluded } from "../../src/engine/planner";

const T = "120271";
const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();
const none: AnyFilters = { excludeDays: [], excludeTimes: [], excludeInstructors: [] };

function bundle(id: number, rank: number, crns: string[], state: Bundle["state"] = "watching"): Bundle {
  return { id, courseId: 1, rank, crns, state, blockedReason: null, generated: false };
}

const lookup = (seats: Record<string, number>) => (crn: string) => (crn in seats ? { available: seats[crn]! } : null);

describe("openBundles", () => {
  const course = {
    bundles: [bundle(3, 2, ["c"]), bundle(1, 0, ["a", "x"]), bundle(2, 1, ["b", "x"]), bundle(4, 3, ["d"], "blocked")],
  };

  // Atomic: one closed or unknown CRN excludes the bundle. Blocked bundles are never returned.
  test.each([
    ["all open, rank order", { a: 1, b: 2, c: 1, x: 1, d: 5 }, [1, 2, 3]],
    ["shared CRN closed", { a: 1, b: 2, c: 0, x: 0 }, []],
    ["one CRN closed", { a: 0, b: 2, x: 1 }, [2]],
    ["missing seats count as closed", { b: 1 }, []],
    ["blocked bundle open", { d: 9 }, []],
  ])("%s", (_name, seats, ids) => {
    expect(openBundles(course, lookup(seats)).map(b => b.id)).toEqual(ids);
  });
});

async function cs225(): Promise<CourseDetail> {
  const parsed = parseCourseDetail(await fixture("explorer-cs225-detail.xml"), T)!;
  const linked = [["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]];
  return {
    ...parsed,
    sectionCount: parsed.sections.length,
    sections: parsed.sections.map(section => ({ ...section, seats: null })),
    linkedOptions: { "59777": linked, "31208": linked },
  };
}

function withSeats(course: CourseDetail, seats: Record<string, number>): CourseDetail {
  const seat = (crn: string): SeatInfo | null =>
    crn in seats ? { term: T, crn, available: seats[crn]!, max: 30, enrolled: 0, checkedAt: 0, changedAt: 0 } : null;
  return { ...course, sections: course.sections.map(section => ({ ...section, seats: seat(section.crn) })) };
}

describe("expandAny", () => {
  test("lecture x linked option, stable order without seats", async () => {
    const bundles = expandAny(await cs225(), none);
    expect(bundles.length).toBe(14);
    expect(bundles[0]).toEqual(["31208", "31225"]);
    expect(bundles.every(b => b.length === 2 && ["31208", "59777"].includes(b[0]!))).toBe(true);
  });

  // AYA (31234) is R 09:00-10:50, the other labs R 11:00-12:50, lectures MWF around 11:00-12:00.
  test.each<[string, Partial<AnyFilters>, number]>([
    ["excluded day removes every R lab", { excludeDays: ["R"] }, 0],
    ["excluded time drops the overlapping lab", { excludeTimes: [{ start: "08:00", end: "10:00" }] }, 12],
    ["touching time edges do not overlap", { excludeTimes: [{ start: "10:50", end: "11:00" }] }, 14],
    ["excluded lecture time removes everything", { excludeTimes: [{ start: "11:30", end: "12:00" }] }, 0],
    ["instructor match is a case-insensitive substring", { excludeInstructors: ["ERICK"] }, 0],
    ["non-matching instructor keeps everything", { excludeInstructors: ["nobody"] }, 14],
  ])("filters: %s", async (_name, filters, count) => {
    const bundles = expandAny(await cs225(), { ...none, ...filters });
    expect(bundles.length).toBe(count);
    if (count === 12) expect(bundles.some(b => b.includes("31234"))).toBe(false);
  });

  test("ranks by min open seats, desc", async () => {
    const course = withSeats(await cs225(), { "31208": 50, "59777": 2, "31222": 5, "31225": 1, "31234": 9 });
    const bundles = expandAny(course, none);
    expect(bundles[0]).toEqual(["31208", "31234"]);
    expect(bundles[1]).toEqual(["31208", "31222"]);
    expect(bundles[2]).toEqual(["59777", "31234"]);
  });

  test("no linked data: one section of each type, grouped by letter", async () => {
    const parsed = parseCourseDetail(await fixture("explorer-cs-374-detail.xml"), T)!;
    const course: CourseDetail = {
      ...parsed,
      sectionCount: parsed.sections.length,
      sections: parsed.sections.map(section => ({ ...section, seats: null })),
      linkedOptions: {},
    };
    const bundles = expandAny(course, none);
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      expect(b.length).toBe(2);
      const [lec, dis] = b.map(crn => course.sections.find(section => section.crn === crn)!);
      expect(lec!.type).toBe("LEC");
      expect(dis!.type).toBe("DIS");
    }
    // AL1 (65088) pairs with AY* discussions only.
    const al1 = bundles.filter(b => b[0] === "65088").map(b => course.sections.find(s => s.crn === b[1])!.section);
    expect(al1.every(section => section.startsWith("A"))).toBe(true);
  });

  test("single-type course without links: one bundle per section", () => {
    const section = (crn: string, days: string): Section => ({
      crn,
      section: crn,
      type: "LCD",
      typeName: "Lecture-Discussion",
      partOfTerm: "1",
      seats: null,
      meetings: [{ type: "LCD", typeName: "", days, start: "09:00", end: "09:50", building: null, room: null, instructors: [] }],
    });
    const course = { sections: [section("10001", "MW"), section("10002", "TR")], linkedOptions: {} };
    expect(expandAny(course, none)).toEqual([["10001"], ["10002"]]);
    expect(expandAny(course, { ...none, excludeDays: ["M"] })).toEqual([["10002"]]);
  });

  test("sectionExcluded ignores arranged meetings for time filters", () => {
    const arranged: Section["meetings"] = [
      { type: "OLC", typeName: "", days: "", start: null, end: null, building: null, room: null, instructors: [] },
    ];
    expect(sectionExcluded({ meetings: arranged }, { ...none, excludeTimes: [{ start: "00:00", end: "23:59" }] })).toBe(false);
  });

  test("lecture and lab in different halves of the term may share a time slot", () => {
    const section = (crn: string, type: string, sectionCode: string, partOfTerm: string): Section => ({
      crn,
      section: sectionCode,
      type,
      typeName: type,
      partOfTerm,
      seats: null,
      meetings: [{ type, typeName: "", days: "M", start: "09:00", end: "09:50", building: null, room: null, instructors: [] }],
    });
    const halves = { sections: [section("10001", "LEC", "A1", "A"), section("10002", "LAB", "AL", "B")], linkedOptions: {} };
    expect(expandAny(halves, none)).toEqual([["10001", "10002"]]);
    const same = { sections: [section("10001", "LEC", "A1", "A"), section("10002", "LAB", "AL", "A")], linkedOptions: {} };
    expect(expandAny(same, none)).toEqual([]);
  });
});
