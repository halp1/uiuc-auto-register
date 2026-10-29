import { useSyncExternalStore, type MouseEvent } from "react";

export type RouteMatch =
  | { name: "overview" }
  | { name: "plan"; id: number | null; guide: boolean }
  | { name: "setup"; step: string | null }
  | { name: "search"; q: string }
  | { name: "course"; term: string; subject: string; number: string }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "notfound" };

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", emit);
}

function keepMock(url: string) {
  // Preserve ?mock=1 while navigating in the mock preview.
  const params = new URLSearchParams(location.search);
  if (params.get("mock") !== "1") return url;
  const u = new URL(url, location.origin);
  u.searchParams.set("mock", "1");
  return u.pathname + u.search + u.hash;
}

/** Returns true to allow leaving the current page. Used by the settings unsaved-changes bar. */
type NavigationGuard = () => boolean;
let guard: NavigationGuard | null = null;

export function setNavigationGuard(next: NavigationGuard | null) {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = keepMock(to);
  if (url === location.pathname + location.search) return;
  if (guard && !guard()) return;
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  if (!opts.replace) window.scrollTo(0, 0);
  emit();
}

function snapshot() {
  return location.pathname + location.search;
}

export function useLocation() {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
    snapshot,
  );
}

export function match(href: string): RouteMatch {
  const url = new URL(href, "http://x");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "overview" };
  if (parts[0] === "search" && parts.length === 1) return { name: "search", q: url.searchParams.get("q") ?? "" };
  if (parts[0] === "course" && parts.length === 4)
    return { name: "course", term: parts[1]!, subject: parts[2]!.toUpperCase(), number: parts[3]! };
  if (parts[0] === "plan" && parts.length === 1) {
    const id = Number(url.searchParams.get("id"));
    return { name: "plan", id: Number.isInteger(id) && id > 0 ? id : null, guide: url.searchParams.get("guide") === "1" };
  }
  if (parts[0] === "setup" && parts.length <= 2) return { name: "setup", step: parts[1] ?? null };
  if (parts[0] === "activity" && parts.length === 1) return { name: "activity" };
  if (parts[0] === "settings" && parts.length === 1) return { name: "settings" };
  return { name: "notfound" };
}

export function useRoute(): RouteMatch {
  return match(useLocation());
}

export function coursePath(term: string, subject: string, number: string) {
  return `/course/${encodeURIComponent(term)}/${encodeURIComponent(subject)}/${encodeURIComponent(number)}`;
}

/** onClick handler for <a href> that routes client-side but keeps modifier-click behavior. */
export function linkClick(href: string, after?: () => void) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
    after?.();
  };
}

export function hrefWithMock(href: string) {
  if (typeof location === "undefined") return href;
  return keepMock(href);
}
