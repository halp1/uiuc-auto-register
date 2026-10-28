// Browser web push via VAPID. Keys are generated on first use and kept in settings.

import webpush from "web-push";
import type { Settings } from "../core/types";

export const VAPID_SUBJECT = "mailto:uiuc-auto-register@localhost";

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  severity?: string;
  approvalId?: number;
  actions?: { action: "approve" | "skip"; title: string }[];
  requireInteraction?: boolean;
  /** Replace a notification with the same tag without sound or vibration. */
  silent?: boolean;
  /** Alert again even though a notification with this tag is showing. */
  renotify?: boolean;
}

export const APPROVAL_ACTIONS: NonNullable<PushPayload["actions"]> = [
  { action: "approve", title: "Register" },
  { action: "skip", title: "Skip" },
];

export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export interface PushStore {
  listPushSubscriptions(): any[];
  removePushSubscription(endpoint: string): void;
}

export interface PushChannelDeps {
  store: PushStore;
  settings: () => Settings;
  updateSettings: (patch: Partial<Settings>) => unknown;
  /** Injected in tests. Defaults to webpush.sendNotification. */
  sender?: PushSender;
  generateKeys?: () => { publicKey: string; privateKey: string };
  subject?: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
  detail: string;
}

function statusOf(error: unknown): number | null {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

export class PushChannel {
  private sender: PushSender;
  private generateKeys: () => { publicKey: string; privateKey: string };

  constructor(private deps: PushChannelDeps) {
    this.sender = deps.sender ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
    this.generateKeys = deps.generateKeys ?? (() => webpush.generateVAPIDKeys());
  }

  /** Make sure VAPID keys exist. Safe to call at startup so /api/push/vapid can answer. */
  ensureKeys(): { publicKey: string; privateKey: string } {
    const settings = this.deps.settings();
    if (settings.vapidPublicKey && settings.vapidPrivateKey) {
      return { publicKey: settings.vapidPublicKey, privateKey: settings.vapidPrivateKey };
    }
    const keys = this.generateKeys();
    this.deps.updateSettings({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey });
    return keys;
  }

  subscriptionCount(): number {
    return this.deps.store.listPushSubscriptions().length;
  }

  /** Send to every subscription. Never throws. Drops subscriptions the push service says are gone. */
  async send(payload: PushPayload, opts: { urgent?: boolean } = {}): Promise<PushResult> {
    let keys: { publicKey: string; privateKey: string };
    try {
      keys = this.ensureKeys();
    } catch (error) {
      return { sent: 0, removed: 0, failed: 0, detail: `Push keys unavailable: ${(error as Error).message}` };
    }
    const subscriptions = this.deps.store.listPushSubscriptions();
    if (subscriptions.length === 0) {
      return { sent: 0, removed: 0, failed: 0, detail: "No browsers are subscribed. Turn on push in this browser first." };
    }
    const options: webpush.RequestOptions = {
      vapidDetails: { subject: this.deps.subject ?? VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: opts.urgent ? 60 * 60 : 6 * 60 * 60,
      urgency: opts.urgent ? "high" : "normal",
      timeout: 10_000,
    };
    const body = JSON.stringify(payload);
    let sent = 0;
    let removed = 0;
    let failed = 0;
    const errors: string[] = [];
    await Promise.all(
      subscriptions.map(async subscription => {
        try {
          await this.sender(subscription, body, options);
          sent++;
        } catch (error) {
          const status = statusOf(error);
          if (status === 404 || status === 410) {
            removed++;
            try {
              this.deps.store.removePushSubscription(subscription.endpoint);
            } catch {
              // ignore, it will be retried next send
            }
          } else {
            failed++;
            errors.push(status ? `HTTP ${status}` : (error as Error)?.message ?? String(error));
          }
        }
      }),
    );
    const parts = [`Sent to ${sent} of ${subscriptions.length} ${subscriptions.length === 1 ? "browser" : "browsers"}.`];
    if (removed) parts.push(`Removed ${removed} expired ${removed === 1 ? "subscription" : "subscriptions"}.`);
    if (failed) parts.push(`${failed} failed (${[...new Set(errors)].join(", ")}).`);
    return { sent, removed, failed, detail: parts.join(" ") };
  }
}
