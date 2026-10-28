// UIUC term codes: "1" + YYYY + suffix, where suffix 1 = Spring, 5 = Summer, 8 = Fall, 0 = Winter.

export type Season = "spring" | "summer" | "fall" | "winter";

const SUFFIX: Record<string, Season> = { "1": "spring", "5": "summer", "8": "fall", "0": "winter" };

export function parseTerm(code: string): { year: number; season: Season } {
  const match = /^1(\d{4})([0158])$/.exec(code);
  if (!match) throw new Error(`Invalid UIUC term code: ${code}`);
  return { year: Number(match[1]), season: SUFFIX[match[2]!]! };
}

export function isTermCode(code: unknown): code is string {
  return typeof code === "string" && /^1\d{4}[0158]$/.test(code);
}

export function termLabel(code: string): string {
  const { year, season } = parseTerm(code);
  return `${season[0]!.toUpperCase()}${season.slice(1)} ${year}`;
}

/** Winter and Summer terms are the only ones the swap test may run against. */
export function isThrowawayTerm(code: string): boolean {
  const { season } = parseTerm(code);
  return season === "winter" || season === "summer";
}

/** Course Explorer path segment, e.g. "2027/spring". Winter is listed under its calendar year. */
export function explorerPath(code: string): string {
  const { year, season } = parseTerm(code);
  return `${year}/${season}`;
}
