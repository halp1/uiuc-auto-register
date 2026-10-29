import { useSyncExternalStore } from "react";
import type { AuthStatus } from "../../src/core/types";

/**
 * App access state. "checking" until GET /api/auth/status answers, "signin" when the sign-in screen
 * must show, "ok" when the app may load. api.ts flips to "signin" on any 401 { auth: "required" }.
 */
export type AuthGate = "checking" | "signin" | "ok";

let gate: AuthGate = "checking";
let status: AuthStatus | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setAuthStatus(next: AuthStatus) {
  status = next;
  const nextGate = next.mode === "password" && !next.authenticated ? "signin" : "ok";
  if (nextGate === "signin" && gate !== "signin") for (const hook of signOutHooks) hook();
  gate = nextGate;
  emit();
}

const signOutHooks = new Set<() => void>();

/** Run when the app falls back to the sign-in screen (the store drops its stream and data). */
export function onSignOut(hook: () => void) {
  signOutHooks.add(hook);
  return () => signOutHooks.delete(hook);
}

export function requireSignIn() {
  if (gate === "signin") return;
  gate = "signin";
  status = status ? { ...status, authenticated: false, recoveryCodesLeft: null } : { mode: "password", authenticated: false, passkeyLogin: false, passkeysSupported: false, recoveryCodesLeft: null };
  for (const hook of signOutHooks) hook();
  emit();
}

export function getAuth() {
  return { gate, status };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useAuthGate(): AuthGate {
  return useSyncExternalStore(subscribe, () => gate, () => gate);
}

export function useAuthStatus(): AuthStatus | null {
  return useSyncExternalStore(subscribe, () => status, () => status);
}

/**
 * Passkeys need WebAuthn in a secure context (https or localhost) and an address the server
 * accepts as a relying party (never a bare IP).
 */
export function passkeysSupported() {
  const browser = typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
  return browser && !!status?.passkeysSupported;
}

/** "Chrome on macOS" style name for the device, used as the default passkey name. */
export function deviceName() {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\/|AppleWebKit\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device";
  return `${browser} on ${os}`;
}
