// Routes app events and approval hooks to Discord and web push according to settings.routing.
// Every route defaults off. Nothing here throws into the caller.

import { systemClock, type Clock } from "../core/clock";
import type { ControlApi, Notifier } from "../core/contracts";
import type { Store } from "../core/db";
import type { AppEvent, Approval, NewEvent, NotifyEvent, Settings } from "../core/types";
import { DiscordChannel, type DiscordSendOptions, type DiscordStatus } from "./discord";
import {
  formatApproval,
  formatApprovalReminder,
  formatApprovalResolved,
  formatEvent,
  isNotifyEvent,
  rateKey,
  type OutMessage,
} from "./format";
import { APPROVAL_ACTIONS, PushChannel, type PushPayload, type PushResult } from "./webpush";

export const RATE_LIMIT_MS = 60_000;
const FAILURE_REPORT_MS = 5 * 60_000;
const NEVER_RATE_LIMITED: ReadonlySet<NotifyEvent> = new Set(["guard_tripped", "registered"]);

/** What the router needs from a Discord channel. DiscordChannel implements it; tests pass fakes. */
export interface DiscordSender {
  send(message: OutMessage, options?: DiscordSendOptions): Promise<string>;
  edit(messageId: string, message: OutMessage): Promise<void>;
  status(): DiscordStatus;
  start(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
}

/** What the router needs from the push channel. PushChannel implements it; tests pass fakes. */
export interface PushSenderChannel {
  send(payload: PushPayload, opts?: { urgent?: boolean }): Promise<PushResult>;
  ensureKeys(): unknown;
}

export type RouterStore = Pick<
  Store,
  "getWanted" | "listPushSubscriptions" | "removePushSubscription" | "setApprovalDiscordMessage" | "approvalDiscordMessage"
>;

export interface NotificationRouterDeps {
  store: RouterStore;
  settings: () => Settings;
  updateSettings: (patch: Partial<Settings>) => unknown;
  /** Lazy because the control surface is built after the notifier. May also be set later with setControl(). */
  control?: () => ControlApi | null;
  /** Optional: report channel failures as "info" events. Those are never routed, so no loops. */
  events?: { emit(event: NewEvent): unknown };
  clock?: Clock;
  /** Inject fake channels in tests. */
  channels?: { discord?: DiscordSender; push?: PushSenderChannel };
  log?: (message: string, error?: unknown) => void;
}

export class NotificationRouter implements Notifier {
  private discord: DiscordSender;
  private push: PushSenderChannel;
  private clock: Clock;
  private controlFn: () => ControlApi | null;
  private lastSent = new Map<string, number>();
  private lastFailure = new Map<string, number>();
  private pending = new Set<Promise<unknown>>();
  private lastToken: string | null | undefined = undefined;
  private disposed = false;
  private log: (message: string, error?: unknown) => void;

  constructor(private deps: NotificationRouterDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? ((message, error) => console.warn(`[notify] ${message}`, error ?? ""));
    this.controlFn = deps.control ?? (() => null);
    this.discord =
      deps.channels?.discord ??
      new DiscordChannel({ settings: deps.settings, control: () => this.controlFn(), clock: this.clock });
    this.push =
      deps.channels?.push ?? new PushChannel({ store: deps.store, settings: deps.settings, updateSettings: deps.updateSettings });
  }

  setControl(control: ControlApi | (() => ControlApi | null)): void {
    this.controlFn = typeof control === "function" ? control : () => control;
  }

  /** Connect Discord (if a token is set) and make sure VAPID keys exist. Never throws. */
  async start(): Promise<void> {
    try {
      this.push.ensureKeys();
    } catch (error) {
      this.log("could not create push keys", error);
    }
    this.lastToken = this.deps.settings().discordToken;
    await this.discord.start().catch(error => this.log("discord start failed", error));
  }

  discordStatus(): DiscordStatus {
    return this.discord.status();
  }

  // ---------- Notifier ----------

  handle(event: AppEvent): void {
    try {
      if (this.disposed || !isNotifyEvent(event.kind)) return;
      // approval_needed is delivered by approvalCreated(), which carries the buttons.
      if (event.kind === "approval_needed") return;
      const route = this.route(event.kind);
      if (!route.discord && !route.push) return;
      if (this.rateLimited(event)) return;
      const message = formatEvent(event, this.courseLabel(event.courseId));
      const urgent = event.kind === "guard_tripped" || message.severity === "critical";
      if (route.discord) this.track(this.toDiscord(message, {}, event.kind));
      if (route.push)
        this.track(this.toPush({ ...this.payload(message), requireInteraction: urgent || undefined }, urgent, event.kind));
    } catch (error) {
      this.log("handle failed", error);
    }
  }

  approvalCreated(approval: Approval): void {
    try {
      if (this.disposed) return;
      const route = this.route("approval_needed");
      const message = formatApproval(approval, this.clock.now());
      if (route.discord) {
        this.track(
          this.toDiscord(message, { approvalId: approval.id }, "approval_needed").then(messageId => {
            if (messageId) this.deps.store.setApprovalDiscordMessage(approval.id, messageId);
          }),
        );
      }
      if (route.push) {
        this.track(
          this.toPush(
            { ...this.payload(message), approvalId: approval.id, actions: APPROVAL_ACTIONS, requireInteraction: true },
            true,
            "approval_needed",
          ),
        );
      }
    } catch (error) {
      this.log("approvalCreated failed", error);
    }
  }

  approvalResolved(approval: Approval, resultText: string): void {
    try {
      if (this.disposed) return;
      const message = formatApprovalResolved(approval, resultText);
      const messageId = this.deps.store.approvalDiscordMessage(approval.id);
      // Edit whatever was posted, even if routing changed since.
      if (messageId) {
        this.track(
          this.discord.edit(messageId, message).catch(error => this.reportFailure("discord", error)),
        );
      }
      if (this.route("approval_needed").push) {
        // Same tag replaces the approval notification so stale buttons disappear.
        this.track(this.toPush({ ...this.payload(message), approvalId: approval.id, silent: true }, false, "approval_needed"));
      }
    } catch (error) {
      this.log("approvalResolved failed", error);
    }
  }

  approvalReminder(approval: Approval): void {
    try {
      if (this.disposed) return;
      const route = this.route("approval_needed");
      const message = formatApprovalReminder(approval);
      if (route.discord) {
        const replyTo = this.deps.store.approvalDiscordMessage(approval.id);
        this.track(this.toDiscord(message, { replyTo }, "approval_needed"));
      }
      if (route.push) {
        this.track(
          this.toPush(
            { ...this.payload(message), approvalId: approval.id, actions: APPROVAL_ACTIONS, requireInteraction: true, renotify: true },
            true,
            "approval_needed",
          ),
        );
      }
    } catch (error) {
      this.log("approvalReminder failed", error);
    }
  }

  async test(channel: "discord" | "push"): Promise<{ ok: boolean; detail: string }> {
    const message: OutMessage = {
      title: "Test notification",
      body: "Notifications from UIUC Auto Register reach you here.",
      severity: "info",
      tag: "test",
    };
    try {
      if (channel === "discord") {
        await this.discord.send(message);
        return { ok: true, detail: "Sent a test DM." };
      }
      const result = await this.push.send(this.payload(message));
      return { ok: result.sent > 0, detail: result.detail };
    } catch (error) {
      return { ok: false, detail: (error as Error)?.message ?? String(error) };
    }
  }

  /** Re-read settings. Reconnects Discord only when the token changed or the bot is not connected. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    const token = this.deps.settings().discordToken;
    const state = this.discord.status().state;
    if (token === this.lastToken && (state === "ready" || state === "connecting")) return;
    this.lastToken = token;
    await this.discord.reload().catch(error => this.log("discord reload failed", error));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush(2_000);
    await this.discord.stop().catch(() => {});
  }

  /** Wait for in-flight sends (tests and shutdown). */
  async flush(timeoutMs = 10_000): Promise<void> {
    const all = Promise.allSettled([...this.pending]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise(resolve => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  // ---------- internals ----------

  private route(kind: NotifyEvent) {
    const route = this.deps.settings().routing?.[kind];
    return { discord: route?.discord === true, push: route?.push === true };
  }

  private rateLimited(event: AppEvent): boolean {
    if (NEVER_RATE_LIMITED.has(event.kind as NotifyEvent)) return false;
    const key = rateKey(event);
    const now = this.clock.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < RATE_LIMIT_MS) return true;
    this.lastSent.set(key, now);
    if (this.lastSent.size > 500) {
      for (const [k, t] of this.lastSent) if (now - t >= RATE_LIMIT_MS) this.lastSent.delete(k);
    }
    return false;
  }

  private courseLabel(courseId: number | null): string | null {
    if (courseId === null || courseId === undefined) return null;
    try {
      const course = this.deps.store.getWanted(courseId);
      return course ? `${course.subject} ${course.number}` : null;
    } catch {
      return null;
    }
  }

  private payload(message: OutMessage): PushPayload {
    return { title: message.title, body: message.body, tag: message.tag, url: "/", severity: message.severity };
  }

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(error => this.log("send failed", error)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private async toDiscord(message: OutMessage, options: DiscordSendOptions, kind: NotifyEvent): Promise<string | null> {
    try {
      return await this.discord.send(message, options);
    } catch (error) {
      this.reportFailure("discord", error, kind);
      return null;
    }
  }

  private async toPush(payload: PushPayload, urgent: boolean, kind: NotifyEvent): Promise<void> {
    try {
      const result = await this.push.send(payload, { urgent });
      if (result.sent === 0 && result.failed > 0) this.reportFailure("push", new Error(result.detail), kind);
    } catch (error) {
      this.reportFailure("push", error, kind);
    }
  }

  /** Log every failure, and emit at most one "info" event per channel every five minutes. */
  private reportFailure(channel: "discord" | "push", error: unknown, kind?: NotifyEvent): void {
    const detail = (error as Error)?.message ?? String(error);
    this.log(`${channel} delivery failed${kind ? ` (${kind})` : ""}: ${detail}`);
    if (!this.deps.events) return;
    const now = this.clock.now();
    const last = this.lastFailure.get(channel);
    if (last !== undefined && now - last < FAILURE_REPORT_MS) return;
    this.lastFailure.set(channel, now);
    try {
      // "info" is not a NotifyEvent, so handle() ignores it and this cannot loop.
      this.deps.events.emit({
        kind: "info",
        severity: "warning",
        title: channel === "discord" ? "Discord notification failed" : "Push notification failed",
        detail,
        payload: { channel, event: kind ?? null },
      });
    } catch (emitError) {
      this.log("could not record failure event", emitError);
    }
  }
}
