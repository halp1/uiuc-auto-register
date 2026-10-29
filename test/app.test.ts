import { afterAll, beforeAll, expect, test } from "bun:test";
import { apiRoutes } from "../src/api/routes";
import { createApp, type App } from "../src/app";
import { makeConfig } from "../src/core/config";
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
  app = await createApp(makeConfig("simulated", { chromePath: null }), { store });
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

test.each([
  ["live outside live mode", "POST", "/api/live", { enabled: true, confirmText: "Spring 2027" }, 403],
  ["swap drop while swaps are locked", "PATCH", "/api/wanted/1", { swapDropCrn: "41234" }, 403],
  ["rehearsal in simulated mode", "POST", "/api/rehearsal", { term: "120271" }, 409],
  ["setup login in simulated mode", "POST", "/api/setup/login", undefined, 409],
  ["unknown notify channel", "POST", "/api/notify/test/nope", undefined, 404],
] as const)("refused: %s", async (_name, method, path, body, status) => {
  expect((await call(method, path, body)).status).toBe(status);
  const s = app.services.settings();
  expect(s.liveEnabled).toBe(false);
  expect(s.swapsUnlocked).toBe(false);
});

test.each([
  ["poll interval below minimum", "PUT", "/api/settings", { pollIntervalSec: 5 }],
  ["non-Discord webhook host", "PUT", "/api/settings", { discordWebhookUrl: "https://example.com/api/webhooks/123456789012345678/WebhookSecretToken_0123456789abcdefghijklmnop" }],
  ["CRN that is not 5 digits", "POST", "/api/wanted", { term: "120271", subject: "CS", number: "374", kind: "bundles", bundles: [["123"]] }],
  ["blank plan name", "POST", "/api/plans", { term: "120271", name: "  " }],
  ["malformed TOTP secret", "PUT", "/api/credentials", { totpSecret: "not a key!" }],
  ["malformed NetID", "PUT", "/api/credentials", { netid: "x y z" }],
  ["empty password", "PUT", "/api/credentials", { password: "" }],
  ["malformed TOTP key for a code", "POST", "/api/setup/totp-code", { secret: "nope" }],
  ["unknown setup step", "PUT", "/api/setup/step", { step: "bogus" }],
  ["unknown mode", "PUT", "/api/mode", { mode: "test" }],
] as const)("400 for %s", async (_name, method, path, body) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(400);
  expect(typeof res.json.error).toBe("string");
});

test("settings secrets are stored but never returned", async () => {
  const token = "x".repeat(40) + "abcd";
  const hook = "WebhookSecretToken_0123456789abcdefghijklmnop";
  const ok = await call("PUT", "/api/settings", {
    discordToken: token,
    discordUserId: "123456789012345678",
    discordWebhookUrl: `https://discordapp.com/api/webhooks/123456789012345678/${hook}`,
    routing: { registered: { discord: false, push: false, webhook: true } },
  });
  expect(ok.status).toBe(200);
  expect(ok.json).toMatchObject({ discordTokenHint: "abcd", discordWebhookHint: "mnop" });
  for (const key of ["discordToken", "discordWebhookUrl", "vapidPrivateKey"]) expect(ok.json[key]).toBeUndefined();
  // A partial routing patch only touches the events it names.
  expect(ok.json.routing.registered).toEqual({ discord: false, push: false, webhook: true });
  expect(ok.json.routing.bundle_opened.webhook).toBe(false);
  const state = JSON.stringify((await call("GET", "/api/state")).json);
  expect(state).not.toContain(token);
  expect(state).not.toContain(hook);
  await call("PUT", "/api/settings", {
    discordToken: null,
    discordUserId: null,
    discordWebhookUrl: null,
    routing: { registered: { discord: false, push: false, webhook: false } },
  });
});

test("schedule planner routes: plans, courses, generate, target", async () => {
  const frames: StreamMessage[] = [];
  const unsubscribe = app.services.bus.subscribe(message => frames.push(message));
  try {
    const listed = await call("GET", "/api/plans?term=120271");
    expect(listed.json.map((p: any) => p.name)).toEqual(["Plan 1"]);
    const planId = listed.json[0].id;

    const second = await call("POST", "/api/plans", { term: "120271", name: "Backup plan" });
    expect(second.status).toBe(201);
    expect((await call("PATCH", `/api/plans/${second.json.id}`, { name: "Renamed", sort: "gaps", openOnly: true })).json).toMatchObject({
      name: "Renamed",
      sort: "gaps",
      openOnly: true,
    });
    expect((await call("DELETE", `/api/plans/${second.json.id}`)).status).toBe(200);
    expect((await call("PATCH", `/api/plans/${second.json.id}`, { name: "x" })).status).toBe(404);
    expect(frames.some(frame => frame.type === "plans" && frame.term === "120271")).toBe(true);

    let plan = (await call("POST", `/api/plans/${planId}/courses`, { subject: "cs", number: "374" })).json;
    plan = (await call("POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "241" })).json;
    expect(plan.courses.map((c: any) => `${c.subject} ${c.number}`)).toEqual(["CS 374", "MATH 241"]);
    expect((await call("POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "241" })).status).toBe(409);
    const cs374 = plan.courses[0].id;

    // Validation that lives only in the routes.
    const rejects: [string, string, unknown, number][] = [
      ["PATCH", `/api/plans/${planId}`, { sort: "nope" }, 400],
      ["PATCH", `/api/plans/${planId}`, { breaks: [{ days: ["M"], start: "13:00", end: "12:00" }] }, 400],
      ["PATCH", `/api/plans/${planId}`, { breaks: [{ days: ["X"], start: "12:00", end: "13:00" }] }, 400],
      ["POST", `/api/plans/${planId}/courses`, { subject: "MATH", number: "2" }, 400],
      ["PATCH", `/api/plans/${planId}/courses/${cs374}`, { excludedCrns: ["123"] }, 400],
      ["PATCH", `/api/plans/${planId}/courses/${cs374}`, { locked: [] }, 400],
      ["PATCH", `/api/plans/${planId}/courses/999`, { included: false }, 404],
      ["POST", `/api/plans/${planId}/target`, { picks: [] }, 400],
    ];
    for (const [method, path, body, status] of rejects) expect([path, (await call(method, path, body)).status]).toEqual([path, status]);

    // CS 225 was registered by the first test, ignore it so both plan courses have options.
    await call("PATCH", `/api/plans/${planId}`, { ignoreRegistered: true });
    const framesBefore = frames.length;
    const generated = await call("POST", `/api/plans/${planId}/generate`);
    expect(generated.status).toBe(200);
    expect(generated.json.total).toBeGreaterThan(0);
    // Results come only in the response, not on the stream.
    expect(frames.slice(framesBefore).some(frame => "schedules" in frame)).toBe(false);

    const best = generated.json.schedules[0];
    const framesBeforeTarget = frames.length;
    const targeted = await call("POST", `/api/plans/${planId}/target`, { picks: best.picks });
    expect(targeted.status).toBe(200);
    const linked = targeted.json.wanted.filter((w: any) => w.planId === planId);
    expect(linked.map((w: any) => `${w.subject} ${w.number}`)).toEqual(["CS 374", "MATH 241"]);
    expect(linked.every((w: any) => w.armed)).toBe(true);
    const after = frames.slice(framesBeforeTarget).map(frame => frame.type);
    expect(after).toEqual(expect.arrayContaining(["wanted", "plans"]));

    expect((await call("DELETE", `/api/plans/${planId}`)).status).toBe(200);
  } finally {
    unsubscribe();
  }
});

// ---------- account, setup, and mode ----------

const KEY = "JBSWY3DPEHPK3PXP"; // RFC test seed

test("credentials: normalized, encrypted at rest, never returned", async () => {
  const ok = await call("PUT", "/api/credentials", { netid: " JDoe2@illinois.edu ", password: "hunter2-Secret!", totpSecret: "jbsw y3dp ehpk 3pxp" });
  expect(ok.status).toBe(200);
  expect(ok.json).toMatchObject({ netid: "jdoe2", passwordSet: true, totpSet: true });
  expect(ok.json.password).toBeUndefined();
  expect(ok.json.totpSecret).toBeUndefined();
  const state = JSON.stringify((await call("GET", "/api/state")).json);
  expect(state).not.toContain("hunter2");
  expect(state).not.toContain(KEY);
  const raw = JSON.stringify(app.services.store.db.query("SELECT key, value FROM settings").all());
  expect(raw).not.toContain("hunter2");
  expect(raw).not.toContain(KEY);
  expect(app.services.settings()).toMatchObject({ password: "hunter2-Secret!", totpSecret: KEY });
  // Omitted fields stay as they are.
  await call("PUT", "/api/credentials", { netid: "jdoe3" });
  expect(app.services.settings().password).toBe("hunter2-Secret!");
});

test("totp-code: six digits for a pasted key, nothing stored", async () => {
  const before = app.services.store.db.query("SELECT COUNT(*) AS n FROM settings").get();
  const res = await call("POST", "/api/setup/totp-code", { secret: "abcd efgh ijkl mnop" });
  expect(res.status).toBe(200);
  expect(res.json.code).toMatch(/^\d{6}$/);
  expect(res.json.secondsLeft).toBeGreaterThanOrEqual(1);
  expect(res.json.secondsLeft).toBeLessThanOrEqual(30);
  expect(app.services.store.db.query("SELECT COUNT(*) AS n FROM settings").get()).toEqual(before);
});

test("mode: refused without a restart hook, otherwise saves, turns Live off, then restarts", async () => {
  expect((await call("PUT", "/api/mode", { mode: "live" })).status).toBe(501);
  expect(app.services.settings().liveEnabled).toBe(false);

  let restarted = 0;
  app.services.restart = () => restarted++;
  try {
    app.services.store.updateSettings({ mode: "simulated", liveEnabled: true, liveTerm: "120271" });
    const res = await call("PUT", "/api/mode", { mode: "rehearsal" });
    expect(res.json).toEqual({ ok: true, restarting: true });
    expect(app.services.settings()).toMatchObject({ mode: "rehearsal", liveEnabled: false, liveTerm: null });
    expect(await until(async () => restarted === 1)).toBe(true);
  } finally {
    app.services.restart = undefined;
    app.services.store.updateSettings({ mode: "live", liveEnabled: false, liveTerm: null });
  }
});
