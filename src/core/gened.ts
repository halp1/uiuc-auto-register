// Gen ed requirements as Course Explorer codes them. Runtime safe for the browser bundle.

export interface GenEdReq {
  code: string; // Course Explorer genEdAttribute code
  category: string; // Course Explorer category id
  categoryLabel: string;
  label: string; // short label within the category
}

export const GENED_REQS: readonly GenEdReq[] = [
  { code: "1FC1", category: "COMP1", categoryLabel: "Composition I", label: "Composition I" },
  { code: "1CLL", category: "ACP", categoryLabel: "Advanced Composition", label: "Advanced Composition" },
  { code: "1HP", category: "HUM", categoryLabel: "Humanities & the Arts", label: "Hist & Phil" },
  { code: "1LA", category: "HUM", categoryLabel: "Humanities & the Arts", label: "Lit & Arts" },
  { code: "1LS", category: "NAT", categoryLabel: "Natural Sciences & Technology", label: "Life Sciences" },
  { code: "1PS", category: "NAT", categoryLabel: "Natural Sciences & Technology", label: "Physical Sciences" },
  { code: "1QR1", category: "QR", categoryLabel: "Quantitative Reasoning", label: "QR I" },
  { code: "1QR2", category: "QR", categoryLabel: "Quantitative Reasoning", label: "QR II" },
  { code: "1BSC", category: "SBS", categoryLabel: "Social & Behavioral Sciences", label: "Behavioral Sci" },
  { code: "1SS", category: "SBS", categoryLabel: "Social & Behavioral Sciences", label: "Social Sci" },
  { code: "1NW", category: "CS", categoryLabel: "Cultural Studies", label: "Non-Western" },
  { code: "1US", category: "CS", categoryLabel: "Cultural Studies", label: "US Minority" },
  { code: "1WCC", category: "CS", categoryLabel: "Cultural Studies", label: "Western" },
];

const BY_CODE = new Map(GENED_REQS.map(req => [req.code, req]));

export function genEdReq(code: string): GenEdReq | null {
  return BY_CODE.get(code) ?? null;
}

export function isGenEdCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** Short pill text: "HUM Hist & Phil", "QR I". Unknown codes come back as is. */
export function genEdShort(code: string): string {
  const req = BY_CODE.get(code);
  if (!req) return code;
  if (req.category === "COMP1" || req.category === "ACP" || req.category === "QR") return req.label;
  return `${req.category} ${req.label}`;
}

/** Categories in display order with their requirements. */
export function genEdGroups(): { category: string; label: string; reqs: GenEdReq[] }[] {
  const out: { category: string; label: string; reqs: GenEdReq[] }[] = [];
  for (const req of GENED_REQS) {
    let group = out.find(g => g.category === req.category);
    if (!group) out.push((group = { category: req.category, label: req.categoryLabel, reqs: [] }));
    group.reqs.push(req);
  }
  return out;
}
