// User-run probe: does the app's Banner session survive you logging into Banner yourself?
//   REGISTRATION_MODE=rehearsal bun scripts/probe-sessions.ts [term]
// Read-only: the write interceptor blocks every write for the whole run.

import { Bus } from "../src/core/bus";
import { systemClock } from "../src/core/clock";
import { loadConfig } from "../src/core/config";
import { Store } from "../src/core/db";
import { Events } from "../src/core/events";
import { isTermCode } from "../src/core/terms";
import { BannerSessionManager, scheduleStrategyPath } from "../src/banner/session";
import { BannerSessionError } from "../src/banner/registrar/types";

const config = loadConfig();
if (config.mode !== "rehearsal") {
  console.error("probe:sessions requires REGISTRATION_MODE=rehearsal");
  process.exit(2);
}
const term = process.argv[2] ?? "120271";
if (!isTermCode(term)) {
  console.error("Usage: bun scripts/probe-sessions.ts <term code>");
  process.exit(2);
}

const store = new Store(":memory:");
const events = new Events(store, new Bus());
events.onEvent(e => {
  if (e.kind === "login_stage" || e.kind === "session_error") console.log(`[${e.kind}] ${e.title}${e.detail ? `: ${e.detail}` : ""}`);
});
const manager = new BannerSessionManager({ config, events, store, clock: systemClock, settings: () => store.getSettings() });

async function alive(): Promise<string> {
  try {
    const res = await manager.inPageFetch(scheduleStrategyPath("registrationEvents", term));
    return `alive (HTTP ${res.status})`;
  } catch (error) {
    return error instanceof BannerSessionError ? `lost (${error.reason})` : "lost";
  }
}

try {
  console.log("Logging in...");
  await manager.ensureWarm(term);
  console.log(`App session: ${await alive()}`);
  console.log("\nNow log into Banner registration in your own browser, look around (do not change anything you do not mean to), then press Enter here.");
  for await (const _ of console) break;
  const result = await alive();
  console.log(`\nAfter your login, the app session is ${result}.`);
  console.log(result.startsWith("alive") ? "Concurrent sessions work." : "Banner allows one session at a time: pause the app before using Banner yourself.");
} catch (error) {
  console.error(`Probe failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
