// Class standing (Banner's "class standing for registration purposes") and catalog prerequisites
// that only ask for a standing. Runtime safe for the browser bundle.

export const STANDINGS = ["freshman", "sophomore", "junior", "senior", "graduate"] as const;
export type ClassStanding = (typeof STANDINGS)[number];

export const STANDING_LABEL: Record<ClassStanding, string> = {
  freshman: "Freshman",
  sophomore: "Sophomore",
  junior: "Junior",
  senior: "Senior",
  graduate: "Graduate",
};

export const isStanding = (value: unknown): value is ClassStanding => STANDINGS.includes(value as ClassStanding);

/** True when someone at `have` meets a `need` standing. Graduate students meet every undergraduate standing. */
export function meetsStanding(have: ClassStanding, need: ClassStanding): boolean {
  return STANDINGS.indexOf(have) >= STANDINGS.indexOf(need);
}

const WORD: Record<string, ClassStanding> = {
  freshman: "freshman",
  freshmen: "freshman",
  "first-year": "freshman",
  sophomore: "sophomore",
  sophomores: "sophomore",
  junior: "junior",
  juniors: "junior",
  senior: "senior",
  seniors: "senior",
  graduate: "graduate",
  graduates: "graduate",
};

/** "Junior", "Sophomore", "Graduate - Urbana-Champaign", "U3" style values from Banner. */
export function parseStandingWord(raw: string): ClassStanding | null {
  const word = raw.trim().toLowerCase().split(/[^a-z-]+/)[0] ?? "";
  return WORD[word] ?? null;
}

/** Banner's Prepare for Registration page: "Your class standing for registration purposes is Junior". */
export function parseStandingText(text: string): ClassStanding | null {
  const match = /class\s+standing(?:\s+for\s+registration\s+purposes)?\s*(?:is|:)\s*([A-Za-z-]+)/i.exec(text);
  return match ? parseStandingWord(match[1]!) : null;
}

const STANDING_WORDS = "freshm[ae]n|first-year|sophomores?|juniors?|seniors?|graduate(?:s)?";
const COURSE_CODE = /\b[A-Z]{2,5}\s?\d{3}\b/;
// Anything that asks for more than a standing: courses, hours, majors, GPA, admission, placement.
const OTHER =
  /\b(?:hours?|course(?:s|work)?|majors?|minors?|program|option|gpa|grade[- ]point|average|admission|admitted|placement|enroll(?:ed|ment)|concurrent|credit|portfolio|equivalent|experience|internship|completion|approval|exam|degree|department|in\s+(?:the\s+)?[A-Z])/i;

/**
 * The lowest class standing that satisfies a prerequisite on its own, or null when it asks for more
 * (a course, hours, a major) or names no standing. Alternatives after "; or" are checked separately,
 * so "Two GWS courses; or junior standing" is met by junior standing. Instructor consent is ignored
 * because it never blocks someone who meets the rest.
 */
export function standingOnlyPrereq(prereq: string): ClassStanding | null {
  let best: ClassStanding | null = null;
  for (const alternative of prereq.split(/;\s*or\b|\.\s+or\b/i)) {
    const need = alternativeStanding(alternative);
    if (need && (!best || STANDINGS.indexOf(need) < STANDINGS.indexOf(best))) best = need;
  }
  return best;
}

function alternativeStanding(text: string): ClassStanding | null {
  if (COURSE_CODE.test(text)) return null;
  const words = [...text.matchAll(new RegExp(`\\b(${STANDING_WORDS})\\b`, "gi"))].map(m => parseStandingWord(m[1]!));
  const named = words.filter((w): w is ClassStanding => w !== null);
  if (!named.length) return null;
  // Everything else must be about standing or consent.
  const rest = text
    .replace(/,?\s*(?:or\s+)?(?:with\s+)?(?:the\s+)?(?:written\s+)?consent\s+of\s+(?:the\s+)?[a-z' ]*?(?=[.;,]|$)/gi, " ")
    .replace(new RegExp(`\\b(?:${STANDING_WORDS})\\b`, "gi"), " ")
    .replace(/\b(?:class|level|standing|status|or|and|above|higher|beyond|restricted|to|only|open|students?|undergraduates?|with|of|the|a|an|at|least|is|are|required|limited|for)\b/gi, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim();
  if (rest || OTHER.test(text)) return null;
  const lowest = named.reduce((a, b) => (STANDINGS.indexOf(a) <= STANDINGS.indexOf(b) ? a : b));
  // "Graduate standing" is only met by graduate students. "Junior, Senior or Graduate" by juniors.
  return lowest;
}
