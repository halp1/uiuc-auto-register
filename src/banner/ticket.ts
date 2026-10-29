// Registration time ticket parsing for Banner's Prepare for Registration page.
// Pure. Works on visible text (or text pulled out of a JSON or HTML response), so it does not depend on
// exact markup. Only dates near a time ticket label count. Nothing here logs or stores page text.

import type { TicketParse, TicketWindow } from "../core/types";

export type { TicketParse };

const LABEL = /time\s*tickets?|registration\s+(?:time|window|period|appointment)s?|time\s+(?:slot|assignment)s?|registration\s+start/gi;
const NONE =
  /no\s+(?:registration\s+)?time\s*tickets?|(?:do|does)\s+not\s+have\s+(?:a\s+|any\s+)?(?:registration\s+)?time\s*tickets?|not\s+(?:been\s+)?assigned\s+(?:a\s+)?(?:registration\s+)?time/i;
const LABEL_REACH = 400;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const TIME = String.raw`(?:,?\s*(?:at\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?)?`;
const NUMERIC = new RegExp(String.raw`\b(\d{1,2})/(\d{1,2})/(\d{4})` + TIME, "g");
const NAMED = new RegExp(
  String.raw`\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})` + TIME,
  "gi",
);
const ISO = /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
// Between the two ends of one window: a dash or word ("08:00 AM - 11:59 PM"), or an end label when the
// ends sit in labeled fields ("Start: ... End: ...", or JSON {"timeTicketStart", "timeTicketEnd"}).
const RANGE_GAP =
  /^\s*(?:-|\u2013|\u2014|to|through|thru|until|till|(?:(?:registration\s+)?time\s*tickets?\s+)?(?:end|ends|ending|close|closes)(?:\s+(?:date|time|date\s*time|at|on))?\s*:?)\s*$/i;

interface Hit {
  index: number;
  end: number;
  ms: number;
  hasTime: boolean;
}

const chicagoFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function chicagoOffsetMs(ms: number): number {
  const p = Object.fromEntries(chicagoFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Central time wall clock to epoch ms (UIUC is in America/Chicago). Null for impossible dates. */
export function chicagoToMs(year: number, month: number, day: number, hour = 0, minute = 0): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  let ms = wall - chicagoOffsetMs(wall);
  ms = wall - chicagoOffsetMs(ms);
  return ms;
}

function hour24(h: string | undefined, ampm: string | undefined): number {
  let hour = Number(h ?? 0);
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return hour;
}

function findDates(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(NUMERIC)) {
    const ms = chicagoToMs(Number(m[3]), Number(m[1]), Number(m[2]), m[4] ? hour24(m[4], m[6]) : 0, Number(m[5] ?? 0));
    if (ms !== null) hits.push({ index: m.index!, end: m.index! + m[0].length, ms, hasTime: Boolean(m[4]) });
  }
  for (const m of text.matchAll(NAMED)) {
    const month = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    if (!month) continue;
    const ms = chicagoToMs(Number(m[3]), month, Number(m[2]), m[4] ? hour24(m[4], m[6]) : 0, Number(m[5] ?? 0));
    if (ms !== null) hits.push({ index: m.index!, end: m.index! + m[0].length, ms, hasTime: Boolean(m[4]) });
  }
  for (const m of text.matchAll(ISO)) {
    let ms: number | null;
    if (m[6]) ms = Date.parse(m[0].replace(" ", "T"));
    else ms = chicagoToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    if (ms !== null && Number.isFinite(ms)) hits.push({ index: m.index!, end: m.index! + m[0].length, ms, hasTime: true });
  }
  hits.sort((a, b) => a.index - b.index);
  // Drop overlapping matches (an ISO date inside a longer match, for example).
  return hits.filter((hit, i) => i === 0 || hit.index >= hits[i - 1]!.end);
}

/** A date-only end means the end of that day. */
const endOfDay = (hit: Hit) => (hit.hasTime ? hit.ms : hit.ms + 24 * 60 * 60 * 1000 - 60 * 1000);

function windowsIn(text: string, hits: Hit[]): TicketWindow[] {
  const out: TicketWindow[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const next = hits[i + 1];
    if (next && RANGE_GAP.test(text.slice(hit.end, next.index)) && endOfDay(next) > hit.ms) {
      out.push({ start: new Date(hit.ms).toISOString(), end: new Date(endOfDay(next)).toISOString() });
      i++;
    } else {
      out.push({ start: new Date(hit.ms).toISOString(), end: null });
    }
  }
  return out;
}

/** Plain text from HTML or JSON (string values only). */
export function ticketText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parts: string[] = [];
      const stack: unknown[] = [JSON.parse(trimmed)];
      let seen = 0;
      while (stack.length && seen++ < 20_000) {
        const node = stack.pop();
        if (typeof node === "string") parts.push(node.includes("<") ? ticketText(node) : node);
        else if (Array.isArray(node)) for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        else if (node && typeof node === "object") {
          const entries = Object.entries(node as Record<string, unknown>);
          for (let i = entries.length - 1; i >= 0; i--) {
            const [key, value] = entries[i]!;
            // Keys carry meaning in JSON ("timeTicketStart": "..."), so keep them as labels.
            stack.push(value);
            stack.push(key.replace(/([a-z])([A-Z])/g, "$1 $2"));
          }
        }
      }
      return parts.join("\n");
    } catch {
      // not JSON after all
    }
  }
  return trimmed
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#45;|&ndash;|&mdash;/g, "-")
    .replace(/[ \t]+/g, " ");
}

/**
 * Time ticket windows from page text. Only dates within reach of a time ticket label count, so other
 * dates on the page (holds, term dates) are ignored. A "no time ticket" message wins over stray dates.
 */
export function parseTicket(text: string): TicketParse {
  if (!text.trim()) return { status: "unreadable" };
  if (NONE.test(text)) return { status: "none" };
  const hits = findDates(text);
  if (!hits.length) return { status: "unreadable" };
  const labels = [...text.matchAll(LABEL)].map(m => m.index! + m[0].length);
  if (!labels.length) return { status: "unreadable" };
  const near = hits.filter(hit => labels.some(at => hit.index >= at && hit.index - at <= LABEL_REACH));
  // A ticket opens at a time of day. Date-only values near the label are term dates, not tickets.
  const windows = windowsIn(text, near).filter(w => near.find(h => new Date(h.ms).toISOString() === w.start)?.hasTime);
  if (!windows.length) return { status: "unreadable" };
  const unique = new Map(windows.map(w => [`${w.start}|${w.end}`, w]));
  return { status: "found", windows: [...unique.values()].sort((a, b) => a.start.localeCompare(b.start)) };
}

/** The window that matters now: the one open now, else the next to open. Null when all have ended. */
export function currentWindow(windows: TicketWindow[], now: number): TicketWindow | null {
  const live = windows.filter(w => (w.end ? Date.parse(w.end) > now : true));
  if (!live.length) return null;
  // An open-ended window that started in the past is superseded by a later one.
  const upcoming = live.filter(w => Date.parse(w.start) > now);
  const open = live.filter(w => Date.parse(w.start) <= now && w.end);
  if (open.length) return open.sort((a, b) => a.start.localeCompare(b.start))[0]!;
  if (upcoming.length) return upcoming.sort((a, b) => a.start.localeCompare(b.start))[0]!;
  return live.sort((a, b) => b.start.localeCompare(a.start))[0]!;
}
