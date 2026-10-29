import { afterAll, beforeAll, expect, test } from "bun:test";
import { apiRoutes } from "../src/api/routes";
import { createApp, type App } from "../src/app";
import { loadConfig } from "../src/core/config";
import { Store } from "../src/core/db";
import type { StreamMessage } from "../src/core/types";
import { seedCatalog } from "./fixtures/catalog";

let app: App;
let server: ReturnType<typeof Bun.serve>;
let base = "";

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { "x-auto-register": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

const until = async (check: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
};

beforeAll(async () => {
  const store = new Store(":memory:");
  // No network: pin a term and pretend the catalog is fresh so nothing syncs.
  store.updateSettings({ activeTerm: "120271" });
  store.db.query("INSERT INTO cat_meta (term, synced_at, courses) VALUES ('120271', ?, 0)").run(Date.now());
  // Catalog and linked sections for the plan routes, so course detail never fetches.
  await seedCatalog(store);
  app = await createApp(loadConfig({ REGISTRATION_MODE: "simulated", NODE_ENV: "test" }), { store });
  // Simulated mode never polls Banner, but block outbound calls anyway.
  app.services.terms = async () => [{ code: "120271", description: "Spring 2027" }];
  const { routes } = apiRoutes(app.services);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes });
  base = `http://127.0.0.1:${server.port}`;
  await app.start();
});

afterAll(async () => {
  server?.stop(true);
  await app?.stop();
});

test("simulated end to end: arm, open seats, auto registers, schedule kept", async () => {
  const created = await call("POST", "/api/wanted", {
    term: "120271", subject: "CS", number: "225", title: "Data Structures", kind: "bundles", bundles: [["59777", "31225"]],
  });
  expect(created.status).toBe(201);
  expect((await call("POST", `/api/wanted/${created.json.id}/arm`)).status).toBe(200);
  await call("POST", "/api/sim/seats", { term: "120271", crn: "59777", available: 3 });
  await call("POST", "/api/sim/seats", { term: "120271", crn: "31225", available: 1 });
  app.services.poller.kick();
  const done = await until(async () => (await call("GET", "/api/state")).json.wanted[0].state === "registered");
  expect(done).toBe(true);
  const sim = (await call("GET", "/api/sim")).json;
  expect(sim.schedule["120271"]).toEqual(expect.arrayContaining(["41234", "52345", "59777", "31225"]));
});

test("live cannot be turned on outside live mode", async () => {
  const res = await call("POST", "/api/live", { enabled: true, confirmText: "Spring 2027" });
  expect(res.status).toBe(403);
  expect(app.services.settings().liveEnabled).toBe(false);
});

test("cross-site and header-less writes are refused", async () => {
  const plain = await fetch(base + "/api/control/pause", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  expect(plain.status).toBe(403);
  const cross = await fetch(base + "/api/control/pause", {
    method: "POST",
    headers: { "x-auto-register": "1", "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
  });
  expect(cross.status).toBe(403);
  const rebind = await fetch(base + "/api/state", { headers: { host: "evil.example:3000" } });
  expect(rebind.status).toBe(403);
  expect(app.services.settings().globalPaused).toBe(false);
});

test("rehearsal is refused in simulated mode", async () => {
  const res = await call("POST", "/api/rehearsal", { term: "120271" });
  expect(res.status).toBe(409);
});

test("settings validation and secret redaction", async () => {
  expect((await call("PUT", "/api/settings", { pollIntervalSec: 5 })).status).toBe(400);
  const ok = await call("PUT", "/api/settings", { discordToken: "x".repeat(40) + "abcd", discordUserId: "123456789012345678" });
  expect(ok.status).toBe(200);
  expect(ok.json.discordToken).toBeUndefined();
  expect(ok.json.discordTokenHint).toBe("abcd");
  expect(ok.json.vapidPrivateKey).toBeUndefined();
  const state = await call("GET", "/api/state");
  expect(JSON.stringify(state.json)).not.toContain("x".repeat(40));
  await call("PUT", "/api/settings", { discordToken: null, discordUserId: null });
});

test("discord webhook URL: validated, stored, never returned", async () => {
  const secret = "WebhookSecretToken_0123456789abcdefghijklmnop";
  const bad = await call("PUT", "/api/settings", { discordWebhookUrl: `https://example.com/api/webhooks/123456789012345678/${secret}` });
  expect(bad.status).toBe(400);
  const ok = await call("PUT", "/api/settings", { discordWebhookUrl: `https://discordapp.com/api/webhooks/123456789012345678/${secret}` });
  expect(ok.status).toBe(200);
  expect(ok.json.discordWebhookUrl).toBeUndefined();
  expect(ok.json.discordWebhookHint).toBe("mnop");
  expect(JSON.stringify((await call("GET", "/api/state")).json)).not.toContain(secret);
  const routed = await call("PUT", "/api/settings", { routing: { registered: { discord: false, push: false, webhook: true } } });
  expect(routed.json.routing.registered).toEqual({ discord: false, push: false, webhook: true });
  expect(routed.json.routing.bundle_opened.webhook).toBe(false);
  expect((await call("POST", "/api/notify/test/nope")).status).toBe(404);
  await call("PUT", "/api/settings", { discordWebhookUrl: null, routing: { registered: { discord: false, push: false, webhook: false } } });
});

test("bad input is rejected with a readable error", async () => {
  const bad = await call("POST", "/api/wanted", { term: "120271", subject: "CS", number: "374", kind: "bundles", bundles: [["123"]] });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toContain("5 digit");
  expect((await call("PATCH", "/api/wanted/1", { swapDropCrn: "41234" })).status).toBe(403);
});

test("schedule planner: plans, courses, generate, target", async () => {
  const frames: StreamMessage[] = [];
  const unsubscribe = app.services.bus.subscribe(message => frames.push(message));
  try {
    const listed = await call("GET", "/api/plans?term=120271");
    expect(listed.status).toBe(200);
    expect(listed.json.map((p: any) => p.name)).toEqual(["Plan 1"]);
    const planId = listed.json[0].id;

    // Plans: create, sorted by position, limits and validation.
    const second = await call("POST", "/api/plans", { term: "120271", name: "Backup plan" });
    expect(second.status).toBe(201);
    expect((await call("GET", "/api/plans?term=120271")).json.map((p: any) => p.name)).toEqual(["Plan 1", "Backup plan"]);
    expect((await call("POST", "/api/plans", { term: "120271", name: "  " })).status).toBe(400);
    expect((await call("PATCH", `/api/plans/${second.json.id}`, { name: "Renamed", sort: "gaps", openOnly: true })).json).toMatchObject({
      name: "Renamed",
      sort: "gaps",
      openOnly: true,
    });
    expect((await call("PATCH", `/api/plans/${planId}`, { sort: "nope" })).status).toBe(400);
    expect((await call("PATCH", `/api/plans/${planId}`, { breaks: [{ days: ["M"], start: "13:00", end: "12:00" }] })).status).toBe(400);
    expect((await call("PATCH", `/api/plans/${planId}`, { breaks: [{ days: ["X"], start: "12:00", end: "13:00" }] })).status).toBe(400);
    expect((await call("DELETE", `/api/plans/${second.json.id}`)).status).toBe(200);
    expect((await call("PATCH", `/api/plans/${second.json.id}`, { name: "x" })).status).toBe(404);
    expect(frames.some(frame => frame.type === "plans" && frame.term === "120271")).toBe(true);

    // Courses.
    let plan = (await call("POST", `/api/plans/${planId}/courses`, { subject: "cs", number: "374" })).json;
    plan = (await call("POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "241" })).json;
    expect(plan.courses.map((c: any) => [c.subject, c.number, c.title])).toEqual([
      ["CS", "374", "Introduction to Algorithms & Models of Computation"],
      ["MATH", "241", "Calculus III"],
    ]);
    expect((await call("POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "241" })).status).toBe(409);
    expect((await call("POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "2" })).status).toBe(400);
    const cs374 = plan.courses[0].id;
    expect((await call("PATCH", `/api/plans/${planId}/courses/${cs374}`, { excludedCrns: ["123"] })).status).toBe(400);
    expect((await call("PATCH", `/api/plans/${planId}/courses/${cs374}`, { locked: [] })).status).toBe(400);
    expect((await call("PATCH", `/api/plans/${planId}/courses/${cs374}`, { excludedCrns: ["65089"] })).json.courses[0].excludedCrns).toEqual([
      "65089",
    ]);
    expect((await call("PATCH", `/api/plans/${planId}/courses/999`, { included: false })).status).toBe(404);

    // Generate. CS 225 was registered by the first test: its R 11:00 lab blocks both CS 374 lectures.
    const blocked = (await call("POST", `/api/plans/${planId}/generate`)).json;
    expect(blocked.fixed.map((f: any) => f.crn)).toEqual(["31225", "59777"]);
    expect(blocked.courses[0]).toMatchObject({ subject: "CS", number: "374", status: "no_options" });
    expect(blocked.total).toBe(0);
    await call("PATCH", `/api/plans/${planId}`, { ignoreRegistered: true });
    const framesBefore = frames.length;
    const generated = await call("POST", `/api/plans/${planId}/generate`);
    expect(generated.status).toBe(200);
    expect(generated.json.fixed).toEqual([]);
    expect(generated.json.total).toBeGreaterThan(0);
    expect(generated.json.courses.map((c: any) => c.status)).toEqual(["ok", "ok"]);
    const best = generated.json.schedules[0];
    expect(best.picks.map((p: any) => `${p.subject} ${p.number}`)).toEqual(["CS 374", "MATH 241"]);
    expect(best.picks[0].crns).not.toContain("65089");
    // Results come only in the response, not on the stream.
    expect(frames.slice(framesBefore).some(frame => (frame as any).schedules)).toBe(false);

    // Target: bad picks are refused, a valid one arms both courses and returns the whole watchlist.
    expect((await call("POST", `/api/plans/${planId}/target`, { picks: [] })).status).toBe(400);
    expect((await call("POST", `/api/plans/${planId}/target`, { picks: [best.picks[0]] })).status).toBe(400);
    const framesBeforeTarget = frames.length;
    const targeted = await call("POST", `/api/plans/${planId}/target`, { picks: best.picks });
    expect(targeted.status).toBe(200);
    expect(targeted.json.plan.target.picks).toEqual(best.picks);
    const keys = targeted.json.wanted.map((w: any) => `${w.subject} ${w.number}`);
    expect(keys).toEqual(expect.arrayContaining(["CS 225", "CS 374", "MATH 241"]));
    for (const w of targeted.json.wanted.filter((w: any) => w.planId === planId)) {
      expect(w.armed).toBe(true);
      expect(w.bundles[0].crns).toEqual(best.picks.find((p: any) => p.subject === w.subject && p.number === w.number).crns);
    }
    const after = frames.slice(framesBeforeTarget).map(frame => frame.type);
    expect(after).toContain("wanted");
    expect(after).toContain("plans");

    // Deleting the plan keeps the watchlist courses but clears their link.
    expect((await call("DELETE", `/api/plans/${planId}`)).status).toBe(200);
    const state = (await call("GET", "/api/state")).json;
    expect(state.wanted.filter((w: any) => w.subject === "MATH").map((w: any) => w.planId)).toEqual([null]);
  } finally {
    unsubscribe();
  }
});
