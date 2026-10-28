// Turns app events and approvals into short, human messages shared by every channel.

import { NOTIFY_EVENTS, type AppEvent, type Approval, type NotifyEvent, type Severity } from "../core/types";

export interface OutMessage {
  title: string;
  body: string;
  severity: Severity;
  /** Groups related notifications (push tag, rate limit key). */
  tag: string;
}

export const SEVERITY_COLORS: Record<Severity, number> = {
  success: 0x50e3c2,
  critical: 0xee0000,
  warning: 0xf5a623,
  info: 0x0070f3,
};

export function isNotifyEvent(kind: string): kind is NotifyEvent {
  return (NOTIFY_EVENTS as readonly string[]).includes(kind);
}

export function crnLine(crns: string[]): string {
  if (crns.length === 0) return "";
  return `${crns.length === 1 ? "CRN" : "CRNs"} ${crns.join(", ")}`;
}

function joinLines(...lines: (string | null | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line && line.trim())).join("\n");
}

const COURSE_TITLES: Partial<Record<NotifyEvent, (label: string) => string>> = {
  bundle_opened: label => `Seat open in ${label}`,
  approval_needed: label => `Approve ${label}?`,
  registered: label => `Registered for ${label}`,
  registration_failed: label => `Registration failed for ${label}`,
};

const FIXED_TITLES: Partial<Record<NotifyEvent, string>> = {
  session_error: "Banner session error",
  guard_tripped: "Registration halted by the safety guard",
  poller_degraded: "Seat checks degraded",
  restarted: "App restarted",
};

/**
 * Format an event for notification. `courseLabel` is e.g. "CS 225" when the event belongs to a course.
 */
export function formatEvent(event: AppEvent, courseLabel: string | null): OutMessage {
  const kind = event.kind as NotifyEvent;
  const courseTitle = COURSE_TITLES[kind];
  const title = courseTitle && courseLabel ? courseTitle(courseLabel) : FIXED_TITLES[kind] ?? event.title;
  // Keep the emitter's own title as context when we replaced it with a fixed one.
  const context = title !== event.title && !courseTitle ? event.title : null;
  const detail = event.detail && event.detail !== title ? event.detail : null;
  return {
    title,
    body: joinLines(crnLine(event.crns), context, detail),
    severity: event.kind === "guard_tripped" ? "critical" : event.severity,
    tag: rateKey(event),
  };
}

/** Identity used for rate limiting: same kind and bundle (or same title when no bundle). */
export function rateKey(event: AppEvent): string {
  if (event.bundleId !== null && event.bundleId !== undefined) return `${event.kind}:b${event.bundleId}`;
  if (event.crns.length) return `${event.kind}:c${event.crns.join(",")}`;
  return `${event.kind}:${event.title}`;
}

export function approvalTag(approvalId: number): string {
  return `approval-${approvalId}`;
}

export function formatApproval(approval: Approval, now: number): OutMessage {
  let auto: string | null = null;
  if (approval.autoAt !== null) {
    const minutes = Math.max(1, Math.round((approval.autoAt - now) / 60_000));
    auto = `Registers on its own in ${minutes} min unless you skip.`;
  }
  return {
    title: `Approve ${approval.label}?`,
    body: joinLines(crnLine(approval.crns), auto),
    severity: "warning",
    tag: approvalTag(approval.id),
  };
}

export function formatApprovalResolved(approval: Approval, resultText: string): OutMessage {
  const severity: Severity = approval.state === "expired" ? "warning" : approval.state === "skipped" ? "info" : "success";
  return {
    title: approval.label,
    body: joinLines(resultText, crnLine(approval.crns)),
    severity: /fail|error|could not|couldn't/i.test(resultText) ? "warning" : severity,
    tag: approvalTag(approval.id),
  };
}

export function formatApprovalReminder(approval: Approval): OutMessage {
  return {
    title: `Still waiting: ${approval.label}`,
    body: joinLines(crnLine(approval.crns), "Register or skip it."),
    severity: "warning",
    tag: approvalTag(approval.id),
  };
}
