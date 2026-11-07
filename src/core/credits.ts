/** Catalog credit hours ("3 hours", "1 TO 4 hours", "3 OR 4 hours") to the lowest value, plus whether it varies. */
export function parseCredits(raw: string | null | undefined): { credits: number | null; variable: boolean } {
  if (!raw) return { credits: null, variable: false };
  const values = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0])).filter(Number.isFinite);
  if (!values.length) return { credits: null, variable: false };
  return { credits: Math.min(...values), variable: values.length > 1 };
}
