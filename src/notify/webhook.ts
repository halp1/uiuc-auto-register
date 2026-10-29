// Discord channel webhook: posts embeds to one channel. Outbound only, so it carries no buttons.
// The webhook URL is a secret (anyone holding it can post), so it is never logged or sent to the client.

import type { Settings } from "../core/types";
import { SEVERITY_COLORS, type OutMessage } from "./format";

const WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,22})\/([A-Za-z0-9_-]{30,100})\/?$/;

/** The canonical webhook URL, or null when it is not a Discord webhook. */
export function normalizeWebhookUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = WEBHOOK_URL.exec(raw.trim());
  return match ? `https://discord.com/api/webhooks/${match[1]}/${match[2]}` : null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface WebhookSender {
  send(message: OutMessage): Promise<void>;
}

export interface WebhookChannelDeps {
  settings: () => Pick<Settings, "discordWebhookUrl">;
  fetch?: FetchLike;
  /** Waits between retries after a 429 (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

export function webhookBody(message: OutMessage) {
  const embed: Record<string, unknown> = { title: message.title.slice(0, 256), color: SEVERITY_COLORS[message.severity] };
  if (message.body) embed.description = message.body.slice(0, 4000);
  // No mentions can ever be triggered by course titles or Banner messages.
  return { username: "YUAR", embeds: [embed], allowed_mentions: { parse: [] } };
}

export class WebhookChannel implements WebhookSender {
  private fetchImpl: FetchLike;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: WebhookChannelDeps) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? (ms => Bun.sleep(ms));
  }

  async send(message: OutMessage): Promise<void> {
    const url = normalizeWebhookUrl(this.deps.settings().discordWebhookUrl);
    if (!url) throw new WebhookError("Add a Discord webhook URL in settings.");
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${url}?wait=true`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(webhookBody(message)),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new WebhookError("Could not reach Discord.");
      }
      if (res.ok) return;
      if (res.status === 429) {
        if (attempt === 2) break;
        const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
        const seconds = Number(body?.retry_after ?? res.headers.get("retry-after") ?? 1);
        await this.sleep(Math.min(10_000, Math.max(250, (Number.isFinite(seconds) ? seconds : 1) * 1000)));
        continue;
      }
      if (res.status === 401 || res.status === 404) throw new WebhookError("Discord does not know that webhook. It may have been deleted. Paste a new URL.");
      throw new WebhookError(`Discord answered HTTP ${res.status}.`);
    }
    throw new WebhookError("Discord is rate limiting the webhook.");
  }
}
