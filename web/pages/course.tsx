import { ArrowDown, ArrowUp, ChevronLeft, Link2, Lock, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AnyFilters, CourseDetail, Day, Section, SeatInfo, TimeRange, WantedCourse } from "../../src/core/types";
import { CourseState, SeatCount } from "@/components/data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label } from "@/components/ui/input";
import { Card, CardBody, CardFooter, FilterChip, InlineError } from "@/components/ui/list";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { courseDisplayState, meetingTime, termName } from "@/lib/format";
import { hrefWithMock, linkClick } from "@/lib/router";
import { local, seatKey, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

const DAYS: { day: Day; label: string }[] = [
  { day: "M", label: "Monday" },
  { day: "T", label: "Tuesday" },
  { day: "W", label: "Wednesday" },
  { day: "R", label: "Thursday" },
  { day: "F", label: "Friday" },
];

const emptyFilters: AnyFilters = { excludeDays: [], excludeTimes: [], excludeInstructors: [] };

interface Draft {
  kind: "bundles" | "any";
  bundles: string[][];
  filters: AnyFilters;
  swapDropCrn: string;
}

function draftFrom(w: WantedCourse | undefined): Draft {
  if (!w) return { kind: "bundles", bundles: [], filters: emptyFilters, swapDropCrn: "" };
  return {
    kind: w.kind,
    bundles: w.bundles.filter(b => !b.generated).map(b => [...b.crns]),
    filters: structuredClone(w.filters),
    swapDropCrn: w.swapDropCrn ?? "",
  };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function sectionPasses(section: Section, filters: AnyFilters): boolean {
  for (const m of section.meetings) {
    if ([...m.days].some(d => filters.excludeDays.includes(d as Day))) return false;
    if (m.start && m.end) {
      const s = toMin(m.start);
      const e = toMin(m.end);
      for (const r of filters.excludeTimes) {
        if (!r.start || !r.end) continue;
        if (s < toMin(r.end) && e > toMin(r.start)) return false;
      }
    }
    if (m.instructors.some(i => filters.excludeInstructors.includes(i))) return false;
  }
  return true;
}

/** Valid combinations from linked options, mirroring what "any" mode will generate. */
function combinations(detail: CourseDetail): string[][] {
  const keys = Object.keys(detail.linkedOptions);
  if (keys.length === 0) return detail.sections.map(s => [s.crn]);
  const out: string[][] = [];
  for (const key of keys) for (const option of detail.linkedOptions[key]!) out.push([key, ...option]);
  return out;
}

export function CoursePage({ term, subject, number }: { term: string; subject: string; number: string }) {
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const terms = useStore(s => s.terms);

  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Abort on unmount so a slow course never holds up the next page.
    const controller = new AbortController();
    setLoadError(null);
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 1500);
    api
      .course(term, subject, number, controller.signal)
      .then(d => setDetail(d))
      .catch(e => {
        if (!controller.signal.aborted) setLoadError(errorMessage(e));
      })
      .finally(() => clearTimeout(slowTimer));
    return () => {
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [term, subject, number, attempt]);

  const back = (
    <a
      href={hrefWithMock("/search")}
      onClick={linkClick("/search")}
      className="inline-flex items-center gap-1 rounded text-[0.8125rem] text-fg-muted transition-colors duration-150 hover:text-fg"
    >
      <ChevronLeft className="size-4" aria-hidden />
      Search
    </a>
  );

  if (loadError)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6">
          <p className="text-sm font-medium">
            Could not load {subject} {number} for {termName(terms, term)}
          </p>
          <p className="text-[0.8125rem] text-fg-muted">{loadError}</p>
          <Button size="sm" onClick={() => setAttempt(a => a + 1)}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
        </div>
      </div>
    );

  if (!detail)
    return (
      <div className="flex flex-col gap-6" aria-busy aria-label="Loading course">
        {back}
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-[-0.02em]">
            {subject} {number}
          </h1>
          <Skeleton className="h-5 w-64" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        </div>
        <p role="status" className={cn("h-5 text-[0.8125rem] text-fg-muted transition-opacity duration-200", slow ? "opacity-100" : "opacity-0")}>
          {slow ? "Loading sections and live seats" : ""}
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex h-12 items-center gap-4 border-b border-border px-4 last:border-b-0">
              <Skeleton className="size-4" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    );

  return <CourseEditor detail={detail} back={back} />;
}

function CourseEditor({ detail, back }: { detail: CourseDetail; back: React.ReactNode }) {
  const wanted = useStore(s =>
    s.wanted.find(w => w.term === detail.term && w.subject === detail.subject && w.number === detail.number),
  );
  const swapsUnlocked = useStore(s => s.settings?.swapsUnlocked ?? false);
  const storeSeats = useStore(s => s.seats);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(wanted));
  const [baseline, setBaseline] = useState<Draft>(() => draftFrom(wanted));
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [armBusy, setArmBusy] = useState(false);
  const [armAfterSave, setArmAfterSave] = useState(true);

  const byCrn = useMemo(() => new Map(detail.sections.map(s => [s.crn, s])), [detail]);
  const seatOf = (crn: string): SeatInfo | null =>
    storeSeats[seatKey(detail.term, crn)] ?? byCrn.get(crn)?.seats ?? null;

  const groups = useMemo(() => {
    const map = new Map<string, Section[]>();
    for (const s of detail.sections) {
      const key = s.typeName || s.type;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()];
  }, [detail]);

  // Linked partners for every selected section that has linked options.
  const partners = useMemo(() => {
    const set = new Set<string>();
    for (const crn of selected) for (const option of detail.linkedOptions[crn] ?? []) for (const p of option) set.add(p);
    return set;
  }, [selected, detail]);

  const linkedKeys = Object.keys(detail.linkedOptions);
  const draftProblem = useMemo(() => {
    if (selected.length === 0) return null;
    for (const crn of selected) {
      const options = detail.linkedOptions[crn];
      if (options && options.length > 0 && !options.some(o => o.every(p => selected.includes(p))))
        return `${byCrn.get(crn)?.section ?? crn} needs one of its linked sections`;
    }
    if (linkedKeys.length > 0 && !selected.some(c => linkedKeys.includes(c)))
      return "Pick a lecture too";
    const sameDraft = draft.bundles.some(b => b.length === selected.length && b.every(c => selected.includes(c)));
    if (sameDraft) return "Already in your bundles";
    return null;
  }, [selected, detail, draft.bundles, byCrn, linkedKeys]);

  function toggle(crn: string) {
    setSelected(s => (s.includes(crn) ? s.filter(c => c !== crn) : [...s, crn]));
  }

  function addBundle() {
    if (draftProblem || selected.length === 0) return;
    // Order CRNs by section listing so bundles read lecture first.
    const order = detail.sections.map(s => s.crn);
    const bundle = [...selected].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    setDraft(d => ({ ...d, bundles: [...d.bundles, bundle] }));
    setSelected([]);
  }

  function moveBundle(from: number, to: number) {
    setDraft(d => {
      const bundles = [...d.bundles];
      const [b] = bundles.splice(from, 1);
      bundles.splice(to, 0, b!);
      return { ...d, bundles };
    });
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const anyMatches = useMemo(
    () =>
      combinations(detail).filter(combo =>
        combo.every(crn => {
          const s = byCrn.get(crn);
          return s ? sectionPasses(s, draft.filters) : false;
        }),
      ),
    [detail, draft.filters, byCrn],
  );
  const instructors = useMemo(
    () => [...new Set(detail.sections.flatMap(s => s.meetings.flatMap(m => m.instructors)))].filter(Boolean).sort(),
    [detail],
  );

  const canSave =
    !saving && (wanted ? dirty : draft.kind === "any" ? anyMatches.length > 0 : draft.bundles.length > 0);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      let result: WantedCourse;
      if (!wanted) {
        result = await api.createWanted({
          term: detail.term,
          subject: detail.subject,
          number: detail.number,
          title: detail.title,
          kind: draft.kind,
          bundles: draft.kind === "bundles" ? draft.bundles : undefined,
          filters: draft.kind === "any" ? draft.filters : undefined,
        });
        if (swapsUnlocked && draft.swapDropCrn) result = await api.patchWanted(result.id, { swapDropCrn: draft.swapDropCrn });
        if (armAfterSave) result = await api.arm(result.id);
      } else {
        result = wanted;
        const patch: Parameters<typeof api.patchWanted>[1] = {};
        if (draft.kind !== baseline.kind) patch.kind = draft.kind;
        if (JSON.stringify(draft.filters) !== JSON.stringify(baseline.filters)) patch.filters = draft.filters;
        if (swapsUnlocked && draft.swapDropCrn !== baseline.swapDropCrn) patch.swapDropCrn = draft.swapDropCrn || null;
        if (Object.keys(patch).length) result = await api.patchWanted(wanted.id, patch);
        if (draft.kind === "bundles" && JSON.stringify(draft.bundles) !== JSON.stringify(baseline.bundles))
          result = await api.putBundles(wanted.id, draft.bundles);
      }
      local.upsertWanted(result);
      const next = draftFrom(result);
      setDraft(next);
      setBaseline(next);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function setArmed(next: boolean) {
    if (!wanted) {
      setArmAfterSave(next);
      return;
    }
    setArmBusy(true);
    setSaveError(null);
    try {
      local.upsertWanted(next ? await api.arm(wanted.id) : await api.disarm(wanted.id));
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setArmBusy(false);
    }
  }

  const sectionLabel = (crn: string) => byCrn.get(crn)?.section ?? crn;

  return (
    <div className="flex flex-col gap-6 pb-20 xl:pb-0">
      {back}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">
            <span className="font-mono">
              {detail.subject} {detail.number}
            </span>
            <span className="sr-only">: </span>
          </h1>
          {wanted && <CourseState state={courseDisplayState(wanted)} />}
        </div>
        <p className="text-base text-fg">{detail.title}</p>
        <div className="flex flex-wrap gap-2">
          {detail.creditHours && <Badge variant="muted">{/hour/i.test(detail.creditHours) ? detail.creditHours.replace(/\.$/, "") : `${detail.creditHours} hours`}</Badge>}
          <Badge variant="muted" className="tabular-nums">
            {detail.sections.length} sections
          </Badge>
        </div>
        {detail.scheduleInfo && <p className="max-w-[70ch] text-[0.8125rem] text-fg-muted">{detail.scheduleInfo}</p>}
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map(([name, sections]) => (
            <SectionTable
              key={name}
              name={name}
              sections={sections}
              selected={selected}
              partners={partners}
              hasSelection={selected.length > 0}
              linkedKeys={linkedKeys}
              onToggle={toggle}
              seatOf={seatOf}
              dimmed={draft.kind === "any" ? (s: Section) => !sectionPasses(s, draft.filters) : undefined}
              disabled={draft.kind === "any"}
            />
          ))}
        </div>

        <Card className="xl:sticky xl:top-20">
          <CardBody className="gap-5 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold tracking-[-0.01em]">Bundles</h2>
              <Segmented
                aria-label="Bundle mode"
                value={draft.kind}
                onChange={kind => setDraft(d => ({ ...d, kind }))}
                options={[
                  { value: "bundles", label: "Ranked" },
                  { value: "any", label: "Any valid" },
                ]}
              />
            </div>

            {draft.kind === "bundles" ? (
              <>
                <div className="hidden xl:block">
                  <DraftBox
                    selected={selected}
                    label={sectionLabel}
                    problem={draftProblem}
                    onAdd={addBundle}
                    onClear={() => setSelected([])}
                  />
                </div>
                {draft.bundles.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border-strong px-3 py-5 text-center text-[0.8125rem] text-fg-muted">
                    Select sections in the table, then add them as a bundle. First bundle is tried first.
                  </p>
                ) : (
                  <ol className="flex flex-col overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border" aria-label="Ranked bundles">
                    {draft.bundles.map((bundle, i) => (
                      <li key={bundle.join("+")} className="flex items-center gap-2 bg-black px-2.5 py-2">
                        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-[0.6875rem] text-fg-muted tabular-nums">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-[0.8125rem]">{bundle.map(sectionLabel).join(" + ")}</p>
                          <p className="flex flex-wrap gap-x-2.5 font-mono text-xs text-fg-muted">
                            {bundle.map(crn => (
                              <span key={crn} className="inline-flex items-center gap-1.5">
                                {crn}
                                <SeatCount seat={seatOf(crn)} className="[&_.font-mono]:text-xs" />
                              </span>
                            ))}
                          </p>
                        </div>
                        <Button size="icon-xs" variant="ghost" aria-label={`Move bundle ${i + 1} up`} disabled={i === 0} onClick={() => moveBundle(i, i - 1)}>
                          <ArrowUp />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Move bundle ${i + 1} down`}
                          disabled={i === draft.bundles.length - 1}
                          onClick={() => moveBundle(i, i + 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove bundle ${i + 1}`}
                          onClick={() => setDraft(d => ({ ...d, bundles: d.bundles.filter((_, j) => j !== i) }))}
                        >
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              <AnyFiltersEditor
                filters={draft.filters}
                instructors={instructors}
                matches={anyMatches.length}
                onChange={filters => setDraft(d => ({ ...d, filters }))}
              />
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="swap-crn" className="flex items-center gap-1.5">
                Drop if added
                {!swapsUnlocked && <Lock className="size-3.5 text-fg-subtle" aria-hidden />}
              </Label>
              {swapsUnlocked ? (
                <Input
                  id="swap-crn"
                  inputMode="numeric"
                  pattern="\d{5}"
                  maxLength={5}
                  placeholder="CRN of a registered course"
                  className="font-mono"
                  value={draft.swapDropCrn}
                  onChange={e => setDraft(d => ({ ...d, swapDropCrn: e.target.value.replace(/\D/g, "") }))}
                />
              ) : (
                <Tooltip content="Swaps are locked">
                  <span tabIndex={0} className="block rounded-md focus-visible:outline-2 focus-visible:outline-accent">
                    <Input id="swap-crn" disabled placeholder="Swaps are locked" aria-describedby="swap-locked" className="pointer-events-none" />
                    <span id="swap-locked" className="sr-only">
                      Swaps are locked
                    </span>
                  </span>
                </Tooltip>
              )}
            </div>
          </CardBody>
          <CardFooter className="sm:px-5">
            <label className="flex items-center gap-2.5 text-[0.8125rem] text-fg">
              <Switch
                checked={wanted ? wanted.armed : armAfterSave}
                onCheckedChange={setArmed}
                disabled={armBusy || wanted?.state === "registered"}
                loading={armBusy}
                aria-label="Arm"
              />
              Arm
            </label>
            <div className="flex items-center gap-3">
              {savedAt && !dirty && !saving && <span className="text-xs text-fg-muted" role="status">Saved</span>}
              <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!canSave}>
                {wanted ? "Save" : "Watch course"}
              </Button>
            </div>
          </CardFooter>
          {saveError && (
            <div className="border-t border-border bg-black px-5 pb-3">
              <InlineError>{saveError}</InlineError>
            </div>
          )}
        </Card>
      </div>

      {draft.kind === "bundles" && selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border-strong bg-[#0a0a0a] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:left-60 xl:hidden">
          <DraftBox
            selected={selected}
            label={sectionLabel}
            problem={draftProblem}
            onAdd={addBundle}
            onClear={() => setSelected([])}
            bare
          />
        </div>
      )}
    </div>
  );
}

function DraftBox({
  selected,
  label,
  problem,
  onAdd,
  onClear,
  bare,
}: {
  selected: string[];
  label: (crn: string) => string;
  problem: string | null;
  onAdd: () => void;
  onClear: () => void;
  bare?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", !bare && "rounded-md border border-border-strong bg-black p-2.5")}>
      <div className="min-w-0 flex-1">
        {selected.length === 0 ? (
          <p className="text-[0.8125rem] text-fg-subtle">No sections selected</p>
        ) : (
          <>
            <p className="truncate font-mono text-[0.8125rem]">{selected.map(label).join(" + ")}</p>
            <p className={cn("truncate text-xs", problem ? "text-warning" : "font-mono text-fg-muted")}>
              {problem ?? selected.join(" + ")}
            </p>
          </>
        )}
      </div>
      {selected.length > 0 && (
        <Button size="xs" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
      <Button size="sm" variant="primary" onClick={onAdd} disabled={selected.length === 0 || !!problem}>
        <Plus aria-hidden />
        Add bundle
      </Button>
    </div>
  );
}

function SectionTable({
  name,
  sections,
  selected,
  partners,
  hasSelection,
  linkedKeys,
  onToggle,
  seatOf,
  dimmed,
  disabled,
}: {
  name: string;
  sections: Section[];
  selected: string[];
  partners: Set<string>;
  hasSelection: boolean;
  linkedKeys: string[];
  onToggle: (crn: string) => void;
  seatOf: (crn: string) => SeatInfo | null;
  dimmed?: (s: Section) => boolean;
  disabled?: boolean;
}) {
  const showLinked = partners.size > 0;
  return (
    <section aria-label={name} className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">{name}</h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead className="border-b border-border text-left text-xs text-fg-muted">
            <tr className="h-10">
              <th scope="col" className="w-10 pl-4 font-normal">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col" className="px-3 font-normal">
                Section
              </th>
              <th scope="col" className="px-3 font-normal">
                CRN
              </th>
              <th scope="col" className="hidden px-3 font-normal md:table-cell">
                Days
              </th>
              <th scope="col" className="hidden px-3 font-normal md:table-cell">
                Time
              </th>
              <th scope="col" className="hidden px-3 font-normal lg:table-cell xl:hidden 2xl:table-cell">
                Location
              </th>
              <th scope="col" className="hidden px-3 font-normal lg:table-cell">
                Instructor
              </th>
              <th scope="col" className="pr-4 pl-3 text-right font-normal">
                Seats
              </th>
            </tr>
          </thead>
          <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-border">
            {sections.map(s => {
              const isSelected = selected.includes(s.crn);
              const isPartner = partners.has(s.crn);
              const isKey = linkedKeys.includes(s.crn);
              const faded = (showLinked && hasSelection && !isSelected && !isPartner && !isKey) || dimmed?.(s);
              const m = s.meetings[0];
              const id = `sec-${s.crn}`;
              return (
                <tr
                  key={s.crn}
                  onClick={e => {
                    if (disabled) return;
                    if ((e.target as HTMLElement).closest("button")) return;
                    onToggle(s.crn);
                  }}
                  className={cn(
                    "h-12 transition-[background-color,opacity] duration-150 ease-out",
                    !disabled && "cursor-pointer hover:bg-hover",
                    isSelected && "bg-selected hover:bg-selected",
                    isPartner && !isSelected && "bg-[#06121f]",
                    faded && "opacity-45",
                  )}
                >
                  <td className="pl-4">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggle(s.crn)}
                      disabled={disabled}
                      aria-labelledby={id}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span id={id} className="inline-flex items-center gap-2 font-mono">
                      <span className="sr-only">Section </span>
                      {s.section}
                      {isPartner && !isSelected && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[#10365f] px-1.5 font-sans text-[0.6875rem] text-[#52a8ff]">
                          <Link2 className="size-3" aria-hidden />
                          Linked
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-fg-muted md:hidden">
                      {m ? `${m.days || "TBA"} ${meetingTime(m)}` : "TBA"}
                    </span>
                  </td>
                  <td className="px-3 font-mono tabular-nums text-fg-muted">{s.crn}</td>
                  <td className="hidden px-3 font-mono md:table-cell">
                    {s.meetings.map((mt, i) => (
                      <span key={i} className="block">
                        {mt.days || "TBA"}
                      </span>
                    ))}
                  </td>
                  <td className="hidden whitespace-nowrap px-3 font-mono text-xs tabular-nums md:table-cell">
                    {s.meetings.map((mt, i) => (
                      <span key={i} className="block">
                        {meetingTime(mt)}
                      </span>
                    ))}
                  </td>
                  <td className="hidden max-w-48 px-3 text-fg-muted lg:table-cell xl:hidden 2xl:table-cell">
                    {s.meetings.map((mt, i) => (
                      <span key={i} className="block truncate">
                        {[mt.room, mt.building].filter(Boolean).join(" ") || "TBA"}
                      </span>
                    ))}
                  </td>
                  <td className="hidden max-w-44 px-3 text-fg-muted lg:table-cell">
                    <span className="block truncate">{[...new Set(s.meetings.flatMap(mt => mt.instructors))].join(", ") || "Staff"}</span>
                  </td>
                  <td className="pr-4 pl-3 text-right">
                    <SeatCount seat={seatOf(s.crn)} className="justify-end" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AnyFiltersEditor({
  filters,
  instructors,
  matches,
  onChange,
}: {
  filters: AnyFilters;
  instructors: string[];
  matches: number;
  onChange: (f: AnyFilters) => void;
}) {
  const toggleDay = (day: Day) =>
    onChange({
      ...filters,
      excludeDays: filters.excludeDays.includes(day) ? filters.excludeDays.filter(d => d !== day) : [...filters.excludeDays, day],
    });
  const setTime = (i: number, patch: Partial<TimeRange>) =>
    onChange({ ...filters, excludeTimes: filters.excludeTimes.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const toggleInstructor = (name: string) =>
    onChange({
      ...filters,
      excludeInstructors: filters.excludeInstructors.includes(name)
        ? filters.excludeInstructors.filter(n => n !== name)
        : [...filters.excludeInstructors, name],
    });

  return (
    <div className="flex flex-col gap-5">
      <p className={cn("text-[0.8125rem] tabular-nums", matches === 0 ? "text-warning" : "text-fg-muted")} role="status">
        {matches === 0 ? "No combinations match these filters" : `${matches} ${matches === 1 ? "combination matches" : "combinations match"}`}
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[0.8125rem] font-medium">Exclude days</legend>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map(({ day, label }) => (
            <FilterChip
              key={day}
              active={filters.excludeDays.includes(day)}
              onClick={() => toggleDay(day)}
              aria-label={`Exclude ${label}`}
              className="w-9 justify-center font-mono"
            >
              {day}
            </FilterChip>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[0.8125rem] font-medium">Exclude times</legend>
        {filters.excludeTimes.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              type="time"
              aria-label={`Range ${i + 1} start`}
              value={r.start}
              onChange={e => setTime(i, { start: e.target.value })}
              className="h-8 font-mono text-[0.8125rem] tabular-nums"
            />
            <span className="text-xs text-fg-muted">to</span>
            <Input
              type="time"
              aria-label={`Range ${i + 1} end`}
              value={r.end}
              aria-invalid={r.start && r.end && r.end <= r.start ? true : undefined}
              onChange={e => setTime(i, { end: e.target.value })}
              className="h-8 font-mono text-[0.8125rem] tabular-nums"
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove range ${i + 1}`}
              onClick={() => onChange({ ...filters, excludeTimes: filters.excludeTimes.filter((_, j) => j !== i) })}
            >
              <X />
            </Button>
          </div>
        ))}
        <div>
          <FilterChip onClick={() => onChange({ ...filters, excludeTimes: [...filters.excludeTimes, { start: "08:00", end: "09:00" }] })}>
            <Plus aria-hidden />
            Add time range
          </FilterChip>
        </div>
      </fieldset>
      {instructors.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[0.8125rem] font-medium">Exclude instructors</legend>
          <div className="flex flex-wrap gap-1.5">
            {instructors.map(name => (
              <FilterChip key={name} active={filters.excludeInstructors.includes(name)} onClick={() => toggleInstructor(name)}>
                {filters.excludeInstructors.includes(name) && <X aria-hidden />}
                {name}
              </FilterChip>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
