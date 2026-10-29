// User-run discovery probe (test mode only, strictly read-only).
//   bun run probe:discover [term ...]        default: Fall 2026 and Spring 2027
// Logs in with the write interceptor blocking ALL writes, then for each term:
//   1. asks Banner whether the term is open for registration (term/search, the same read-only call
//      Banner's own term picker makes),
//   2. reads what the registration page itself holds (window.bootstraps) and the responses of the
//      requests the page makes on its own,
//   3. opens View Registration Information (registrationHistory) and does the same,
//   4. tries each candidate schedule request in a few parameter variants.
// Only CRNs, statuses, HTTP codes, and URL paths are printed or saved. No names, grades, or bodies.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/core/bus";
import { systemClock } from "../src/core/clock";
import { loadConfig } from "../src/core/config";
import { Store } from "../src/core/db";
import { Events } from "../src/core/events";
import { isTermCode, termLabel } from "../src/core/terms";
import { redactUrl } from "../src/banner/interceptor";
import { BannerSessionManager, BANNER_ORIGIN } from "../src/banner/session";
import { SSB_PATH } from "../src/banner/registrar/types";

const config = loadConfig();
if (config.mode !== "rehearsal") {
  console.error("probe:discover requires REGISTRATION_MODE=test");
  process.exit(2);
}
if (config.browserBackend !== "chrome") {
  console.error("probe:discover requires BROWSER_BACKEND=chrome (the write interceptor needs it)");
  process.exit(2);
}
const terms = process.argv.slice(2).length ? process.argv.slice(2) : ["120268", "120271"];
if (!terms.every(isTermCode)) {
  console.error("Usage: bun run probe:discover [term code ...]");
  process.exit(2);
}

/** CRNs and statuses found anywhere in a JSON value. Nothing else leaves this function. */
function crnSummary(value: unknown): { crns: string[]; statuses: Record<string, string> } {
  const crns = new Set<string>();
  const statuses: Record<string, string> = {};
  const stack: unknown[] = [value];
  let seen = 0;
  while (stack.length && seen++ < 50_000) {
    const node = stack.pop();
    if (Array.isArray(node)) node.forEach(n => stack.push(n));
    else if (node && typeof node === "object") {
      const o = node as Record<string, any>;
      const raw = o.courseReferenceNumber ?? o.crn;
      const crn = raw == null ? "" : String(raw).trim();
      if (/^\d{5}$/.test(crn)) {
        crns.add(crn);
        const status = [o.statusDescription, o.registrationStatusDescription, o.courseRegistrationStatusDescription, o.status]
          .find(v => typeof v === "string" && v.trim());
        const term = o.term ?? o.termCode;
        statuses[crn] = `${status ?? "no status"}${term ? ` (term ${term})` : ""}`;
      }
      Object.values(o).forEach(v => v && typeof v === "object" && stack.push(v));
    }
  }
  return { crns: [...crns].sort(), statuses };
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const show = (v: any) =>
  v.error ? v.error : `HTTP ${v.status}${v.json ? `, ${v.crns.length} CRNs${v.crns.length ? ` ${v.crns.join(", ")}` : ""}` : ", not JSON"}`;

const store = new Store(":memory:");
const events = new Events(store, new Bus());
events.onEvent(e => {
  if (e.kind === "login_stage" || e.kind === "session_error") console.log(`[${e.kind}] ${e.title}${e.detail ? `: ${e.detail}` : ""}`);
});
const manager = new BannerSessionManager({ config, events, store, clock: systemClock, settings: () => store.getSettings() });
const report: Record<string, any> = { startedAt: new Date().toISOString(), terms: {} };

type Captured = { id: string; method: string; path: string; status: number | null; done: boolean };

try {
  console.log("Logging in (writes are blocked for the whole run)...");
  // A term that is not open for registration still logs in; eligibility is checked per term below.
  await manager.ensureWarm(terms[0]!).catch(error => console.log(`Term check during login: ${(error as Error).message}`));
  const browser = manager.probeBrowser();
  if (!browser?.cdp || !browser.onCdpEvent) throw new Error("not logged in, or the probe needs the chrome backend");
  await browser.cdp("Network.enable");

  let captured: Captured[] = [];
  browser.onCdpEvent("Network.requestWillBeSent", (p: any) => {
    const url = String(p?.request?.url ?? "");
    if (!url.startsWith(BANNER_ORIGIN) || ["Image", "Stylesheet", "Font", "Script"].includes(p?.type)) return;
    captured.push({ id: String(p.requestId), method: String(p?.request?.method ?? "GET"), path: new URL(url).pathname, status: null, done: false });
  });
  browser.onCdpEvent("Network.responseReceived", (p: any) => {
    const c = captured.find(x => x.id === String(p?.requestId));
    if (c) c.status = Number(p?.response?.status ?? 0) || null;
  });
  browser.onCdpEvent("Network.loadingFinished", (p: any) => {
    const c = captured.find(x => x.id === String(p?.requestId));
    if (c) c.done = true;
  });

  /** CRNs in the responses of the requests the page made by itself. */
  async function pageRequests() {
    const out: { request: string; status: number | null; json: boolean; crns?: string[]; statuses?: Record<string, string> }[] = [];
    for (const c of captured) {
      if (!c.done || /\.(js|css|png|svg|gif|ico|woff2?)$/i.test(c.path)) continue;
      let body = "";
      try {
        const r = await browser!.cdp!<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: c.id });
        body = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
      } catch {
        continue;
      }
      const json = parse(body);
      out.push({ request: `${c.method} ${c.path}`, status: c.status, json: json !== undefined, ...(json !== undefined ? crnSummary(json) : {}) });
    }
    return out;
  }

  const bootstrapsExpr = `(() => {
    const b = window.bootstraps || {};
    const pick = v => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return null; } };
    return { keys: Object.keys(b), terms: pick(b.terms), multiTerm: pick(b.multiTerm), summaryModels: pick(b.summaryModels), registrationEvents: pick(b.registrationEvents) };
  })()`;

  async function tryRequests(paths: string[]) {
    const out: Record<string, any> = {};
    for (const path of paths) {
      try {
        const res = await manager.inPageFetch(`${SSB_PATH}${path}`);
        const json = parse(res.body);
        out[path] = { status: res.status, json: json !== undefined, ...(json !== undefined ? crnSummary(json) : {}) };
      } catch (error) {
        out[path] = { error: (error as Error).message };
      }
    }
    return out;
  }

  for (const term of terms) {
    const t: Record<string, any> = {};
    report.terms[term] = t;
    console.log(`\n=== ${termLabel(term)} (${term}) ===`);

    try {
      const e = await manager.eligibility(term);
      t.eligibility = e;
      console.log(`Registration open: ${e.allowed ? "yes" : "no"}${e.messages.length ? ` (${e.messages.join(" | ")})` : ""}`);
    } catch (error) {
      t.eligibility = { error: (error as Error).message };
      console.log(`Registration open: could not check (${(error as Error).message})`);
    }

    captured = [];
    await browser.navigate(`${BANNER_ORIGIN}${SSB_PATH}/classRegistration/classRegistration`).catch(() => {});
    await Bun.sleep(6000);
    const boot: any = await browser.evaluate(bootstrapsExpr).catch(() => null);
    t.registrationPage = {
      url: redactUrl(browser.url()),
      bootstrapKeys: boot?.keys ?? null,
      bootstrapTerms: boot?.terms ?? null,
      multiTerm: boot?.multiTerm ?? null,
      summaryModels: boot ? crnSummary(boot.summaryModels) : null,
      registrationEvents: boot ? crnSummary(boot.registrationEvents) : null,
      pageRequests: await pageRequests(),
    };
    const rp = t.registrationPage;
    console.log(`Registration page (${rp.url}) holds: summary ${rp.summaryModels?.crns.join(", ") || "none"}, calendar ${rp.registrationEvents?.crns.join(", ") || "none"}`);
    for (const r of rp.pageRequests) if (r.crns?.length) console.log(`  page request ${r.request} -> ${r.crns.join(", ")}`);

    t.registrationCandidates = await tryRequests([
      `/classRegistration/getRegistrationEvents?termFilter=`,
      `/classRegistration/getRegistrationEvents?termFilter=${term}`,
      `/classRegistration/reset?selectedTab=true&sortColumn=&sortDirection=&uniqueSessionId=probe${Date.now()}`,
    ]);
    for (const [path, v] of Object.entries(t.registrationCandidates)) console.log(`  ${path.replace(/probe\d+/, "...")} -> ${show(v)}`);

    captured = [];
    await browser.navigate(`${BANNER_ORIGIN}${SSB_PATH}/registrationHistory/registrationHistory`).catch(() => {});
    await Bun.sleep(5000);
    const histBoot: any = await browser.evaluate(bootstrapsExpr).catch(() => null);
    t.historyCandidates = await tryRequests([
      `/registrationHistory/reset?term=${term}`,
      `/classRegistration/getRegistrationEvents?termFilter=${term}`,
    ]);
    await Bun.sleep(1500);
    t.historyPage = {
      url: redactUrl(browser.url()),
      bootstrapKeys: histBoot?.keys ?? null,
      bootstrapTerms: histBoot?.terms ?? null,
      pageRequests: await pageRequests(),
    };
    console.log(`View Registration Information (${t.historyPage.url}):`);
    for (const r of t.historyPage.pageRequests) console.log(`  page request ${r.request} -> HTTP ${r.status}${r.json ? `, CRNs ${r.crns?.join(", ") || "none"}` : ""}`);
    for (const [path, v] of Object.entries(t.historyCandidates)) console.log(`  ${path} -> ${show(v)}`);
  }

  report.historyScripts = await browser
    .evaluate<string[]>(`[...document.scripts].map(s => s.src).filter(Boolean)`)
    .then(list => list.map(redactUrl))
    .catch(() => []);
  report.blockedWrites = manager.blockedWrites();
  report.finishedAt = new Date().toISOString();

  const dir = join(config.dataDir, "probe");
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "discover.json"), JSON.stringify(report, null, 2));
  console.log(`\nBlocked writes: ${manager.blockedWrites()}`);
  console.log(`Wrote ${join(dir, "discover.json")}. It holds only CRNs, statuses, HTTP codes, and URL paths.`);
} catch (error) {
  console.error(`Probe failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await manager.dispose();
}
