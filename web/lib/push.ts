import { useEffect, useState } from "react";
import { api } from "./api";

export type PushState = "unsupported" | "denied" | "off" | "on" | "checking";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIos() {
  return typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/** Current push state for this browser, plus a setter for after enable/disable. */
export function usePushState(): [PushState, (s: PushState) => void] {
  const [state, setState] = useState<PushState>("checking");
  useEffect(() => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then(reg => reg?.pushManager.getSubscription())
      .then(sub => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);
  return [state, setState];
}

/** Ask permission, register /sw.js, subscribe, and send the subscription to the server. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw Object.assign(
      new Error(permission === "denied" ? "Notifications are blocked for this site in your browser." : "Permission was not granted."),
      { pushState: (permission === "denied" ? "denied" : "off") as PushState },
    );
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.vapid();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
  }
  return "off";
}

export function pushStateFromError(e: unknown): PushState | null {
  return e && typeof e === "object" && "pushState" in e ? ((e as { pushState: PushState }).pushState ?? null) : null;
}
