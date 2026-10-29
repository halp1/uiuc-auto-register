// Seeds a Store with real Spring 2027 catalog data (captured fixtures) and linked options, so course
// detail lookups never reach the network.

import { parseCourseDetail } from "../../src/catalog/explorer";
import { saveCourses } from "../../src/catalog/store";
import type { Store } from "../../src/core/db";

export const TERM = "120271";

const read = (name: string) => Bun.file(new URL(`./${name}`, import.meta.url)).text();

/** Linked options for every lecture, which is what courseDetail probes. */
export const SEED_LINKED: Record<string, string[][]> = {
  // CS 225: AL1 and AL2 link to any lab-discussion.
  "31208": [["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]],
  "59777": [["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]],
  // CS 374: AL1 with AY*, BL1 with BY*.
  "65088": [["65089"], ["65090"], ["65091"], ["65092"]],
  "67005": [["67951"], ["67953"]],
  // MATH 241: a few discussions per lecture.
  "46060": [["46053"], ["46054"], ["46056"]],
  "46067": [["46057"], ["46058"]],
  "55921": [["46070"], ["46071"]],
  "46074": [["46072"]],
  "46075": [["77314"]],
};

export async function seedCatalog(store: Store, now = Date.now()): Promise<void> {
  const courses = await Promise.all(
    ["explorer-cs225-detail.xml", "explorer-cs-374-detail.xml", "explorer-math-241-detail.xml"].map(async name =>
      parseCourseDetail(await read(name), TERM)!,
    ),
  );
  saveCourses(store, courses);
  const insert = store.db.query(
    `INSERT INTO linked_options (term, crn, options, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(term, crn) DO UPDATE SET options = excluded.options, fetched_at = excluded.fetched_at`,
  );
  for (const [crn, options] of Object.entries(SEED_LINKED)) insert.run(TERM, crn, JSON.stringify(options), now);
}
