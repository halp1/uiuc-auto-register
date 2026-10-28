import { afterAll, beforeAll, expect, test } from "bun:test";
import { apiRoutes } from "../src/api/routes";
import { createApp, type App } from "../src/app";
import { loadConfig } from "../src/core/config";
import { Store } from "../src/core/db";

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

test("bad input is rejected with a readable error", async () => {
  const bad = await call("POST", "/api/wanted", { term: "120271", subject: "CS", number: "374", kind: "bundles", bundles: [["123"]] });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toContain("5 digit");
  expect((await call("PATCH", "/api/wanted/1", { swapDropCrn: "41234" })).status).toBe(403);
});
