import { beforeEach, describe, expect, test } from "bun:test";
import { Store, defaultSettings } from "../../src/core/db";
import type { Settings } from "../../src/core/types";
import { PushChannel, type PushSender } from "../../src/notify/webpush";

function subscription(endpoint: string) {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

let store: Store;
let settings: Settings;

beforeEach(() => {
  store = new Store(":memory:");
  settings = defaultSettings();
});

function channel(sender: PushSender, generateKeys = () => ({ publicKey: "pub", privateKey: "priv" })) {
  return new PushChannel({
    store,
    settings: () => settings,
    updateSettings: patch => Object.assign(settings, patch),
    sender,
    generateKeys,
  });
}

describe("web push", () => {
  test("generates VAPID keys once and stores them", () => {
    let generated = 0;
    const push = channel(async () => {}, () => (generated++, { publicKey: "pub", privateKey: "priv" }));
    push.ensureKeys();
    push.ensureKeys();
    expect(generated).toBe(1);
    expect(settings.vapidPublicKey).toBe("pub");
    expect(settings.vapidPrivateKey).toBe("priv");
  });

  test("removes subscriptions that answer 404 or 410 and keeps the rest", async () => {
    store.addPushSubscription(subscription("https://push.example/gone"));
    store.addPushSubscription(subscription("https://push.example/missing"));
    store.addPushSubscription(subscription("https://push.example/ok"));
    store.addPushSubscription(subscription("https://push.example/flaky"));
    const payloads: string[] = [];
    const push = channel(async (sub, payload, options) => {
      payloads.push(payload);
      expect(options.vapidDetails?.publicKey).toBe("pub");
      if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (sub.endpoint.endsWith("/missing")) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      if (sub.endpoint.endsWith("/flaky")) throw Object.assign(new Error("Server error"), { statusCode: 500 });
    });
    const result = await push.send({ title: "Registered for CS 225", body: "CRN 59777", tag: "t", url: "/" });
    expect(result).toMatchObject({ sent: 1, removed: 2, failed: 1 });
    expect(store.listPushSubscriptions().map(s => s.endpoint).sort()).toEqual(["https://push.example/flaky", "https://push.example/ok"]);
    expect(JSON.parse(payloads[0]!)).toEqual({ title: "Registered for CS 225", body: "CRN 59777", tag: "t", url: "/" });
  });

  test("no subscriptions is reported, not thrown", async () => {
    const result = await channel(async () => {}).send({ title: "t", body: "b", tag: "t", url: "/" });
    expect(result.sent).toBe(0);
    expect(result.detail).toContain("No browsers");
  });
});
