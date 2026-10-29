import { beforeEach, describe, expect, test } from "bun:test";
import { FakeClock } from "../../src/core/clock";
import { Store, defaultSettings } from "../../src/core/db";
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
  test("every route defaults off, so nothing is sent on any channel", async () => {
    for (const kind of ["bundle_opened", "registered", "registration_failed", "session_error", "guard_tripped", "poller_degraded", "restarted"] as const) {
      router.handle(event(kind, { bundleId: 1, crns: ["59777"] }));
    }
    router.approvalCreated(approval());
    router.approvalReminder(approval());
    router.approvalResolved({ ...approval(), state: "approved" }, "Registered.");
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
    expect(webhook.sent).toHaveLength(0);
  });

  test("routes only to the enabled channel, with the course label", async () => {
    const course = store.createWanted({ term: "120271", subject: "CS", number: "225", title: "Data Structures", kind: "bundles" });
    enable("registered", { discord: true });
    enable("session_error", { push: true });
    router.handle(event("registered", { courseId: course.id, crns: ["59777", "31225"], bundleId: 1, severity: "success" }));
    router.handle(event("session_error", { title: "Login failed", detail: "TOTP rejected" }));
    await router.flush();
    expect(discord.sent).toHaveLength(1);
    expect(push.sent).toHaveLength(1);
    expect(webhook.sent).toHaveLength(0);
    expect(discord.sent[0]!.message.title).toContain("CS 225");
    expect(discord.sent[0]!.message.body).toContain("59777");
    expect(discord.sent[0]!.message.severity).toBe("success");
    expect(push.sent[0]!.payload.url).toBe("/");
  });

  test("ignores non-notify kinds and approval_needed events (approvalCreated carries those)", async () => {
    enable("registered", { discord: true, push: true, webhook: true });
    enable("approval_needed", { discord: true, push: true, webhook: true });
    router.handle(event("seat_changed"));
    router.handle(event("info"));
    router.handle(event("approval_needed", { bundleId: 1 }));
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
    expect(webhook.sent).toHaveLength(0);
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
  test("approvalCreated sends Discord buttons and push actions, and resolution edits the stored message", async () => {
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

  test("reminder respects routing", async () => {
    router.approvalReminder(approval());
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
    enable("approval_needed", { push: true });
    router.approvalReminder(approval());
    await router.flush();
    expect(discord.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload).toMatchObject({ approvalId: 7, renotify: true });
  });

  test("webhook gets events, approvals, reminders, and resolutions but no buttons", async () => {
    enable("registered", { webhook: true });
    enable("approval_needed", { webhook: true });
    router.handle(event("registered", { bundleId: 2, crns: ["59777"] }));
    router.approvalCreated(approval());
    router.approvalReminder(approval());
    router.approvalResolved({ ...approval(), state: "approved" }, "Registered.");
    await router.flush();
    expect(webhook.sent.map(m => m.tag)).toEqual(["registered:b2", "approval-7", "approval-7", "approval-7"]);
    expect(discord.sent).toEqual([]);
    expect(push.sent).toEqual([]);
  });
});

describe("failures and controls", () => {
  test.each(["discord", "webhook"] as const)("%s failures never throw and are reported as throttled info events", async channel => {
    enable("restarted", { [channel]: true });
    (channel === "discord" ? discord : webhook).fail = new Error("down");
    expect(() => router.handle(event("restarted"))).not.toThrow();
    await clock.advance(RATE_LIMIT_MS);
    router.handle(event("restarted"));
    await router.flush();
    expect(emitted).toHaveLength(1);
    // "info" is never routed, so a failure report cannot loop back into the router.
    expect(emitted[0]!.kind).toBe("info");
    expect(emitted[0]!.payload).toEqual({ channel, event: "restarted" });
  });

  test("test() reports success and failure per channel", async () => {
    expect((await router.test("discord")).ok).toBe(true);
    expect((await router.test("push")).ok).toBe(true);
    expect((await router.test("webhook")).ok).toBe(true);
    expect(webhook.sent).toHaveLength(1);
    discord.fail = new Error("Add your Discord user ID in settings.");
    expect(await router.test("discord")).toEqual({ ok: false, detail: "Add your Discord user ID in settings." });
  });

  test("reload reconnects only when the token changes", async () => {
    await router.start();
    await router.reload();
    expect(discord.reloads).toBe(0);
    settings.discordToken = "x".repeat(40);
    await router.reload();
    expect(discord.reloads).toBe(1);
  });
});

describe("webhook channel", () => {
  const URL_OK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
  const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789";

  test.each([
    ["canonical", URL_OK],
    ["discordapp.com", URL_OK.replace("discord.com", "discordapp.com")],
    ["canary host with API version", URL_OK.replace("discord.com/api", "canary.discord.com/api/v10")],
  ])("normalizes %s URLs", (_name, raw) => {
    expect(normalizeWebhookUrl(raw)).toBe(URL_OK);
  });

  test.each([
    ["plain http", `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["other host", `https://evil.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["lookalike host", `https://discord.com.evil.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["short id and token", "https://discord.com/api/webhooks/123/short"],
    ["empty", ""],
    ["null", null],
  ])("rejects %s URLs", (_name, raw) => {
    expect(normalizeWebhookUrl(raw)).toBeNull();
  });

  test("posts an embed with mentions disabled and retries once on 429", async () => {
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
    expect(webhookBody({ title: "t".repeat(300), body: "", severity: "info", tag: "t" }).embeds[0]!.title).toHaveLength(256);
  });

  test("a deleted webhook or a missing URL refuses to send", async () => {
    let fetched = 0;
    const gone = new WebhookChannel({ settings: () => ({ discordWebhookUrl: URL_OK }), fetch: async () => new Response("", { status: 404 }) });
    await expect(gone.send({ title: "x", body: "", severity: "info", tag: "t" })).rejects.toThrow();
    const none = new WebhookChannel({ settings: () => ({ discordWebhookUrl: null }), fetch: async () => (fetched++, new Response("")) });
    await expect(none.send({ title: "x", body: "", severity: "info", tag: "t" })).rejects.toThrow();
    expect(fetched).toBe(0);
  });

  test("stored routing from before webhooks gains webhook: false", () => {
    const s = new Store(":memory:");
    s.db.query("INSERT INTO settings (key, value) VALUES ('routing', ?)").run(JSON.stringify({ registered: { discord: true, push: false } }));
    expect(s.getSettings().routing.registered).toEqual({ discord: true, push: false, webhook: false });
  });
});
