import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/db";
import { ephemeralCipher, loadKeyFile } from "../../src/core/secrets";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "uar-secrets-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("round trip, fresh IV each time, tamper detected", () => {
  const c = ephemeralCipher();
  const a = c.encrypt("hunter2");
  const b = c.encrypt("hunter2");
  expect(a).not.toBe(b);
  expect(c.decrypt(a)).toBe("hunter2");
  const parts = a.split(":");
  parts[3] = Buffer.from("tampered").toString("base64url");
  expect(c.decrypt(parts.join(":"))).toBeNull();
  expect(ephemeralCipher().decrypt(a)).toBeNull();
  expect(c.decrypt("garbage")).toBeNull();
});

test("the key file is created once with mode 0600 and reused", () => {
  const dir = tempDir();
  const key = loadKeyFile(dir);
  expect(key.length).toBe(32);
  expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
  expect(loadKeyFile(dir).equals(key)).toBe(true);
});

test("secrets are encrypted on disk and survive reopening", () => {
  const dir = tempDir();
  const store = Store.open(dir);
  store.updateSettings({ netid: "jdoe2", password: "hunter2-Secret!", totpSecret: "JBSWY3DPEHPK3PXP", discordToken: "tok".repeat(20) });
  const raw = JSON.stringify(store.db.query("SELECT key, value FROM settings").all());
  expect(raw).not.toContain("hunter2");
  expect(raw).not.toContain("JBSWY3DPEHPK3PXP");
  expect(raw).not.toContain("toktok");
  expect(raw).toContain("jdoe2"); // the NetID is not a secret
  store.close();
  const again = Store.open(dir);
  const s = again.getSettings();
  expect(s.password).toBe("hunter2-Secret!");
  expect(s.totpSecret).toBe("JBSWY3DPEHPK3PXP");
  const pub = again.publicSettings() as Record<string, unknown>;
  expect(pub.password).toBeUndefined();
  expect(pub.totpSecret).toBeUndefined();
  expect(pub.passwordSet).toBe(true);
  expect(pub.totpSet).toBe(true);
  again.close();
});

test("a lost key reads secrets as null with one warning", () => {
  const dir = tempDir();
  const store = Store.open(dir);
  store.updateSettings({ password: "pw", totpSecret: "JBSWY3DPEHPK3PXP" });
  store.close();
  rmSync(join(dir, "secret.key"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const again = Store.open(dir);
    expect(again.getSettings().password).toBeNull();
    expect(again.getSettings().totpSecret).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    again.close();
  } finally {
    warn.mockRestore();
  }
});

test("plaintext secrets from before encryption are sealed on open", () => {
  const dir = tempDir();
  const first = Store.open(dir);
  first.db.query("INSERT INTO settings (key, value) VALUES ('discordToken', ?)").run(JSON.stringify("plain-token-abcd"));
  first.close();
  const reopened = Store.open(dir);
  expect(JSON.stringify(reopened.db.query("SELECT value FROM settings WHERE key = 'discordToken'").get())).not.toContain("plain-token");
  expect(reopened.getSettings().discordToken).toBe("plain-token-abcd");
  reopened.close();
});

test("defaults: Live mode and setup not done", () => {
  const s = new Store(":memory:").getSettings();
  expect(s.mode).toBe("live");
  expect(s.onboardingStep).toBe("account");
  expect(s.netid).toBeNull();
});
