// User-run time ticket check (always Test mode, strictly read-only).
//   bun run probe:ticket [term]        default: the active term, else Spring 2027
// Logs in with the write interceptor blocking all writes, reads Prepare for Registration, and prints only
// the parsed ticket dates. Page text is never printed or saved.

import { Bus } from "../src/core/bus";
import { systemClock } from "../src/core/clock";
import { Store } from "../src/core/db";
import { probeSetup } from "./_probe";
import { Events } from "../src/core/events";
import { isTermCode, termLabel } from "../src/core/terms";
import { BannerSessionManager } from "../src/banner/session";
import { currentWindow } from "../src/banner/ticket";

const { config, credentials, args } = probeSetup("probe:ticket");
const term = args[0] ?? "120271";
if (!isTermCode(term)) {
  console.error("Usage: bun run probe:ticket [term code]");
  process.exit(2);
}

const store = new Store(":memory:");
const events = new Events(store, new Bus());
events.onEvent(e => {
  if (e.kind === "login_stage" || e.kind === "session_error") console.log(`[${e.kind}] ${e.title}${e.detail ? `: ${e.detail}` : ""}`);
});
const manager = new BannerSessionManager({ config, events, store, clock: systemClock, settings: () => store.getSettings(), credentials: () => credentials });
const show = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) : "open ended";

try {
  console.log(`Reading the time ticket for ${termLabel(term)} (writes are blocked)...`);
  const parsed = await manager.readTicket(term);
  if (parsed.status === "found") {
    for (const w of parsed.windows) console.log(`  window: ${show(w.start)} to ${show(w.end)}`);
    const now = currentWindow(parsed.windows, Date.now());
    console.log(now ? `The app would use: ${show(now.start)}` : "Every window has ended.");
  } else if (parsed.status === "none") {
    console.log("Banner says there is no time ticket for this term.");
  } else {
    console.log("No time ticket date could be read from the page. Tell the developer, and enter the ticket by hand.");
  }
  console.log(`Blocked writes: ${manager.blockedWrites()}`);
} catch (error) {
  console.error(`Probe failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
