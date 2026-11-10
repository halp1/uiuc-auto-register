// Gen ed pieces shared by the gen ed finder page and the plan's gen ed sheet.

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { genEdGroups } from "../../src/core/gened";
import { meetsStanding, STANDING_LABEL, type ClassStanding } from "../../src/core/standing";
import type { GenEdHit } from "../../src/core/types";
import { GenEdPills } from "@/components/grades";
import { FilterChip } from "@/components/ui/list";
import type { GenEdSort } from "@/lib/router";
import { cn, errorMessage } from "@/lib/utils";

export const GENED_SORTS: { value: GenEdSort; label: string }[] = [
  { value: "gpa", label: "GPA" },
  { value: "matched", label: "Most requirements" },
  { value: "code", label: "Code" },
];

/** Single requirement categories (the two compositions) read better as one group. */
const GROUPS = (() => {
  const all = genEdGroups();
  const single = all.filter(g => g.reqs.length === 1 && g.reqs[0]!.label === g.label);
  const rest = all.filter(g => !single.includes(g));
  return single.length > 1 ? [{ category: "COMP", label: "Composition", reqs: single.flatMap(g => g.reqs) }, ...rest] : all;
})();

/** Requirement chips grouped by category. */
export function GenEdPicker({ codes, onToggle, className }: { codes: string[]; onToggle: (code: string) => void; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {GROUPS.map(g => (
        <fieldset key={g.category} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-xs text-fg-muted">{g.label}</legend>
          <div className="flex flex-wrap gap-1.5">
            {g.reqs.map(r => (
              <FilterChip
                key={r.code}
                active={codes.includes(r.code)}
                onClick={() => onToggle(r.code)}
                aria-label={r.label === r.categoryLabel ? r.label : `${r.categoryLabel}: ${r.label}`}
              >
                {r.label}
              </FilterChip>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export const toggleCode = (codes: string[], code: string) => (codes.includes(code) ? codes.filter(c => c !== code) : [...codes, code]);

/** "No prerequisites" filter. With a known standing, standing-only prerequisites it meets still pass. */
export function NoPrereqChip({
  active,
  onToggle,
  standing,
  className,
}: {
  active: boolean;
  onToggle: () => void;
  standing: ClassStanding | null;
  className?: string;
}) {
  return (
    <FilterChip
      active={active}
      onClick={onToggle}
      className={cn("h-9 px-3", className)}
      title={standing ? `Keeps courses that only need ${STANDING_LABEL[standing].toLowerCase()} standing or lower` : undefined}
    >
      {active && <Check aria-hidden />}
      {standing ? `No prerequisites for a ${STANDING_LABEL[standing].toLowerCase()}` : "No prerequisites"}
    </FilterChip>
  );
}

/** Title, gen ed pills, and prerequisite line of one result. */
export function GenEdHitInfo({ hit, standing }: { hit: GenEdHit; standing: ClassStanding | null }) {
  return (
    <span className="min-w-0">
      <span className="block truncate text-sm">{hit.title}</span>
      <GenEdPills codes={hit.genEds} matched={hit.matched} className="mt-1" />
      {hit.prereq && (
        <span className="mt-1 block truncate text-xs text-fg-muted" title={`Prerequisite: ${hit.prereq}`}>
          {hit.standingOnly && standing && meetsStanding(standing, hit.standingOnly) && (
            <Check className="mr-1 inline size-3 align-[-2px] text-ready" aria-label="Your standing meets this" />
          )}
          Prerequisite: {hit.prereq}
        </span>
      )}
    </span>
  );
}

/**
 * Debounced gen ed fetch. Runs when `key` changes and `enabled` holds, aborts the previous request,
 * and keeps the last result on screen while the next one loads.
 */
export function useGenEdResults<T>(enabled: boolean, key: string, run: (signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await run(controller.signal);
        if (controller.signal.aborted) return;
        setResult(res);
        setError(null);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return { result, loading, error };
}
