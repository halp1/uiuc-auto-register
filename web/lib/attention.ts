import type { ClientState } from "./store";

export interface Attention {
  id: string;
  title: string;
  detail: string;
  href: string;
  action: string;
}

/** Everything that needs the student, most severe first. Drives the sidebar Action Required card. */
export function attentionItems(s: ClientState): Attention[] {
  const items: Attention[] = [];
  const status = s.status;
  if (!status) return items;
  if (status.guardTripped)
    items.push({
      id: "guard",
      title: "Safety guard tripped",
      detail: "Registration is halted until you review your schedule.",
      href: "/",
      action: "Review",
    });
  if (status.session.state === "error")
    items.push({
      id: "session",
      title: "Login failing",
      detail: status.session.lastError ?? "The Banner session could not log in.",
      href: "/settings#session",
      action: "Open session",
    });
  const armed = s.wanted.some(w => w.armed && w.state === "watching");
  const ticketArmed = status.ticket.phase === "waiting" || status.ticket.phase === "prewarm";
  if (status.mode === "live" && !status.liveEnabled && armed && ticketArmed)
    items.push({
      id: "live",
      title: "Live is off",
      detail: "Your time ticket is set but registration will only be simulated.",
      href: "/settings#registration",
      action: "Turn on Live",
    });
  const pending = s.approvals.filter(a => a.state === "pending").length;
  if (pending > 0)
    items.push({
      id: "approvals",
      title: pending === 1 ? "1 approval waiting" : `${pending} approvals waiting`,
      detail: "Seats are open now.",
      href: "/",
      action: "Review",
    });
  return items;
}
