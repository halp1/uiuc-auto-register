// User-run discovery probe (rehearsal mode only, strictly read-only).
//   REGISTRATION_MODE=rehearsal bun scripts/probe-discover.ts <term>
// Logs in, keeps the write interceptor blocking ALL writes, opens the registration page,
// records every request the page makes, tries the schedule-read candidates, and writes
// data/probe/discover.json. Query strings and bodies are never recorded.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/core/bus";
import { systemClock } from "../src/core/clock";
import { loadConfig } from "../src/core/config";
import { Store } from "../src/core/db";
import { Events } from "../src/core/events";
import { isTermCode } from "../src/core/terms";
import { redactUrl } from "../src/banner/interceptor";
import { BannerSessionManager, BANNER_ORIGIN, scheduleStrategyPath } from "../src/banner/session";
import { parseScheduleJson, SCHEDULE_STRATEGIES, SSB_PATH } from "../src/banner/registrar/types";

const config = loadConfig();
if (config.mode !== "rehearsal") {
  console.error("probe:discover requires REGISTRATION_MODE=rehearsal");
  process.exit(2);
}
if (config.browserBackend !== "chrome") {
  console.error("probe:discover requires BROWSER_BACKEND=chrome (the write interceptor needs it)");
  process.exit(2);
}
const term = process.argv[2] ?? "120271";
if (!isTermCode(term)) {
  console.error("Usage: bun scripts/probe-discover.ts <term code>");
  process.exit(2);
}

const store = new Store(":memory:");
const events = new Events(store, new Bus());
events.onEvent(e => {
  if (e.kind === "login_stage" || e.kind === "session_error") console.log(`[${e.kind}] ${e.title}${e.detail ? `: ${e.detail}` : ""}`);
});
const manager = new BannerSessionManager({ config, events, store, clock: systemClock, settings: () => store.getSettings() });

const requests: { method: string; url: string; type: string | null; status: number | null }[] = [];
const out: Record<string, unknown> = { term, startedAt: new Date().toISOString() };

try {
  console.log("Logging in (writes are blocked for the whole run)...");
  await manager.ensureWarm(term);
  const browser = manager.probeBrowser();
  if (!browser?.cdp || !browser.onCdpEvent) throw new Error("probe needs the chrome backend");
  await browser.cdp("Network.enable");
  const byId = new Map<string, (typeof requests)[number]>();
  browser.onCdpEvent("Network.requestWillBeSent", (p: any) => {
    const url = String(p?.request?.url ?? "");
    if (!url.startsWith(BANNER_ORIGIN)) return;
    const entry = { method: String(p?.request?.method ?? "GET"), url: redactUrl(url), type: p?.type ?? null, status: null };
    byId.set(String(p.requestId), entry);
    requests.push(entry);
  });
  browser.onCdpEvent("Network.responseReceived", (p: any) => {
    const entry = byId.get(String(p?.requestId));
    if (entry) entry.status = Number(p?.response?.status ?? 0) || null;
  });

  console.log("Opening the registration page...");
  await browser.navigate(`${BANNER_ORIGIN}${SSB_PATH}/classRegistration/classRegistration`);
  await Bun.sleep(8000);

  const candidates: Record<string, unknown> = {};
  for (const strategy of SCHEDULE_STRATEGIES) {
    try {
      const res = await manager.inPageFetch(scheduleStrategyPath(strategy, term));
      const crns = res.status === 200 ? parseScheduleJson(res.body, term) : null;
      candidates[strategy] = { status: res.status, contentType: res.contentType, json: crns !== null, crns };
    } catch (error) {
      candidates[strategy] = { error: (error as Error).message };
    }
  }
  out.scheduleCandidates = candidates;
  out.requests = requests;
  out.blockedWrites = manager.blockedWrites();
  out.finishedAt = new Date().toISOString();

  const dir = join(config.dataDir, "probe");
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "discover.json"), JSON.stringify(out, null, 2));

  console.log("\nSchedule read candidates:");
  for (const [name, value] of Object.entries(candidates)) {
    const v = value as any;
    console.log(`  ${name}: ${v.error ?? `HTTP ${v.status}, ${v.json ? `${v.crns.length} CRNs: ${v.crns.join(", ")}` : "not JSON"}`}`);
  }
  const unique = [...new Set(requests.map(r => `${r.method} ${r.url}`))];
  console.log(`\n${unique.length} distinct Banner requests recorded. Blocked writes: ${manager.blockedWrites()}`);
  console.log(`Wrote ${join(dir, "discover.json")}. Compare the CRNs above with your real schedule.`);
} catch (error) {
  console.error(`Probe failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
