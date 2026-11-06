// Prerequisites as Course Explorer writes them: a "Prerequisite: ..." sentence in the description.
// Cross-listed courses often say only "Same as REL 134. See REL 134." and keep the text on that course.

const CLAUSE = /\b(?:Prerequisites?|Corequisites?)\s*:\s*([\s\S]+)$/i;
const SEE = /\bSee ([A-Z]{2,5}) (\d{3}[A-Z]?)\.?\s*$/;
const NONE = /^(?:none|no prerequisites?|n\/a)\.?$/i;

export type PrereqInfo = { kind: "none" } | { kind: "some"; text: string } | { kind: "see"; subject: string; number: string };

/** What a description says about prerequisites. */
export function parsePrereq(description: string | null | undefined): PrereqInfo {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  const clause = CLAUSE.exec(text);
  if (clause) {
    const body = clause[1]!.trim().replace(/\.$/, "").trim();
    return !body || NONE.test(body) ? { kind: "none" } : { kind: "some", text: body };
  }
  const see = SEE.exec(text);
  if (see) return { kind: "see", subject: see[1]!, number: see[2]! };
  return { kind: "none" };
}

/**
 * Prerequisite text of a course, following one "See X 123" hop. Returns undefined when the referenced
 * course is unknown, so callers can treat that as "not sure".
 */
export function resolvePrereq(
  description: string | null | undefined,
  lookup: (subject: string, number: string) => string | null | undefined,
): string | null | undefined {
  const info = parsePrereq(description);
  if (info.kind === "none") return null;
  if (info.kind === "some") return info.text;
  const target = lookup(info.subject, info.number);
  if (target === undefined) return undefined;
  const next = parsePrereq(target);
  return next.kind === "some" ? next.text : next.kind === "none" ? null : undefined;
}
