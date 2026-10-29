import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AccessControl, deviceName, Limiter, makeRecoveryCode, normalizeRecoveryCode } from "../../src/auth/access";
import { passkeyRpId } from "../../src/api/auth-routes";
import { apiRoutes } from "../../src/api/routes";
import { createApp, type App } from "../../src/app";
import { makeConfig } from "../../src/core/config";
import { Store } from "../../src/core/db";

describe("pieces", () => {
  test("recovery codes: format, typed loosely, single use", () => {
    const code = makeRecoveryCode();
    expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(normalizeRecoveryCode(" ABCDE-fghjk ")).toBe("abcdefghjk");
    const access = new AccessControl(new Store(":memory:"));
    const codes = access.replaceRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(access.useRecoveryCode(codes[0]!.toUpperCase().replace("-", " "))).toBe(true);
    expect(access.useRecoveryCode(codes[0]!)).toBe(false);
    expect(access.useRecoveryCode("aaaaa-aaaaa")).toBe(false);
    expect(access.recoveryCodesLeft()).toBe(7);
  });

  test("nothing secret is stored in plaintext", async () => {
    const store = new Store(":memory:");
    const access = new AccessControl(store);
    const codes = (await access.setPassword("correct horse battery", { newCodes: true }))!;
    const { token } = access.createSession({ remember: true, device: "x", ip: null });
    const dump = JSON.stringify([
      store.db.query("SELECT * FROM auth_kv").all(),
      store.db.query("SELECT * FROM auth_sessions").all(),
      store.db.query("SELECT * FROM recovery_codes").all(),
      store.db.query("SELECT * FROM settings").all(),
    ]);
    expect(dump).not.toContain("correct horse");
    expect(dump).not.toContain(token);
    for (const code of codes) expect(dump).not.toContain(code);
    expect(dump).toContain("$argon2id$");
  });

  test("limiter: 5 failures lock, rounds grow, success clears", () => {
    let now = 0;
    const limiter = new Limiter(() => now);
    for (let i = 0; i < 4; i++) limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(0);
    limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(30);
    expect(limiter.retryAfter("b")).toBe(0);
    now += 31_000;
    for (let i = 0; i < 5; i++) limiter.fail("a");
    expect(limiter.retryAfter("a")).toBe(60);
    limiter.success("a");
    expect(limiter.retryAfter("a")).toBe(0);
  });

  test("limiter: many addresses together trip the global cap", () => {
    const limiter = new Limiter(() => 0);
    for (let i = 0; i < 30; i++) limiter.fail(`ip${i}`);
    expect(limiter.retryAfter("fresh")).toBeGreaterThan(0);
  });

  test("sessions expire, short ones sooner", () => {
    let now = 1_000_000;
    const access = new AccessControl(new Store(":memory:"), () => now);
    const short = access.createSession({ remember: false, device: "x", ip: null }).token;
    const long = access.createSession({ remember: true, device: "x", ip: null }).token;
    now += 13 * 60 * 60 * 1000;
    expect(access.session(short)).toBeNull();
    expect(access.session(long)).not.toBeNull();
    now += 31 * 24 * 60 * 60 * 1000;
    expect(access.session(long)).toBeNull();
  });

  test("passkeys only on https domains or localhost", () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { host: new URL(url).host, ...headers } });
    expect(passkeyRpId(req("http://localhost:3000/"))).toBe("localhost");
    expect(passkeyRpId(req("http://127.0.0.1:3000/"))).toBeNull();
    expect(passkeyRpId(req("http://192.168.1.5:3000/"))).toBeNull();
    expect(passkeyRpId(req("http://reg.example.com/"))).toBeNull();
    expect(passkeyRpId(req("http://reg.example.com/", { "x-forwarded-proto": "https" }))).toBe("reg.example.com");
    expect(passkeyRpId(req("https://reg.example.com/"))).toBe("reg.example.com");
  });

  test("device names", () => {
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceName(null)).toBe("Unknown browser");
  });

  test("reset turns everything off", async () => {
    const store = new Store(":memory:");
    const access = new AccessControl(store);
    await access.setPassword("correct horse battery", { newCodes: true });
    access.createSession({ remember: true, device: "x", ip: null });
    AccessControl.reset(store);
    expect(access.mode()).toBe("none");
    expect(access.hasPassword()).toBe(false);
    expect(access.recoveryCodesLeft()).toBe(0);
    expect(access.listSessions(null)).toEqual([]);
  });
});

describe("over HTTP", () => {
  let app: App;
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  type Res = { status: number; json: any; cookie: string | null };
  const call = async (method: string, path: string, body?: unknown, cookie?: string | null): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "x-auto-register": "1",
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    const text = await res.text();
    return { status: res.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, cookie: set ? set.split(";")[0]! : null };
  };

  beforeAll(async () => {
    const store = new Store(":memory:");
    store.updateSettings({ activeTerm: "120271" });
    store.db.query("INSERT INTO cat_meta (term, synced_at, courses) VALUES ('120271', ?, 0)").run(Date.now());
    app = await createApp(makeConfig("simulated", { chromePath: null }), { store });
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

  test("open until setup chooses, then the whole flow", async () => {
    const fresh = await call("GET", "/api/auth/status");
    expect(fresh.json).toMatchObject({ mode: null, authenticated: true, recoveryCodesLeft: null });
    expect((await call("GET", "/api/state")).status).toBe(200);

    // Too short.
    expect((await call("POST", "/api/auth/configure", { mode: "password", password: "short" })).status).toBe(400);

    const on = await call("POST", "/api/auth/configure", { mode: "password", password: "correct horse battery", remember: true });
    expect(on.status).toBe(200);
    expect(on.json.recoveryCodes).toHaveLength(8);
    expect(on.json.status).toMatchObject({ mode: "password", authenticated: true, recoveryCodesLeft: 8 });
    expect(on.cookie).toMatch(/^uar_[0-9a-f]{12}=/);
    const me = on.cookie!;
    const codes: string[] = on.json.recoveryCodes;

    // Signed out browsers see only the public routes.
    const locked = await call("GET", "/api/state");
    expect(locked.status).toBe(401);
    expect(locked.json.auth).toBe("required");
    expect((await call("GET", "/api/stream")).status).toBe(401);
    expect((await call("PUT", "/api/settings", { pollIntervalSec: 30 })).status).toBe(401);
    expect((await call("PUT", "/api/credentials", { password: "x" })).status).toBe(401);
    expect((await call("GET", "/api/auth/sessions")).status).toBe(401);
    expect((await call("POST", "/api/auth/passkeys/register/options")).status).toBe(401);
    expect((await call("GET", "/api/auth/status")).json).toMatchObject({ mode: "password", authenticated: false, recoveryCodesLeft: null });
    expect((await call("GET", "/healthz")).status).toBe(200);
    // Can't be turned on again over an existing password, or off without it.
    expect((await call("POST", "/api/auth/configure", { mode: "none" })).status).toBe(401);

    // The signed-in browser works.
    expect((await call("GET", "/api/state", undefined, me)).status).toBe(200);
    expect((await call("POST", "/api/auth/configure", { mode: "password", password: "another one here" }, me)).status).toBe(409);

    // Sign in from a second browser.
    expect((await call("POST", "/api/auth/login", { password: "wrong password!", remember: true })).status).toBe(401);
    const other = await call("POST", "/api/auth/login", { password: "correct horse battery", remember: false });
    expect(other.status).toBe(200);
    expect(other.json.authenticated).toBe(true);
    expect(other.cookie).not.toBeNull();
    const second = other.cookie!;
    const sessions = (await call("GET", "/api/auth/sessions", undefined, me)).json;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(second.split("=")[1]);

    // Change the password: other browsers are signed out.
    expect((await call("POST", "/api/auth/password", { currentPassword: "nope nope nope", newPassword: "brand new password" }, me)).status).toBe(403);
    expect((await call("POST", "/api/auth/password", { currentPassword: "correct horse battery", newPassword: "brand new password" }, me)).status).toBe(200);
    expect((await call("GET", "/api/state", undefined, second)).status).toBe(401);
    expect((await call("GET", "/api/state", undefined, me)).status).toBe(200);

    // Recovery code resets the password and signs everyone else out.
    expect((await call("POST", "/api/auth/recover", { code: "zzzzz-zzzzz", newPassword: "recovered password" })).status).toBe(401);
    const recovered = await call("POST", "/api/auth/recover", { code: codes[0], newPassword: "recovered password", remember: true });
    expect(recovered.status).toBe(200);
    expect(recovered.json.recoveryCodesLeft).toBe(7);
    expect((await call("POST", "/api/auth/recover", { code: codes[0], newPassword: "recovered again!" })).status).toBe(401);
    expect((await call("GET", "/api/state", undefined, me)).status).toBe(401);
    const rec = recovered.cookie!;

    // New codes need the current password.
    expect((await call("POST", "/api/auth/recovery-codes", { currentPassword: "brand new password" }, rec)).status).toBe(403);
    const fresh8 = await call("POST", "/api/auth/recovery-codes", { currentPassword: "recovered password" }, rec);
    expect(fresh8.json.recoveryCodes).toHaveLength(8);
    expect((await call("POST", "/api/auth/recover", { code: codes[1], newPassword: "old codes are gone" })).status).toBe(401);

    // Sign out.
    const out = await call("POST", "/api/auth/logout", undefined, rec);
    expect(out.json.authenticated).toBe(false);
    expect(out.cookie).toMatch(/=$/);
    expect((await call("GET", "/api/state", undefined, rec)).status).toBe(401);

    // Back in, then turn it off with the password.
    const back = (await call("POST", "/api/auth/login", { password: "recovered password", remember: true })).cookie!;
    expect((await call("POST", "/api/auth/configure", { mode: "none", currentPassword: "wrong!" }, back)).status).toBe(403);
    const off = await call("POST", "/api/auth/configure", { mode: "none", currentPassword: "recovered password" }, back);
    expect(off.status).toBe(200);
    expect(off.json.status).toMatchObject({ mode: "none", authenticated: true });
    expect((await call("GET", "/api/state")).status).toBe(200);
    expect(app.services.access.recoveryCodesLeft()).toBe(0);
  });

  test("repeated wrong passwords are rate limited", async () => {
    await call("POST", "/api/auth/configure", { mode: "password", password: "correct horse battery" });
    app.services.access.limiter.success("127.0.0.1");
    let last: Res | null = null;
    for (let i = 0; i < 5; i++) last = await call("POST", "/api/auth/login", { password: `wrong ${i} attempt` });
    expect(last!.status).toBe(429);
    expect(last!.json.retryAfter).toBe(30);
    // Even the right password waits.
    expect((await call("POST", "/api/auth/login", { password: "correct horse battery" })).status).toBe(429);
    app.services.access.limiter.success("127.0.0.1");
    AccessControl.reset(app.services.store);
  });

  test("a revoked browser's event stream ends", async () => {
    const on = await call("POST", "/api/auth/configure", { mode: "password", password: "correct horse battery" });
    const me = on.cookie!;
    const res = await fetch(base + "/api/stream", { headers: { cookie: me } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // hello
    const id = app.services.access.listSessions(null)[0]!.id;
    app.services.access.revokeSession(id);
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return true;
        }
      })(),
      Bun.sleep(2000).then(() => false),
    ]);
    expect(ended).toBe(true);
    AccessControl.reset(app.services.store);
  });
});
