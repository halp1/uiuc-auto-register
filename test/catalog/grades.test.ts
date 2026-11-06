import { describe, expect, test } from "bun:test";
import { GradeSync, getCourseGrades, parseGradeData, replaceGrades } from "../../src/catalog/grades";
import { Store } from "../../src/core/db";
import { bundleGpa, instructorGrades, instructorKey } from "../../src/core/grades";
import type { Meeting } from "../../src/core/types";

const sample = async () => JSON.parse(await Bun.file(new URL("../fixtures/grades-sample.json", import.meta.url)).text());

const section = (...instructors: string[]): { meetings: Pick<Meeting, "instructors">[] } => ({ meetings: [{ instructors }] });

describe("grade data", () => {
  test("parses real data, skips malformed rows, and reads back by course", async () => {
    const courses = parseGradeData(await sample());
    expect(courses.map(c => `${c.subject} ${c.number}`)).toEqual(["AAS 100", "CS 225", "CS 374", "MATH 241", "XYZ 101"]);
    const cs225 = courses.find(c => c.number === "225")!;
    expect(cs225.overall).toMatchObject({ name: "All Sections", key: "", sigma: null, students: 8731 });
    expect(cs225.instructors.map(i => i.key)).toEqual(["kindratenko|v", "solomon|b", "evans|g", "koe|k"]);
    expect(cs225.instructors[3]!.sigma).toBeCloseTo(-0.45, 2);
    expect(courses.find(c => c.subject === "XYZ")!.instructors).toEqual([]);

    const store = new Store(":memory:");
    replaceGrades(store, courses, 1234);
    const grades = getCourseGrades(store, "cs", "225")!;
    expect(grades.overall.avg).toBeCloseTo(3.46, 2);
    expect(grades.instructors.map(i => i.name)).toEqual(["Kindratenko, V.", "Solomon, B.", "Evans, G.", "Koe, K."]);
    expect(grades.fetchedAt).toBe(1234);
    expect(getCourseGrades(store, "CS", "999")).toBeNull();
  });

  test.each([[{}], [[]], [[{ course: "CS 225", instructors: [{ instructor: "Evans, G." }] }]]])("rejects unusable data %#", raw => {
    expect(() => parseGradeData(raw)).toThrow();
  });

  test.each([
    ["Erickson, J", "Erickson, J."],
    [" Solomon, B", "Solomon, B."],
    ["Klajbor-Goderic, S", "Klajbor-Goderic, S."],
    ["Muñoz, A", "Munoz, A."],
    ["Fagen-Ulmschneider, Wade", "Fagen-Ulmschneider, W."],
  ])("explorer name %p matches grade name %p", (explorer, grade) => {
    expect(instructorKey(explorer)).toBe(instructorKey(grade));
    expect(instructorKey(explorer)).not.toBe("");
  });

  test("bundle GPA weights matched instructors by students and falls back to the course", async () => {
    const store = new Store(":memory:");
    replaceGrades(store, parseGradeData(await sample()), 1);
    const grades = getCourseGrades(store, "CS", "225")!;
    const solomon = grades.instructors.find(i => i.key === "solomon|b")!;
    const evans = grades.instructors.find(i => i.key === "evans|g")!;
    // Erickson has no CS 225 data, so only Solomon counts from the lecture. TA labs list nobody.
    expect(instructorGrades(grades, ["Erickson, J", " Solomon, B"]).map(i => i.key)).toEqual(["solomon|b"]);
    expect(bundleGpa(grades, [section("Erickson, J", " Solomon, B"), section()])).toEqual({ gpa: solomon.avg, source: "instructor" });
    const mixed = bundleGpa(grades, [section("Solomon, B"), section("Evans, G")])!;
    expect(mixed.gpa).toBeCloseTo((solomon.avg * solomon.students + evans.avg * evans.students) / (solomon.students + evans.students), 6);
    expect(bundleGpa(grades, [section("Nobody, X")])).toEqual({ gpa: grades.overall.avg, source: "course" });
    expect(bundleGpa(null, [section("Solomon, B")])).toBeNull();
  });

  test("a failed refresh keeps the old data", async () => {
    const store = new Store(":memory:");
    const raw = await sample();
    let ok = true;
    const sync = new GradeSync({
      store,
      now: () => 10,
      fetch: async () => (ok ? new Response(JSON.stringify(raw)) : new Response("<html>oops</html>", { status: 200 })),
    });
    expect((await sync.sync()).courses).toBe(5);
    ok = false;
    await expect(sync.sync({ force: true })).rejects.toThrow();
    expect(getCourseGrades(store, "MATH", "241")?.instructors.length).toBeGreaterThan(10);
  });
});
