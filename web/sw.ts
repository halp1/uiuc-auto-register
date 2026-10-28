/// <reference lib="webworker" />
// Service worker for web push. Served at /sw.js. Self-contained: no imports.

export {};

declare const self: ServiceWorkerGlobalScope;

interface PushData {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  severity?: string;
  approvalId?: number;
  actions?: { action: string; title: string }[];
  requireInteraction?: boolean;
  silent?: boolean;
  renotify?: boolean;
}

interface NotificationData {
  url: string;
  approvalId: number | null;
}


self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

function parse(event: PushEvent): PushData {
  if (!event.data) return {};
  try {
    return event.data.json() as PushData;
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", event => {
  const data = parse(event);
  const approvalId = typeof data.approvalId === "number" ? data.approvalId : null;
  const hasActions = approvalId !== null && Array.isArray(data.actions) && data.actions.length > 0;
  const options: NotificationOptions & { actions?: { action: string; title: string }[]; renotify?: boolean } = {
    body: data.body ?? "",
    tag: data.tag,
    data: { url: data.url || "/", approvalId } satisfies NotificationData,
    requireInteraction: Boolean(data.requireInteraction || hasActions || data.severity === "critical"),
    silent: Boolean(data.silent),
  };
  if (hasActions) options.actions = data.actions!.slice(0, 2);
  if (data.renotify && data.tag) options.renotify = true;
  event.waitUntil(self.registration.showNotification(data.title || "UIUC Auto Register", options));
});

async function openApp(url: string): Promise<void> {
  const target = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === self.location.origin) {
      await client.focus();
      if (client.url !== target && "navigate" in client) await client.navigate(target).catch(() => null);
      return;
    }
  }
  await self.clients.openWindow(target);
}

async function act(approvalId: number, action: "approve" | "skip", tag: string | undefined): Promise<void> {
  let title = action === "approve" ? "Registration" : "Skipped";
  let body: string;
  try {
    const response = await fetch(`/api/approvals/${approvalId}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-auto-register": "1" },
      body: "{}",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // Usually a Cloudflare Access login page: the session cookie expired.
      title = "Open the app to continue";
      body = "Your sign-in expired. Open the dashboard and try again.";
    } else {
      const result = (await response.json()) as { ok?: boolean; detail?: string; error?: string };
      if (response.ok && result.ok) {
        title = action === "approve" ? "Registered" : "Skipped";
        body = result.detail || "Done";
      } else {
        title = action === "approve" ? "Not registered" : "Could not skip";
        body = result.detail || result.error || `Request failed (${response.status})`;
      }
    }
  } catch {
    title = "Could not reach the app";
    body = "Open the dashboard and try again.";
  }
  await self.registration.showNotification(title, {
    body,
    tag: tag || `approval-${approvalId}`,
    data: { url: "/", approvalId: null } satisfies NotificationData,
  });
}

self.addEventListener("notificationclick", event => {
  const notification = event.notification;
  const data = (notification.data ?? {}) as Partial<NotificationData>;
  notification.close();
  const action = event.action;
  if ((action === "approve" || action === "skip") && typeof data.approvalId === "number") {
    event.waitUntil(act(data.approvalId, action, notification.tag));
    return;
  }
  event.waitUntil(openApp(data.url || "/"));
});
