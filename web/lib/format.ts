import { useEffect, useState } from "react";
import type { Bundle, Meeting, Mode, NotifyEvent, SeatInfo, Term, WantedCourse } from "../../src/core/types";

/** Re-render on an interval so relative times stay fresh. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function relative(ts: number | null | undefined, now: number): string {
  if (!ts) return "never";
  const diff = Math.round((now - ts) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);
  let text: string;
  if (s < 5) return future ? "now" : "just now";
  if (s < 60) text = `${s}s`;
  else if (s < 3600) text = `${Math.floor(s / 60)}m`;
  else if (s < 86400) text = `${Math.floor(s / 3600)}h`;
  else text = `${Math.floor(s / 86400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

export function countdown(target: number, now: number): string {
  let s = Math.max(0, Math.round((target - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

const chicago = "America/Chicago";

export function formatDateTime(ts: number | string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: chicago,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

export function formatClock(ts: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: chicago,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ts));
}

/** ISO instant -> "YYYY-MM-DDTHH:MM" wall clock in America/Chicago (for datetime-local). */
export function isoToChicagoLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: chicago,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map(p => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** "YYYY-MM-DDTHH:MM" wall clock in America/Chicago -> ISO instant. */
export function chicagoLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as number[];
  // Start from the UTC guess, then correct by the zone offset at that instant (twice for DST edges).
  let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 2; i++) {
    const wall = isoToChicagoLocal(new Date(guess).toISOString());
    const wm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall)!;
    const asUtc = Date.UTC(Number(wm[1]), Number(wm[2]) - 1, Number(wm[3]), Number(wm[4]), Number(wm[5]));
    guess += Date.UTC(y!, mo! - 1, d!, h!, mi!) - asUtc;
  }
  return new Date(guess).toISOString();
}

export function time12(hhmm: string | null): string {
  if (!hhmm) return "";
  const [hs, ms] = hhmm.split(":");
  const h = Number(hs);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${ms} ${suffix}`;
}

export function timeRange(start: string, end: string): string {
  const a = time12(start);
  const b = time12(end);
  // "10:00 to 10:50 AM" when both ends share the suffix
  if (a.slice(-2) === b.slice(-2)) return `${a.slice(0, -3)} to ${b}`;
  return `${a} to ${b}`;
}

export function meetingTime(m: Meeting): string {
  if (!m.start || !m.end) return "Arranged";
  return timeRange(m.start, m.end);
}

export function termName(terms: Term[], code: string | null | undefined): string {
  if (!code) return "No term";
  return terms.find(t => t.code === code)?.description ?? code;
}

export const modeLabel: Record<Mode, string> = {
  simulated: "Simulated",
  rehearsal: "Rehearsal",
  live: "Live",
};

export const notifyLabels: Record<NotifyEvent, string> = {
  bundle_opened: "Seat opened",
  approval_needed: "Approval needed",
  registered: "Registered",
  registration_failed: "Registration failed",
  session_error: "Session error",
  guard_tripped: "Safety guard tripped",
  poller_degraded: "Poller degraded",
  restarted: "App restarted",
};

export function courseCode(w: { subject: string; number: string }) {
  return `${w.subject} ${w.number}`;
}

export type CourseDisplayState = "watching" | "open" | "pending" | "registering" | "registered" | "blocked" | "unarmed";

export function courseDisplayState(course: WantedCourse): CourseDisplayState {
  if (course.state === "registered") return "registered";
  if (course.state === "blocked") return "blocked";
  if (!course.armed) return "unarmed";
  const states = course.bundles.map(b => b.state);
  if (states.includes("registering")) return "registering";
  if (states.includes("pending_approval")) return "pending";
  if (states.includes("open")) return "open";
  if (course.bundles.length > 0 && course.bundles.every(b => b.state === "blocked")) return "blocked";
  return "watching";
}

export function bundleSeats(bundle: Bundle, seatOf: (crn: string) => SeatInfo | undefined) {
  return bundle.crns.map(crn => ({ crn, seat: seatOf(crn) }));
}
