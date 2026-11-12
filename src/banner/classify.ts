import type { FailureClass } from "../core/types";

// Banner registration error text is school-configured; these patterns cover standard Banner 9 wording.
// Anything unrecognized is "unknown", which the orchestrator treats like permanent (stop and tell the student).

const TRANSIENT: RegExp[] = [
  /closed section/i,
  /section (?:is )?(?:full|closed)/i,
  /no (?:seats|space) available/i,
  /reserved (?:for|seats)/i, // reserved-seat exhaustion can clear when reserves release
  /registration (?:is )?not (?:yet )?(?:open|available|permitted at this time)/i,
  /not (?:within|in) (?:your )?(?:time ticket|registration window|registration time)/i,
  /time ticket/i,
  /outside (?:of )?(?:your )?registration (?:time|window|period)/i,
  /try again/i,
  /system (?:is )?(?:busy|unavailable)/i,
];

/** Major, class, level, college, cohort, and campus restrictions. Some of these lift on a known date. */
const RESTRICTION = /restrict/i;

const PERMANENT: RegExp[] = [
  /prerequisite/i,
  /co-?requisite/i,
  /test score/i,
  RESTRICTION,
  /\bhold\b/i,
  /time conflict/i,
  /duplicate/i,
  /link(?:ed)? (?:error|required|course)/i,
  /maximum (?:hours|credit)/i,
  /exceeds? (?:the )?maximum/i,
  /repeat (?:limit|count)/i,
  /approval required|instructor approval|department approval|special approval/i,
  /not eligible|ineligible/i,
  /already registered/i,
];

export function classifyMessage(message: string): FailureClass {
  const text = message.trim();
  if (!text) return "unknown";
  // Permanent checks win: a message mentioning both (e.g. "restricted section closed") still needs the student.
  if (PERMANENT.some(pattern => pattern.test(text))) return "permanent";
  if (TRANSIENT.some(pattern => pattern.test(text))) return "transient";
  return "unknown";
}

/** Classify a whole failed attempt: any permanent row makes it permanent; all-transient stays transient. */
export function classifyMessages(messages: string[]): FailureClass {
  const classes = messages.filter(m => m.trim()).map(classifyMessage);
  if (classes.length === 0) return "unknown";
  if (classes.includes("permanent")) return "permanent";
  if (classes.includes("unknown")) return "unknown";
  return "transient";
}

/**
 * True when every message is a restriction and nothing else permanent (a prerequisite, hold, or time conflict
 * does not lift on a release date). Used only for courses the student told to wait for a release date.
 */
export function restrictionOnly(messages: string[]): boolean {
  const texts = messages.map(m => m.trim()).filter(Boolean);
  return texts.length > 0 && texts.every(text => RESTRICTION.test(text) && !PERMANENT.some(p => p !== RESTRICTION && p.test(text)));
}
