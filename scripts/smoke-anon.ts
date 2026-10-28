// Anonymous live seat read for one CRN. No login, no cookies. Safe to run anytime.
//   bun scripts/smoke-anon.ts <crn> [term]

import { AnonymousSeatSource } from "../src/banner/enrollment";

const [crn, term = "120271"] = process.argv.slice(2);
if (!crn || !/^\d{5}$/.test(crn) || !/^1\d{4}[0158]$/.test(term)) {
  console.error("Usage: bun scripts/smoke-anon.ts <5-digit CRN> [term code, default 120271]");
  process.exit(2);
}

const source = new AnonymousSeatSource({ concurrency: 1 });
const t0 = performance.now();
try {
  const seats = await source.fetchSeats(term, [crn]);
  const ms = Math.round(performance.now() - t0);
  if (seats.length === 0) {
    console.log(`CRN ${crn} (${term}): no reading (${ms} ms)`);
    process.exitCode = 1;
  } else {
    const s = seats[0]!;
    console.log(`CRN ${crn} (${term}): ${s.available} of ${s.max} seats available, ${s.enrolled} enrolled (${ms} ms)`);
  }
} catch (error) {
  console.error(`Seat read failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
