import { beforeEach, describe, expect, test } from "bun:test";
import { FakeClock } from "../../src/core/clock";
import { Store, defaultSettings } from "../../src/core/db";
import type { ControlApi } from "../../src/core/contracts";
import type { AppEvent, Approval, NewEvent, NotifyEvent, Settings } from "../../src/core/types";
import type { DiscordSendOptions, DiscordStatus } from "../../src/notify/discord";
import type { OutMessage } from "../../src/notify/format";
import { NotificationRouter, RATE_LIMIT_MS, type DiscordSender, type PushSenderChannel } from "../../src/notify/router";
import type { PushPayload, PushResult } from "../../src/notify/webpush";
import { WebhookChannel, normalizeWebhookUrl, webhookBody, type WebhookSender } from "../../src/notify/webhook";

class FakeWebhook implements WebhookSender {
  sent: OutMessage[] = [];
  fail: Error | null = null;
  async send(message: OutMessage) {
    if (this.fail) throw this.fail;
    this.sent.push(message);
  }
}

class FakeDiscord implements DiscordSender {
  sent: { message: OutMessage; options: DiscordSendOptions }[] = [];
  edits: { messageId: string; message: OutMessage }[] = [];
  fail: Error | null = null;
  reloads = 0;
  async send(message: OutMessage, options: DiscordSendOptions = {}) {
    if (this.fail) throw this.fail;
    this.sent.push({ message, options });
    return `msg-${this.sent.length}`;
  }
  async edit(messageId: string, message: OutMessage) {
    this.edits.push({ messageId, message });
  }
  status(): DiscordStatus {
    return { state: "ready", detail: null };
  }
  async start() {}
  async reload() {
    this.reloads++;
  }
  async stop() {}
}

class FakePush implements PushSenderChannel {
  sent: { payload: PushPayload; urgent: boolean }[] = [];
  async send(payload: PushPayload, opts: { urgent?: boolean } = {}): Promise<PushResult> {
    this.sent.push({ payload, urgent: Boolean(opts.urgent) });
    return { sent: 1, removed: 0, failed: 0, detail: "Sent to 1 of 1 browser." };
  }
  ensureKeys() {}
}

let store: Store;
let settings: Settings;
let discord: FakeDiscord;
let push: FakePush;
let webhook: FakeWebhook;
let clock: FakeClock;
let emitted: NewEvent[];
let router: NotificationRouter;
let nextId = 1;

function event(kind: AppEvent["kind"], extra: Partial<AppEvent> = {}): AppEvent {
  return {
    id: nextId++,
    ts: clock.now(),
    kind,
    severity: "info",
    title: kind,
    detail: null,
    courseId: null,
    bundleId: null,
    crns: [],
    payload: null,
    ...extra,
  };
}

function enable(kind: NotifyEvent, route: { discord?: boolean; push?: boolean; webhook?: boolean }) {
  settings.routing[kind] = { discord: Boolean(route.discord), push: Boolean(route.push), webhook: Boolean(route.webhook) };
}

function approval(extra: Partial<Approval> = {}): Approval {
  return {
    id: 7,
    bundleId: 3,
    courseId: 1,
    crns: ["59777", "31225"],
    label: "CS 225 AL1 + AYB",
    state: "pending",
    createdAt: clock.now(),
    remindAt: null,
    autoAt: null,
    resolvedAt: null,
    ...extra,
  };
}

beforeEach(() => {
  store = new Store(":memory:");
  settings = defaultSettings();
  discord = new FakeDiscord();
  push = new FakePush();
  webhook = new FakeWebhook();
  clock = new FakeClock();
  emitted = [];
  router = new NotificationRouter({
    store,
    settings: () => settings,
    updateSettings: patch => Object.assign(settings, patch),
    clock,
    events: { emit: e => emitted.push(e) },
    channels: { discord, push, webhook },
    log: () => {},
  });
});

describe("routing", () => {
  test("every route defaults off, so nothing is sent", async () => {
    for (const kind of ["bundle_opened", "registered", "registration_failed", "session_error", "guard_tripped", "poller_degraded", "restarted"] as const) {
      router.handle(event(kind, { bundleId: 1, crns: ["59777"] }));
    }
    router.approvalCreated(approval());
    router.approvalReminder(approval());
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
  });

  test("routes only to the enabled channel", async () => {
    enable("registered", { discord: true });
    enable("session_error", { push: true });
    router.handle(event("registered", { crns: ["59777"], bundleId: 1 }));
    router.handle(event("session_error", { title: "Login failed", detail: "TOTP rejected" }));
    await router.flush();
    expect(discord.sent).toHaveLength(1);
    expect(push.sent).toHaveLength(1);
    expect(discord.sent[0]!.message.body).toContain("CRN 59777");
    expect(push.sent[0]!.payload.title).toBe("Banner session error");
    expect(push.sent[0]!.payload.url).toBe("/");
  });

  test("uses the course label in titles", async () => {
    const course = store.createWanted({ term: "120271", subject: "CS", number: "225", title: "Data Structures", kind: "bundles" });
    enable("registered", { discord: true });
    router.handle(event("registered", { courseId: course.id, crns: ["59777", "31225"], bundleId: 1, severity: "success" }));
    await router.flush();
    expect(discord.sent[0]!.message.title).toBe("Registered for CS 225");
    expect(discord.sent[0]!.message.body).toBe("CRNs 59777, 31225");
    expect(discord.sent[0]!.message.severity).toBe("success");
  });

  test("ignores non-notify kinds even if they look similar", async () => {
    enable("registered", { discord: true, push: true });
    router.handle(event("seat_changed"));
    router.handle(event("info"));
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
  });

  test("guard_tripped push is urgent and requires interaction", async () => {
    enable("guard_tripped", { push: true });
    router.handle(event("guard_tripped", { severity: "warning", detail: "Schedule changed unexpectedly" }));
    await router.flush();
    expect(push.sent[0]!.urgent).toBe(true);
    expect(push.sent[0]!.payload.requireInteraction).toBe(true);
  });
});

describe("rate limiting", () => {
  test("identical kind and bundle sends once per minute", async () => {
    enable("bundle_opened", { discord: true });
    router.handle(event("bundle_opened", { bundleId: 4 }));
    router.handle(event("bundle_opened", { bundleId: 4 }));
    router.handle(event("bundle_opened", { bundleId: 5 }));
    await router.flush();
    expect(discord.sent).toHaveLength(2);
    await clock.advance(RATE_LIMIT_MS);
    router.handle(event("bundle_opened", { bundleId: 4 }));
    await router.flush();
    expect(discord.sent).toHaveLength(3);
  });

  test("guard_tripped and registered are never rate limited", async () => {
    enable("guard_tripped", { discord: true });
    enable("registered", { discord: true });
    for (let i = 0; i < 3; i++) {
      router.handle(event("guard_tripped"));
      router.handle(event("registered", { bundleId: 2 }));
    }
    await router.flush();
    expect(discord.sent).toHaveLength(6);
  });
});

describe("approvals", () => {
  test("approvalCreated sends Discord buttons and push actions, and stores the message id", async () => {
    enable("approval_needed", { discord: true, push: true });
    const course = store.createWanted({ term: "120271", subject: "CS", number: "225", title: "", kind: "bundles" });
    const [bundle] = store.setBundles(course.id, [{ crns: ["59777"] }]);
    const saved = store.createApproval({ bundleId: bundle!.id, courseId: course.id, crns: ["59777"], label: "CS 225 AL1", createdAt: clock.now(), remindAt: null, autoAt: null });
    router.approvalCreated(saved);
    await router.flush();
    expect(discord.sent[0]!.options.approvalId).toBe(saved.id);
    expect(store.approvalDiscordMessage(saved.id)).toBe("msg-1");
    const payload = push.sent[0]!.payload;
    expect(payload.approvalId).toBe(saved.id);
    expect(payload.actions?.map(a => a.action)).toEqual(["approve", "skip"]);
    expect(payload.requireInteraction).toBe(true);

    router.approvalResolved({ ...saved, state: "approved" }, "Registered for CS 225 AL1");
    await router.flush();
    expect(discord.edits).toEqual([{ messageId: "msg-1", message: expect.objectContaining({ body: expect.stringContaining("Registered for CS 225 AL1") }) }]);
  });

  test("approval_needed events do not double-notify", async () => {
    enable("approval_needed", { discord: true, push: true });
    router.handle(event("approval_needed", { bundleId: 1 }));
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
  });

  test("reminder respects routing", async () => {
    router.approvalReminder(approval());
    enable("approval_needed", { push: true });
    router.approvalReminder(approval());
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.title).toContain("Still waiting");
  });
});

describe("failures and controls", () => {
  test("channel failures never throw and are reported as unrouted info events, throttled", async () => {
    enable("restarted", { discord: true });
    discord.fail = new Error("Discord is not connected.");
    expect(() => router.handle(event("restarted"))).not.toThrow();
    await clock.advance(RATE_LIMIT_MS);
    router.handle(event("restarted"));
    await router.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.kind).toBe("info");
  });

  test("test() reports success and failure", async () => {
    expect(await router.test("discord")).toEqual({ ok: true, detail: "Sent a test DM." });
    expect((await router.test("push")).ok).toBe(true);
    discord.fail = new Error("Add your Discord user ID in settings.");
    expect(await router.test("discord")).toEqual({ ok: false, detail: "Add your Discord user ID in settings." });
  });

  test("reload reconnects when the token changes", async () => {
    await router.start();
    settings.discordToken = "x".repeat(40);
    await router.reload();
    expect(discord.reloads).toBe(1);
  });

  test("setControl is accepted lazily", () => {
    const control: ControlApi = {
      approve: async () => ({ ok: true, detail: "" }),
      skip: async () => ({ ok: true, detail: "" }),
      pauseAll: () => {},
      resumeAll: () => {},
      statusText: () => "ok",
    };
    expect(() => router.setControl(() => control)).not.toThrow();
  });
});


describe("discord webhook", () => {
  const URL_OK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

  test("off by default for every event", async () => {
    for (const kind of ["bundle_opened", "registered", "guard_tripped"] as const) router.handle(event(kind, { bundleId: 1 }));
    router.approvalCreated(approval());
    await router.flush();
    expect(webhook.sent).toEqual([]);
    expect(Object.values(defaultSettings().routing).every(r => r.webhook === false)).toBe(true);
  });

  test("routes events, approvals, reminders, and resolutions when enabled", async () => {
    enable("registered", { webhook: true });
    enable("approval_needed", { webhook: true });
    router.handle(event("registered", { bundleId: 2, crns: ["59777"] }));
    router.approvalCreated(approval());
    router.approvalReminder(approval());
    router.approvalResolved({ ...approval(), state: "approved" }, "Registered.");
    await router.flush();
    expect(webhook.sent.map(m => m.title)).toEqual(["registered", "Approve CS 225 AL1 + AYB?", "Still waiting: CS 225 AL1 + AYB", "CS 225 AL1 + AYB"]);
    expect(webhook.sent[1]!.body).toContain("Register or skip it in the app.");
    expect(discord.sent).toEqual([]);
  });

  test("failures are reported, never thrown", async () => {
    enable("registered", { webhook: true });
    webhook.fail = new Error("gone");
    router.handle(event("registered", { bundleId: 2 }));
    await router.flush();
    expect(emitted.some(e => e.title === "Discord webhook notification failed")).toBe(true);
  });

  test("test() posts to the webhook", async () => {
    expect(await router.test("webhook")).toEqual({ ok: true, detail: "Posted a test message to the channel." });
  });

  test("URL validation normalizes Discord hosts and rejects everything else", () => {
    expect(normalizeWebhookUrl(URL_OK)).toBe(URL_OK);
    expect(normalizeWebhookUrl(URL_OK.replace("discord.com", "discordapp.com"))).toBe(URL_OK);
    expect(normalizeWebhookUrl(URL_OK.replace("discord.com/api", "canary.discord.com/api/v10"))).toBe(URL_OK);
    for (const bad of [
      "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789",
      "https://evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789",
      "https://discord.com.evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789",
      "https://discord.com/api/webhooks/123/short",
      "",
      null,
    ]) expect(normalizeWebhookUrl(bad)).toBeNull();
  });

  test("channel posts an embed with mentions disabled and retries once on 429", async () => {
    const calls: { url: string; body: any }[] = [];
    let first = true;
    const channel = new WebhookChannel({
      settings: () => ({ discordWebhookUrl: URL_OK }),
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        if (first) {
          first = false;
          return new Response(JSON.stringify({ retry_after: 0.5 }), { status: 429 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    await channel.send({ title: "Seat open in CS 225 @everyone", body: "CRN 59777", severity: "success", tag: "t" });
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toBe(`${URL_OK}?wait=true`);
    expect(calls[1]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(calls[1]!.body.embeds[0]).toMatchObject({ title: "Seat open in CS 225 @everyone", description: "CRN 59777" });
  });

  test("a deleted webhook gives a clear error, and no URL refuses to send", async () => {
    const gone = new WebhookChannel({ settings: () => ({ discordWebhookUrl: URL_OK }), fetch: async () => new Response("", { status: 404 }) });
    await expect(gone.send({ title: "x", body: "", severity: "info", tag: "t" })).rejects.toThrow("deleted");
    const none = new WebhookChannel({ settings: () => ({ discordWebhookUrl: null }), fetch: async () => new Response("") });
    await expect(none.send({ title: "x", body: "", severity: "info", tag: "t" })).rejects.toThrow("Add a Discord webhook URL");
    expect(webhookBody({ title: "t".repeat(300), body: "", severity: "info", tag: "t" }).embeds[0]!.title).toHaveLength(256);
  });

  test("the webhook URL never reaches the client", () => {
    const s = new Store(":memory:");
    s.updateSettings({ discordWebhookUrl: URL_OK });
    const pub = s.publicSettings() as any;
    expect(pub.discordWebhookUrl).toBeUndefined();
    expect(pub.discordWebhookHint).toBe("GHIJ");
    expect(JSON.stringify(pub)).not.toContain("abcdefghij");
  });

  test("stored routing from before webhooks gains webhook: false", () => {
    const s = new Store(":memory:");
    s.db.query("INSERT INTO settings (key, value) VALUES ('routing', ?)").run(JSON.stringify({ registered: { discord: true, push: false } }));
    expect(s.getSettings().routing.registered).toEqual({ discord: true, push: false, webhook: false });
  });
});
