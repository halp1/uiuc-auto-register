import { beforeAll, describe, expect, test } from "bun:test";
import { Store } from "../../src/core/db";
import { Explorer, parseCascade, parseCourseDetail, parseSubjects, to24h } from "../../src/catalog/explorer";
import { courseDetail, search } from "../../src/catalog/search";
import { saveCourses } from "../../src/catalog/store";
import { CatalogSync, cleanTermDescription, parseTerms } from "../../src/catalog/sync";
import { LinkedSections } from "../../src/banner/linked";

const T = "120271";
const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();

describe("explorer parsing", () => {
  test("to24h", () => {
    expect(to24h("09:00AM")).toBe("09:00");
    expect(to24h("12:50PM")).toBe("12:50");
    expect(to24h("12:00AM")).toBe("00:00");
    expect(to24h("01:45PM")).toBe("13:45");
    expect(to24h("ARRANGED")).toBeNull();
  });

  test("course detail", async () => {
    const course = parseCourseDetail(await fixture("explorer-cs225-detail.xml"), T)!;
    expect(course).toMatchObject({ subject: "CS", number: "225", title: "Data Structures", creditHours: "4 hours" });
    expect(course.scheduleInfo).toContain("laboratory-discussion");
    expect(course.sections.length).toBe(9);
    const lecture = course.sections.find(section => section.crn === "59777")!;
    expect(lecture).toMatchObject({ section: "AL2", type: "LEC", typeName: "Lecture", partOfTerm: "1" });
    expect(lecture.meetings[0]).toEqual({
      type: "LEC",
      typeName: "Lecture",
      days: "MWF",
      start: "11:00",
      end: "11:50",
      building: "Foellinger Auditorium",
      room: "AUD",
      instructors: ["Erickson, J", "Solomon, B"],
    });
    expect(course.sections.find(section => section.crn === "31234")!.meetings[0]!.instructors).toEqual([]);
  });

  test("arranged meetings have no days or times", async () => {
    const course = parseCourseDetail(await fixture("explorer-cs-374-detail.xml"), T)!;
    const arranged = course.sections.find(section => section.crn === "67963")!;
    expect(arranged.meetings.length).toBe(2);
    expect(arranged.meetings[0]).toMatchObject({ days: "", start: null, end: null });
  });

  test("subjects and cascade", async () => {
    const subjects = parseSubjects(await fixture("explorer-spring2027.xml"));
    expect(subjects.length).toBeGreaterThan(100);
    expect(subjects.find(subject => subject.code === "CS")?.name).toBe("Computer Science");
    const courses = parseCascade(await fixture("explorer-afas-cascade.xml"), T);
    expect(courses.length).toBe(5);
    expect(courses[0]).toMatchObject({ subject: "AFAS", number: "102", title: "Leadership Laboratory" });
    expect(courses[0]!.sections[0]!.meetings.length).toBe(3);
  });
});

describe("terms", () => {
  test("cleans Banner descriptions", async () => {
    const terms = parseTerms(JSON.parse(await fixture("terms.json")));
    expect(terms[0]).toEqual({ code: "120271", description: "Spring 2027" });
    expect(terms[1]).toEqual({ code: "120270", description: "Winter 2027" });
    expect(cleanTermDescription("120268", "Fall 2026 - Urbana-Champaign")).toBe("Fall 2026");
  });

  test("terms() falls back when Banner is unreachable", async () => {
    const sync = new CatalogSync({
      store: new Store(":memory:"),
      fetch: async () => new Response("down", { status: 503 }),
      now: () => Date.UTC(2026, 9, 28),
    });
    const terms = await sync.terms();
    expect(terms.map(term => term.code)).toContain("120271");
  });
});

describe("search", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(":memory:");
    saveCourses(store, [
      parseCourseDetail(await fixture("explorer-cs225-detail.xml"), T)!,
      parseCourseDetail(await fixture("explorer-cs-374-detail.xml"), T)!,
      parseCourseDetail(await fixture("explorer-math-241-detail.xml"), T)!,
      ...parseCascade(await fixture("explorer-afas-cascade.xml"), T),
    ]);
  });

  const codes = (q: string) => search(store, T, q).map(hit => `${hit.subject} ${hit.number}`);

  test("finds CS 225 by many spellings", () => {
    for (const q of ["225", "cs 225", "cs225", "CS 225", "data struct", "Data Structures", "cs 22"]) {
      expect(codes(q)[0]).toBe("CS 225");
    }
  });

  test("instructor last name", () => {
    const hits = search(store, T, "erickson");
    expect(hits[0]).toMatchObject({ subject: "CS", number: "225", matchedInstructor: "Erickson, J" });
    expect(codes("pascaleff")).toEqual(["MATH 241"]);
    expect(codes("fox")).toContain("CS 374");
  });

  test("CRN exact match first", () => {
    const hits = search(store, T, "59777");
    expect(hits[0]).toMatchObject({ subject: "CS", number: "225", matchedCrn: "59777" });
    expect(codes("46060")[0]).toBe("MATH 241");
  });

  test("subject listing and partial words", () => {
    expect(codes("cs")).toEqual(["CS 225", "CS 374"]);
    expect(codes("calc")).toEqual(["MATH 241"]);
    expect(codes("algorithms")).toEqual(["CS 374"]);
  });

  test("nonsense and empty queries", () => {
    expect(search(store, T, "")).toEqual([]);
    expect(search(store, T, "zzzzqqq")).toEqual([]);
    expect(search(store, T, '"*:()')).toEqual([]);
    expect(search(store, "120268", "225")).toEqual([]);
  });

  test("courseDetail from stored data with seats and linked options", async () => {
    store.upsertSeat({ term: T, crn: "59777", available: 3, max: 400, enrolled: 397, checkedAt: 1 });
    const html = await fixture("linked-59777.html");
    const linked = new LinkedSections(store, {
      fetch: async input => new Response(input.includes("59777") ? html : `<section aria-labelledby="linked">No linked course information available.</section>`),
    });
    const detail = (await courseDetail(store, T, "cs", "225", { linked }))!;
    expect(detail.title).toBe("Data Structures");
    expect(detail.sections.length).toBe(9);
    expect(detail.sections.find(section => section.crn === "59777")?.seats?.available).toBe(3);
    expect(detail.sections.find(section => section.crn === "31208")?.seats).toBeNull();
    expect(detail.linkedOptions["59777"]?.length).toBe(7);
    expect(detail.linkedOptions["31208"]).toEqual([]);
  });
});

describe("on-demand course fetch", () => {
  test("fetches ?mode=detail when the course is missing and stores it", async () => {
    const store = new Store(":memory:");
    const xml = await fixture("explorer-cs225-detail.xml");
    const urls: string[] = [];
    const explorer = new Explorer({
      fetch: async (input, init) => {
        urls.push(input);
        expect((init?.headers as Record<string, string>).Accept).toBe("application/xml");
        return new Response(xml);
      },
    });
    const detail = await courseDetail(store, T, "CS", "225", { explorer });
    expect(detail?.sections.length).toBe(9);
    expect(urls).toEqual(["https://courses.illinois.edu/cisapp/explorer/schedule/2027/spring/CS/225.xml?mode=detail"]);
    await courseDetail(store, T, "CS", "225", { explorer });
    expect(urls.length).toBe(1);
    expect(search(store, T, "cs225")[0]?.number).toBe("225");
  });

  test("returns null for unknown courses", async () => {
    const explorer = new Explorer({ fetch: async () => new Response("", { status: 404 }) });
    expect(await courseDetail(new Store(":memory:"), T, "CS", "999", { explorer })).toBeNull();
  });
});

describe("CatalogSync", () => {
  test("syncs subjects sequentially and records meta", async () => {
    const store = new Store(":memory:");
    const subjectsXml = `<?xml version="1.0"?><ns2:term id="120271" xmlns:ns2="http://rest.cis.illinois.edu"><label>Spring 2027</label><subjects>
      <subject id="AFAS" href="x">Air Force Aerospace Studies</subject><subject id="BAD" href="x">Broken</subject></subjects></ns2:term>`;
    const cascade = await fixture("explorer-afas-cascade.xml");
    const urls: string[] = [];
    const sleeps: number[] = [];
    const sync = new CatalogSync({
      store,
      sleep: async ms => {
        sleeps.push(ms);
      },
      fetch: async input => {
        urls.push(input);
        if (input.endsWith("2027/spring.xml")) return new Response(subjectsXml);
        if (input.includes("/AFAS.xml?mode=cascade")) return new Response(cascade);
        return new Response("err", { status: 500 });
      },
    });
    expect(sync.syncing()).toBe(false);
    const pending = sync.sync(T);
    expect(sync.syncing()).toBe(true);
    expect(await pending).toEqual({ courses: 5 });
    expect(sync.syncing()).toBe(false);
    expect(sleeps).toEqual([250]);
    expect(urls.length).toBe(3);
    expect(sync.status(T)).toMatchObject({ courses: 5, syncing: false });
    // Fresh: no refetch.
    await sync.sync(T);
    expect(urls.length).toBe(3);
    await sync.sync(T, { force: true });
    expect(urls.length).toBe(6);
  });
});
