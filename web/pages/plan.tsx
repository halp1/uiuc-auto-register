import {
  Check,
  ChevronsUpDown,
  Crosshair,
  Ellipsis,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type {
  CourseDetail,
  Day,
  Plan,
  PlanBreak,
  PlanCourse,
  PlanGenerateResult,
  PlanPick,
  PlanSchedule,
  PlanSection,
  PlanSort,
  SearchHit,
} from "../../src/core/types";
import { ConfirmDialog } from "@/components/confirm";
import { SeatCount } from "@/components/data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Kbd } from "@/components/ui/input";
import { FilterChip, InlineError } from "@/components/ui/list";
import { Select } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot, Status } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { courseCode, termName, time12, timeRange } from "@/lib/format";
import { navigate } from "@/lib/router";
import { getState, local, seatKey, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

// ---------- constants and helpers ----------

/** One chart color per course, tuned for the black ground. Not status colors. */
const CHART = ["#52a8ff", "#bf7af0", "#f97ea8", "#62c073", "#f2a14b", "#45dec5", "#9aa8ff", "#e2c044", "#ff8a65", "#7dd3fc", "#c084fc", "#a3e635"];

const DAY_ORDER: Day[] = ["M", "T", "W", "R", "F", "S", "U"];
const DAY_SHORT: Record<Day, string> = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun" };
const DAY_LONG: Record<Day, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  R: "Thursday",
  F: "Friday",
  S: "Saturday",
  U: "Sunday",
};

const SORTS: { value: PlanSort; label: string }[] = [
  { value: "open", label: "Most open" },
  { value: "days", label: "Fewest days" },
  { value: "start", label: "Latest start" },
  { value: "end", label: "Earliest end" },
  { value: "gaps", label: "Fewest gaps" },
];

const HALF_HOURS = Array.from({ length: 31 }, (_, i) => {
  const m = 7 * 60 + i * 30;
  const v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { value: v, label: time12(v) };
});

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const pickKey = (picks: PlanPick[]) => picks.flatMap(p => p.crns).sort().join(",");
const courseKey = (c: { subject: string; number: string }) => `${c.subject} ${c.number}`;

function duration(min: number) {
  if (min <= 0) return "No gaps";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m gaps` : `${h}h gaps`) : `${m}m gaps`;
}

function daysText(days: Day[]) {
  return DAY_ORDER.filter(d => days.includes(d)).join("");
}

function inputsKey(plan: Plan) {
  return JSON.stringify([
    plan.courses.map(c => [c.subject, c.number, c.included, c.excludedCrns, c.locked]),
    plan.breaks,
    plan.ignoreRegistered,
    plan.openOnly,
    plan.sort,
  ]);
}

function timedOverlap(a: PlanSection, b: PlanSection) {
  for (const x of a.meetings)
    for (const y of b.meetings) {
      if (!x.start || !x.end || !y.start || !y.end) continue;
      if (![...x.days].some(d => y.days.includes(d))) continue;
      if (minutes(x.start) < minutes(y.end) && minutes(y.start) < minutes(x.end)) return true;
    }
  return false;
}

type CachedResult = { data: PlanGenerateResult; inputs: string };
/** Results survive navigation within the session. */
const resultCache = new Map<number, CachedResult>();

// ---------- page ----------

export function PlanPage({ id, guide = false }: { id: number | null; guide?: boolean }) {
  const term = useStore(s => s.settings?.activeTerm ?? null);
  const terms = useStore(s => s.terms);
  const plans = useStore(s => (term ? s.plans[term] : undefined));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!term || plans) return;
    let cancelled = false;
    setLoadError(null);
    api
      .plans(term)
      .then(list => !cancelled && local.plans(term, list))
      .catch(e => !cancelled && setLoadError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [term, plans, attempt]);

  if (!term)
    return (
      <div className="flex flex-col gap-4">
        <PlanTitle />
        <p className="text-sm text-fg-muted">Choose a term in the top bar first.</p>
      </div>
    );

  if (loadError)
    return (
      <div className="flex flex-col items-start gap-3">
        <PlanTitle />
        <p className="text-sm text-fg-muted">Could not load plans for {termName(terms, term)}</p>
        <InlineError>{loadError}</InlineError>
        <Button size="sm" onClick={() => setAttempt(a => a + 1)}>
          <RefreshCw aria-hidden />
          Try again
        </Button>
      </div>
    );

  if (!plans || plans.length === 0)
    return (
      <div className="flex flex-col gap-6" aria-busy aria-label="Loading plans">
        <PlanTitle />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[288px_320px_minmax(0,1fr)]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );

  const plan = plans.find(p => p.id === id) ?? plans[0]!;
  return <Planner key={plan.id} plan={plan} plans={plans} guide={guide} />;
}

function PlanTitle({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Plan</h1>
      {children}
    </div>
  );
}

// ---------- plan picker ----------

function PlanPicker({ plan, plans }: { plan: Plan; plans: Plan[] }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(plan.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) requestAnimationFrame(() => inputRef.current?.select());
  }, [renaming]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const next = name.trim();
    if (!next || next === plan.name) {
      setRenaming(false);
      setName(plan.name);
      return;
    }
    await run(async () => {
      local.upsertPlan(await api.patchPlan(plan.id, { name: next }));
      setRenaming(false);
    });
  }

  async function create() {
    await run(async () => {
      const used = new Set(plans.map(p => p.name));
      let n = plans.length + 1;
      while (used.has(`Plan ${n}`)) n++;
      const created = await api.createPlan(plan.term, `Plan ${n}`);
      local.upsertPlan(created);
      navigate(`/plan?id=${created.id}`);
    });
  }

  if (renaming)
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={e => {
          e.preventDefault();
          rename();
        }}
      >
        <Input
          ref={inputRef}
          aria-label="Plan name"
          value={name}
          maxLength={60}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape") {
              setRenaming(false);
              setName(plan.name);
            }
          }}
          className="h-8 w-48"
        />
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Save
        </Button>
        <InlineError>{error}</InlineError>
      </form>
    );

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Plan: ${plan.name}. Switch plan`}
            disabled={busy}
            className="group flex h-8 min-w-0 items-center gap-2 rounded-md border border-border-strong bg-black px-2.5 text-sm font-medium transition-colors duration-150 ease-out hover:border-border-hover hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
          >
            <span className="max-w-48 truncate">{plan.name}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-fg-muted group-hover:text-fg" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Plans</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={String(plan.id)} onValueChange={v => navigate(`/plan?id=${v}`)}>
            {plans.map(p => (
              <DropdownMenuRadioItem key={p.id} value={String(p.id)}>
                <span className="flex-1 truncate">{p.name}</span>
                {p.target && <Crosshair className="size-3.5" aria-label="Targeted" />}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={create} disabled={plans.length >= 10}>
            <Plus aria-hidden />
            New plan
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setName(plan.name);
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem destructive disabled={plans.length <= 1} onSelect={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <InlineError>{error}</InlineError>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${plan.name}?`}
        description="Courses it targeted stay on your watchlist with their bundles."
        confirmLabel="Delete plan"
        onConfirm={async () => {
          await api.deletePlan(plan.id);
          resultCache.delete(plan.id);
          local.removePlan(plan.term, plan.id);
          navigate("/plan", { replace: true });
        }}
      />
    </div>
  );
}

// ---------- planner ----------

function Planner({ plan, plans, guide }: { plan: Plan; plans: Plan[]; guide: boolean }) {
  const cached = resultCache.get(plan.id) ?? null;
  const [result, setResult] = useState<CachedResult | null>(cached);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);

  const colorOf = useMemo(() => {
    const map = new Map(plan.courses.map((c, i) => [courseKey(c), CHART[i % CHART.length]!]));
    return (c: { subject: string; number: string }) => map.get(courseKey(c)) ?? "#a1a1a1";
  }, [plan.courses]);

  const inputs = inputsKey(plan);
  const stale = !!result && result.inputs !== inputs;
  const included = plan.courses.filter(c => c.included);

  async function generate() {
    setGenerating(true);
    setGenError(null);
    const snapshotInputs = inputs;
    try {
      const data = await api.generatePlan(plan.id);
      const next = { data, inputs: snapshotInputs };
      resultCache.set(plan.id, next);
      setResult(next);
      const targetKey = plan.target ? pickKey(plan.target.picks) : null;
      const keys = new Set(data.schedules.map(s => s.key));
      setSelectedKey(k => (k && keys.has(k) ? k : targetKey && keys.has(targetKey) ? targetKey : data.schedules[0]?.key ?? null));
      setPinnedKey(k => (k && keys.has(k) ? k : null));
    } catch (e) {
      setGenError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  }

  // First visit to a plan with courses: generate once so the calendar is not empty.
  useEffect(() => {
    if (!cached && included.length > 0) generate();
    else if (cached) {
      const targetKey = plan.target ? pickKey(plan.target.picks) : null;
      const keys = new Set(cached.data.schedules.map(s => s.key));
      setSelectedKey(targetKey && keys.has(targetKey) ? targetKey : cached.data.schedules[0]?.key ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(fn: () => Promise<Plan>) {
    setMutError(null);
    try {
      local.upsertPlan(await fn());
    } catch (e) {
      setMutError(errorMessage(e));
    }
  }

  const schedules = result?.data.schedules ?? [];
  const shownKey = hoverKey ?? selectedKey;
  const shown = schedules.find(s => s.key === shownKey) ?? null;
  const pinned = pinnedKey ? schedules.find(s => s.key === pinnedKey) ?? null : null;
  const targetKey = plan.target ? pickKey(plan.target.picks) : null;

  return (
    <div className="flex flex-col gap-5 xl:min-h-0 xl:flex-1">
      <PlanTitle>
        <PlanPicker plan={plan} plans={plans} />
        {plan.target && (
          <Badge variant="muted" className="hidden sm:inline-flex">
            <Crosshair aria-hidden />
            Targeted
          </Badge>
        )}
      </PlanTitle>

      {guide && <PlanGuide plan={plan} plans={plans} generated={!!result} />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[288px_minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:grid-cols-[288px_320px_minmax(0,1fr)]">
        <Rail
          plan={plan}
          result={result?.data ?? null}
          colorOf={colorOf}
          mutate={mutate}
          error={mutError}
          generating={generating}
          stale={stale}
          hasResult={!!result}
          onGenerate={generate}
          genError={genError}
          className="lg:row-span-2 xl:row-span-1"
        />
        <Results
          plan={plan}
          result={result?.data ?? null}
          generating={generating}
          selectedKey={selectedKey}
          pinnedKey={pinnedKey}
          targetKey={targetKey}
          colorOf={colorOf}
          onSelect={setSelectedKey}
          onHover={setHoverKey}
          onPin={k => setPinnedKey(p => (p === k ? null : k))}
        />
        <CalendarPane
          plan={plan}
          result={result?.data ?? null}
          schedule={shown}
          index={shown ? schedules.indexOf(shown) : -1}
          pinned={pinned && pinned.key !== shown?.key ? pinned : null}
          pinnedIndex={pinned ? schedules.indexOf(pinned) : -1}
          isTarget={!!shown && shown.key === targetKey}
          generating={generating}
          colorOf={colorOf}
          onUnpin={() => setPinnedKey(null)}
          onTarget={() => setTargetOpen(true)}
          canTarget={!!shown && !hoverKey && !stale}
        />
      </div>

      {shown && result && (
        <TargetDialog
          open={targetOpen}
          onOpenChange={setTargetOpen}
          plan={plan}
          schedule={shown}
          result={result.data}
        />
      )}
    </div>
  );
}

// ---------- first-run guide ----------

const GUIDE_KEY = "planGuideDismissed";

function PlanGuide({ plan, plans, generated }: { plan: Plan; plans: Plan[]; generated: boolean }) {
  const armed = useStore(s => s.wanted.some(w => w.armed && w.term === plan.term));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  const items = [
    { label: "Add the courses you want", done: plan.courses.length > 0 },
    { label: "Choose Generate", done: generated },
    { label: "Pick a schedule and choose Target this schedule. That arms it.", done: plans.some(p => p.target) || armed },
  ];
  const allDone = items.every(i => i.done);
  return (
    <section
      aria-label="Getting started"
      className="flex shrink-0 flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:gap-6"
    >
      <ol className="flex min-w-0 flex-1 flex-col gap-1.5 text-[0.8125rem] sm:flex-row sm:flex-wrap sm:gap-x-6">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums transition-colors duration-200",
                item.done ? "border-[#1d4d43] bg-[#06150f] text-ready" : "border-border-strong text-fg-muted",
              )}
            >
              {item.done ? <Check className="size-3" strokeWidth={3} aria-label="Done" /> : i + 1}
            </span>
            <span className={cn(item.done ? "text-fg-muted line-through decoration-fg-subtle" : "text-fg")}>{item.label}</span>
          </li>
        ))}
      </ol>
      <Button
        size="xs"
        variant={allDone ? "primary" : "ghost"}
        className="self-end sm:self-auto"
        onClick={() => {
          try {
            localStorage.setItem(GUIDE_KEY, "1");
          } catch {
            // Private mode. Hiding for this visit is enough.
          }
          setDismissed(true);
        }}
      >
        Done
      </Button>
    </section>
  );
}

// ---------- left rail ----------

function Pane({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface xl:min-h-0", className)}
      {...props}
    >
      {children}
    </section>
  );
}

function PaneHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2", className)}>{children}</div>
  );
}

function Rail({
  plan,
  result,
  colorOf,
  mutate,
  error,
  generating,
  stale,
  hasResult,
  onGenerate,
  genError,
  className,
}: {
  plan: Plan;
  result: PlanGenerateResult | null;
  colorOf: (c: { subject: string; number: string }) => string;
  mutate: (fn: () => Promise<Plan>) => Promise<void>;
  error: string | null;
  generating: boolean;
  stale: boolean;
  hasResult: boolean;
  onGenerate: () => void;
  genError: string | null;
  className?: string;
}) {
  const included = plan.courses.filter(c => c.included).length;
  return (
    <Pane aria-label="Plan inputs" className={className}>
      <div className="flex flex-col gap-6 p-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        <CoursesSection plan={plan} result={result} colorOf={colorOf} mutate={mutate} />
        <BreaksSection plan={plan} mutate={mutate} />
        <section aria-labelledby="opt-title" className="flex flex-col gap-3">
          <h2 id="opt-title" className="text-[0.8125rem] font-semibold">
            Options
          </h2>
          <label className="flex items-center justify-between gap-3 text-[0.8125rem]">
            <span>Ignore registered classes</span>
            <Switch
              checked={plan.ignoreRegistered}
              onCheckedChange={v => mutate(() => api.patchPlan(plan.id, { ignoreRegistered: v }))}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-[0.8125rem]">
            <span>Open sections only</span>
            <Switch checked={plan.openOnly} onCheckedChange={v => mutate(() => api.patchPlan(plan.id, { openOnly: v }))} />
          </label>
          <div className="flex items-center justify-between gap-3 text-[0.8125rem]">
            <span id="sort-label">Sort</span>
            <Select
              aria-label="Sort schedules"
              className="h-8 w-40"
              value={plan.sort}
              onValueChange={v => mutate(() => api.patchPlan(plan.id, { sort: v as PlanSort }))}
              options={SORTS}
            />
          </div>
        </section>
        <InlineError>{error}</InlineError>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-black p-3">
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" className="flex-1" onClick={onGenerate} loading={generating} disabled={included === 0}>
            {!generating && <RefreshCw aria-hidden />}
            Generate
          </Button>
          {stale && !generating && (
            <Status tone="warning" className="text-xs text-fg-muted" role="status">
              Out of date
            </Status>
          )}
          {!hasResult && !generating && included > 0 && <span className="sr-only">Not generated yet</span>}
        </div>
        <InlineError>{genError}</InlineError>
      </div>
    </Pane>
  );
}

const statusBadge: Record<string, { label: string; variant: "ready" | "error" | "muted" }> = {
  registered: { label: "Registered", variant: "ready" },
  no_options: { label: "No fit", variant: "error" },
  not_offered: { label: "Not offered", variant: "muted" },
};

function CoursesSection({
  plan,
  result,
  colorOf,
  mutate,
}: {
  plan: Plan;
  result: PlanGenerateResult | null;
  colorOf: (c: { subject: string; number: string }) => string;
  mutate: (fn: () => Promise<Plan>) => Promise<void>;
}) {
  const [sheetFor, setSheetFor] = useState<PlanCourse | null>(null);
  const live = sheetFor ? plan.courses.find(c => c.id === sheetFor.id) ?? null : null;
  return (
    <section aria-labelledby="courses-title" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="courses-title" className="text-[0.8125rem] font-semibold">
          Courses
        </h2>
        <span className="text-xs text-fg-subtle tabular-nums">{plan.courses.length}</span>
      </div>
      <AddCourse plan={plan} mutate={mutate} />
      {plan.courses.length === 0 ? (
        <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-[0.8125rem] text-fg-muted">
          Add the courses you want this term. Every schedule that fits shows up here.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
          {plan.courses.map(c => {
            const info = result?.courses.find(x => x.subject === c.subject && x.number === c.number);
            const badge = info && statusBadge[info.status];
            const code = courseCode(c);
            const saving = c.id < 0;
            return (
              <li key={saving ? `pending-${code}` : c.id} aria-busy={saving} className="flex items-center gap-2.5 bg-black py-2 pl-3 pr-1.5">
                <Checkbox
                  disabled={saving}
                  checked={c.included}
                  aria-label={`Include ${code}`}
                  onCheckedChange={v => mutate(() => api.patchPlanCourse(plan.id, c.id, { included: v === true }))}
                />
                <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(c), opacity: c.included ? 1 : 0.35 }} />
                <div className={cn("min-w-0 flex-1", !c.included && "opacity-50")}>
                  <p className="flex items-center gap-1.5 font-mono text-[0.8125rem]">
                    {code}
                    {c.locked && <Lock className="size-3 text-fg-muted" aria-label="Locked to one bundle" />}
                  </p>
                  <p className="truncate text-xs text-fg-muted">{c.title}</p>
                </div>
                {badge ? (
                  <Badge variant={badge.variant} className="h-5 px-2 text-[0.6875rem]">
                    {badge.label}
                  </Badge>
                ) : (
                  info &&
                  c.included && (
                    <span className="text-xs text-fg-muted tabular-nums" title="Section combinations that fit">
                      {info.options}
                    </span>
                  )
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={`More for ${code}`} disabled={saving}>
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setSheetFor(c)}>
                      <SlidersHorizontal aria-hidden />
                      Sections
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={e => {
                        e.preventDefault();
                        mutate(() => api.patchPlanCourse(plan.id, c.id, { backups: !c.backups }));
                      }}
                      role="menuitemcheckbox"
                      aria-checked={c.backups}
                    >
                      <span className="flex-1">Backups</span>
                      <Switch checked={c.backups} tabIndex={-1} aria-hidden className="pointer-events-none scale-90" />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => mutate(() => api.deletePlanCourse(plan.id, c.id))}>
                      <Trash2 aria-hidden />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}
      <SectionsSheet plan={plan} course={live} onClose={() => setSheetFor(null)} mutate={mutate} />
    </section>
  );
}

function AddCourse({ plan, mutate }: { plan: Plan; mutate: (fn: () => Promise<Plan>) => Promise<void> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = q.trim();
  const full = plan.courses.length >= 12;

  useEffect(() => {
    if (!query) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.search(plan.term, query);
        if (cancelled) return;
        setHits(res.slice(0, 6));
        setActive(0);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, plan.term]);

  async function add(hit: SearchHit) {
    setQ("");
    setHits([]);
    setError(null);
    // Show the row right away. The server answer replaces it (or the previous plan comes back on error).
    const pending: PlanCourse = {
      id: -Date.now(),
      planId: plan.id,
      subject: hit.subject,
      number: hit.number,
      title: hit.title,
      included: true,
      excludedCrns: [],
      locked: null,
      backups: true,
      position: plan.courses.length,
    };
    local.upsertPlan({ ...plan, courses: [...plan.courses, pending] });
    try {
      local.upsertPlan(await api.addPlanCourse(plan.id, hit.subject, hit.number));
    } catch (e) {
      const current = getState().plans[plan.term]?.find(p => p.id === plan.id);
      if (current) local.upsertPlan({ ...current, courses: current.courses.filter(c => c.id !== pending.id) });
      setError(errorMessage(e));
    }
  }

  const inPlan = (h: SearchHit) => plan.courses.some(c => c.subject === h.subject && c.number === h.number);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input
          type="search"
          role="combobox"
          aria-label="Add a course"
          aria-expanded={hits.length > 0}
          aria-controls="plan-add-results"
          aria-activedescendant={hits[active] ? `plan-add-${active}` : undefined}
          placeholder={full ? "12 courses max" : "Add course"}
          disabled={full}
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape") setQ("");
            if (!hits.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(a => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(a => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = hits[active];
              if (hit && !inPlan(hit)) add(hit);
            }
          }}
          className="h-8 pl-8 text-[0.8125rem] [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      {query && (hits.length > 0 || !loading) && (
        <ul id="plan-add-results" role="listbox" aria-label="Matching courses" className="overflow-hidden rounded-md border border-border-strong bg-black">
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-fg-muted">No matches</li>
          ) : (
            hits.map((h, i) => {
              const added = inPlan(h);
              return (
                <li
                  key={courseKey(h)}
                  id={`plan-add-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={added}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => !added && add(h)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.8125rem] transition-colors duration-100",
                    i === active && "bg-selected",
                    added && "cursor-default opacity-50",
                  )}
                >
                  <span className="shrink-0 font-mono">{courseCode(h)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-muted">{h.title}</span>
                  {added ? <Check className="size-3.5 text-fg-muted" aria-label="In plan" /> : <Plus className="size-3.5 text-fg-subtle" aria-hidden />}
                </li>
              );
            })
          )}
        </ul>
      )}
      <InlineError>{error}</InlineError>
    </div>
  );
}

function BreaksSection({ plan, mutate }: { plan: Plan; mutate: (fn: () => Promise<Plan>) => Promise<void> }) {
  const [days, setDays] = useState<Day[]>(["M", "W", "F"]);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [adding, setAdding] = useState(false);
  const invalid = minutes(end) <= minutes(start) || days.length === 0;

  function save(breaks: PlanBreak[]) {
    return mutate(() => api.patchPlan(plan.id, { breaks }));
  }

  return (
    <section aria-labelledby="breaks-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="breaks-title" className="text-[0.8125rem] font-semibold">
          Breaks
        </h2>
        {!adding && plan.breaks.length < 20 && (
          <FilterChip onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add break
          </FilterChip>
        )}
      </div>
      {plan.breaks.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {plan.breaks.map((b, i) => (
            <li
              key={i}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-strong bg-black pl-2.5 pr-1 text-xs tabular-nums"
            >
              <span className="font-mono">{daysText(b.days)}</span>
              <span className="text-fg-muted">{timeRange(b.start, b.end)}</span>
              <button
                type="button"
                aria-label={`Remove break ${daysText(b.days)} ${timeRange(b.start, b.end)}`}
                onClick={() => save(plan.breaks.filter((_, j) => j !== i))}
                className="inline-flex size-5 items-center justify-center rounded-full text-fg-subtle transition-colors duration-150 hover:bg-selected hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form
          className="flex flex-col gap-2.5 rounded-md border border-border-strong bg-black p-3"
          onSubmit={async e => {
            e.preventDefault();
            if (invalid) return;
            await save([...plan.breaks, { days: DAY_ORDER.filter(d => days.includes(d)), start, end }]);
            setAdding(false);
          }}
        >
          <div className="flex gap-1" role="group" aria-label="Days">
            {(["M", "T", "W", "R", "F"] as Day[]).map(d => (
              <FilterChip
                key={d}
                active={days.includes(d)}
                aria-label={DAY_LONG[d]}
                onClick={() => setDays(v => (v.includes(d) ? v.filter(x => x !== d) : [...v, d]))}
                className="w-8 justify-center px-0 font-mono"
              >
                {d}
              </FilterChip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Select aria-label="Break start" className="h-8 text-[0.8125rem]" value={start} onValueChange={setStart} options={HALF_HOURS} />
            <span className="text-xs text-fg-muted">to</span>
            <Select aria-label="Break end" className="h-8 text-[0.8125rem]" value={end} onValueChange={setEnd} options={HALF_HOURS} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" variant="primary" disabled={invalid}>
              Add
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function SectionsSheet({
  plan,
  course,
  onClose,
  mutate,
}: {
  plan: Plan;
  course: PlanCourse | null;
  onClose: () => void;
  mutate: (fn: () => Promise<Plan>) => Promise<void>;
}) {
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeSeats = useStore(s => s.seats);
  const subject = course?.subject;
  const number = course?.number;

  useEffect(() => {
    if (!subject || !number) return;
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    api
      .course(plan.term, subject, number, controller.signal)
      .then(setDetail)
      .catch(e => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [plan.term, subject, number]);

  const combos = useMemo(() => {
    if (!detail) return [];
    const keys = Object.keys(detail.linkedOptions);
    if (keys.length === 0) return detail.sections.map(s => [s.crn]);
    return keys.flatMap(k => detail.linkedOptions[k]!.map(o => [k, ...o]));
  }, [detail]);

  const label = (crn: string) => detail?.sections.find(s => s.crn === crn)?.section ?? crn;

  return (
    <Sheet open={!!course} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="w-[420px] max-w-[92vw]">
        {course && (
          <>
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
              <SheetTitle className="font-mono text-base font-semibold">{courseCode(course)}</SheetTitle>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-fg-muted">{course.title}</span>
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <X />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
              {error && <InlineError>{error}</InlineError>}
              {!detail && !error && (
                <div className="flex flex-col gap-2" aria-busy aria-label="Loading sections">
                  {[0, 1, 2, 3, 4].map(i => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              )}
              {detail && (
                <>
                  <section aria-labelledby="lock-title" className="flex flex-col gap-2">
                    <h3 id="lock-title" className="text-[0.8125rem] font-semibold">
                      Lock to one bundle
                    </h3>
                    <div role="radiogroup" aria-labelledby="lock-title" className="flex flex-wrap gap-1.5">
                      <FilterChip
                        role="radio"
                        aria-checked={!course.locked}
                        active={!course.locked}
                        onClick={() => mutate(() => api.patchPlanCourse(plan.id, course.id, { locked: null }))}
                      >
                        Any
                      </FilterChip>
                      {combos.map(combo => {
                        const on = course.locked?.join() === combo.join();
                        return (
                          <FilterChip
                            key={combo.join()}
                            role="radio"
                            aria-checked={on}
                            active={on}
                            onClick={() => mutate(() => api.patchPlanCourse(plan.id, course.id, { locked: combo }))}
                            className="font-mono"
                          >
                            {on && <Lock aria-hidden />}
                            {combo.map(label).join(" + ")}
                          </FilterChip>
                        );
                      })}
                    </div>
                  </section>
                  <section aria-labelledby="use-title" className="flex flex-col gap-2">
                    <h3 id="use-title" className="text-[0.8125rem] font-semibold">
                      Sections to use
                    </h3>
                    <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
                      {detail.sections.map(s => {
                        const allowed = !course.excludedCrns.includes(s.crn);
                        const m = s.meetings[0];
                        return (
                          <li key={s.crn}>
                            <label className="flex cursor-pointer items-center gap-3 bg-black px-3 py-2.5 transition-colors duration-150 hover:bg-hover">
                              <Checkbox
                                checked={allowed}
                                onCheckedChange={v =>
                                  mutate(() =>
                                    api.patchPlanCourse(plan.id, course.id, {
                                      excludedCrns: v === true ? course.excludedCrns.filter(c => c !== s.crn) : [...course.excludedCrns, s.crn],
                                    }),
                                  )
                                }
                              />
                              <span className="w-10 font-mono text-[0.8125rem]">{s.section}</span>
                              <span className="min-w-0 flex-1 text-xs text-fg-muted">
                                <span className="font-mono">{m?.days || "TBA"}</span>{" "}
                                {m?.start && m.end ? timeRange(m.start, m.end) : "Arranged"}
                              </span>
                              <SeatCount seat={storeSeats[seatKey(plan.term, s.crn)] ?? s.seats} className="[&_.font-mono]:text-xs" />
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------- results ----------

function openCount(schedule: PlanSchedule, result: PlanGenerateResult, seatOf: (crn: string) => number | null) {
  const crns = schedule.picks.flatMap(p => p.crns);
  const open = crns.filter(c => (seatOf(c) ?? result.sections[c]?.seats?.available ?? 0) > 0).length;
  return { open, total: crns.length };
}

function Results({
  plan,
  result,
  generating,
  selectedKey,
  pinnedKey,
  targetKey,
  colorOf,
  onSelect,
  onHover,
  onPin,
}: {
  plan: Plan;
  result: PlanGenerateResult | null;
  generating: boolean;
  selectedKey: string | null;
  pinnedKey: string | null;
  targetKey: string | null;
  colorOf: (c: { subject: string; number: string }) => string;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  onPin: (key: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const seats = useStore(s => s.seats);
  const seatOf = (crn: string) => seats[seatKey(plan.term, crn)]?.available ?? null;
  const schedules = result?.schedules ?? [];
  const index = schedules.findIndex(s => s.key === selectedKey);

  useEffect(() => {
    if (index < 0) return;
    document.getElementById(`sched-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function onKey(e: KeyboardEvent) {
    if (!schedules.length) return;
    let next = index;
    if (e.key === "ArrowDown") next = Math.min(schedules.length - 1, index + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = schedules.length - 1;
    else if ((e.key === "p" || e.key === "P") && selectedKey) {
      e.preventDefault();
      onPin(selectedKey);
      return;
    } else return;
    e.preventDefault();
    onHover(null);
    onSelect(schedules[next]!.key);
  }

  const blocked = result?.courses.filter(c => c.status === "no_options" || c.status === "not_offered") ?? [];

  return (
    <Pane aria-label="Schedules" className="max-xl:max-h-[560px]">
      <PaneHeader>
        <h2 className="text-[0.8125rem] font-semibold">Schedules</h2>
        {result && (
          <span className="ml-auto text-xs text-fg-subtle tabular-nums">
            {result.total > schedules.length || result.truncated
              ? `Showing ${schedules.length} of ${result.total}${result.truncated ? "+" : ""}`
              : `${result.total}`}
          </span>
        )}
      </PaneHeader>
      {generating && !result ? (
        <div className="flex flex-col" aria-busy aria-label="Generating schedules">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
      ) : !result ? (
        <p className="px-4 py-8 text-center text-[0.8125rem] text-fg-muted">
          {plan.courses.some(c => c.included) ? "Generate to see schedules" : "No courses yet"}
        </p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col gap-2 px-4 py-8 text-center">
          <p className="text-sm font-medium">No schedule fits</p>
          {blocked.length > 0 ? (
            <p className="text-[0.8125rem] text-fg-muted">
              {blocked.map(courseCode).join(", ")} {blocked.length === 1 ? "has" : "have"} no section that fits
            </p>
          ) : (
            <p className="text-[0.8125rem] text-fg-muted">Remove a break or a course to open things up.</p>
          )}
        </div>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Schedules"
          tabIndex={0}
          aria-activedescendant={index >= 0 ? `sched-${index}` : undefined}
          onKeyDown={onKey}
          onMouseLeave={() => onHover(null)}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto transition-opacity duration-150 focus-visible:outline-none focus-visible:[&>[aria-selected=true]]:shadow-[inset_0_0_0_1px_var(--color-accent)] [&>*+*]:border-t [&>*+*]:border-border",
            generating && "opacity-60",
          )}
        >
          {schedules.map((s, i) => {
            const selected = s.key === selectedKey;
            const isPinned = s.key === pinnedKey;
            const { open, total } = openCount(s, result, seatOf);
            return (
              <li
                key={s.key}
                id={`sched-${i}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => onHover(s.key)}
                onClick={() => {
                  onSelect(s.key);
                  listRef.current?.focus({ preventScroll: true });
                }}
                className={cn(
                  "group relative flex cursor-pointer gap-3 px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-hover",
                  selected && "bg-selected hover:bg-selected",
                )}
              >
                <span className="w-5 shrink-0 pt-px text-right font-mono text-xs text-fg-subtle tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-xs">
                    {s.picks.map(p => (
                      <span key={courseKey(p)} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span aria-hidden className="size-1.5 rounded-[2px]" style={{ background: colorOf(p) }} />
                        <span className="text-fg">{p.number}</span>
                        <span className="text-fg-muted">{p.crns.map(c => result.sections[c]?.section ?? c).join("+")}</span>
                      </span>
                    ))}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-fg-muted tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <Dot tone={open === total ? "ready" : open === 0 ? "error" : "warning"} className="size-1.5 [&>span]:size-1.5" />
                      {open}/{total} open
                    </span>
                    <span>{s.stats.days} days</span>
                    {s.stats.start && s.stats.end && <span>{timeRange(s.stats.start, s.stats.end)}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? `Unpin schedule ${i + 1}` : `Pin schedule ${i + 1} to compare`}
                    onClick={e => {
                      e.stopPropagation();
                      onPin(s.key);
                    }}
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded text-fg-subtle opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-surface-2 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100",
                      (isPinned || selected) && "opacity-100",
                      isPinned && "text-fg",
                    )}
                  >
                    {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </button>
                  {s.key === targetKey && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#10365f] px-1.5 text-[0.6875rem] leading-4 text-[#52a8ff]">
                      <Crosshair className="size-3" aria-hidden />
                      Target
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {schedules.length > 1 && (
        <p className="hidden shrink-0 items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-fg-subtle xl:flex">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span className="mr-2">preview</span>
          <Kbd>P</Kbd>
          <span>pin to compare</span>
        </p>
      )}
    </Pane>
  );
}

// ---------- calendar ----------

interface Block {
  key: string;
  day: Day;
  start: number;
  end: number;
  kind: "course" | "fixed" | "break" | "pinned";
  color?: string;
  title: string;
  sub?: string;
  detail?: string;
}

function sectionBlocks(sec: PlanSection, kind: Block["kind"], color?: string): Block[] {
  const out: Block[] = [];
  sec.meetings.forEach((m, mi) => {
    if (!m.start || !m.end) return;
    for (const d of m.days as unknown as Day[]) {
      if (!DAY_ORDER.includes(d)) continue;
      out.push({
        key: `${kind}-${sec.crn}-${mi}-${d}`,
        day: d,
        start: minutes(m.start),
        end: minutes(m.end),
        kind,
        color,
        title: `${sec.subject} ${sec.number}`,
        sub: `${sec.section} ${m.type}`,
        detail: [m.room, m.building].filter(Boolean).join(" ") || undefined,
      });
    }
  });
  return out;
}

const HOUR_PX = 46;

function CalendarPane({
  plan,
  result,
  schedule,
  index,
  pinned,
  pinnedIndex,
  isTarget,
  generating,
  colorOf,
  onUnpin,
  onTarget,
  canTarget,
}: {
  plan: Plan;
  result: PlanGenerateResult | null;
  schedule: PlanSchedule | null;
  index: number;
  pinned: PlanSchedule | null;
  pinnedIndex: number;
  isTarget: boolean;
  generating: boolean;
  colorOf: (c: { subject: string; number: string }) => string;
  onUnpin: () => void;
  onTarget: () => void;
  canTarget: boolean;
}) {
  const data = useMemo(() => {
    const blocks: Block[] = [];
    const untimed: { label: string; color: string }[] = [];
    if (result && schedule) {
      const shownCrns = new Set(schedule.picks.flatMap(p => p.crns));
      for (const pick of schedule.picks)
        for (const crn of pick.crns) {
          const sec = result.sections[crn];
          if (!sec) continue;
          const b = sectionBlocks(sec, "course", colorOf(pick));
          blocks.push(...b);
          if (!sec.meetings.some(m => m.start && m.end)) untimed.push({ label: `${courseCode(pick)} ${sec.section}`, color: colorOf(pick) });
        }
      for (const f of result.fixed) {
        const sec = result.sections[f.crn];
        if (sec) blocks.push(...sectionBlocks(sec, "fixed").map(b => ({ ...b, sub: "Registered" })));
      }
      if (pinned)
        for (const pick of pinned.picks)
          for (const crn of pick.crns) {
            if (shownCrns.has(crn)) continue;
            const sec = result.sections[crn];
            if (sec) blocks.push(...sectionBlocks(sec, "pinned", colorOf(pick)));
          }
    }
    plan.breaks.forEach((br, i) => {
      for (const d of br.days)
        blocks.push({ key: `break-${i}-${d}`, day: d, start: minutes(br.start), end: minutes(br.end), kind: "break", title: "Break" });
    });
    const days = DAY_ORDER.filter(d => (["M", "T", "W", "R", "F"] as Day[]).includes(d) || blocks.some(b => b.day === d));
    const lo = Math.min(8 * 60, ...blocks.map(b => Math.floor(b.start / 60) * 60));
    const hi = Math.max(20 * 60, ...blocks.map(b => Math.ceil(b.end / 60) * 60));
    return { blocks, untimed, days, lo, hi };
  }, [result, schedule, pinned, plan.breaks, colorOf]);

  const hours = Array.from({ length: (data.hi - data.lo) / 60 + 1 }, (_, i) => data.lo + i * 60);
  const height = ((data.hi - data.lo) / 60) * HOUR_PX;

  return (
    <Pane aria-label="Week calendar" className="lg:col-start-2 xl:col-start-auto">
      <PaneHeader className="flex-wrap gap-x-3">
        <h2 className="text-[0.8125rem] font-semibold tabular-nums">
          {schedule ? `Schedule ${index + 1}` : "Week"}
        </h2>
        {schedule && (
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted tabular-nums">
            <span>{schedule.stats.days} days</span>
            <span>{duration(schedule.stats.gapMin)}</span>
          </span>
        )}
        {isTarget && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[#10365f] px-1.5 text-[0.6875rem] leading-4 text-[#52a8ff]">
            <Crosshair className="size-3" aria-hidden />
            Target
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pinned && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-fg-muted pl-2.5 pr-1 text-xs text-fg-muted tabular-nums">
              <Pin className="size-3" aria-hidden />
              Comparing {pinnedIndex + 1}
              <button
                type="button"
                aria-label="Stop comparing"
                onClick={onUnpin}
                className="inline-flex size-5 items-center justify-center rounded-full text-fg-subtle transition-colors duration-150 hover:bg-selected hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          <Button variant="primary" size="sm" onClick={onTarget} disabled={!canTarget || isTarget || generating}>
            <Crosshair aria-hidden />
            Target this schedule
          </Button>
        </div>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[340px] px-2 pb-3 pt-2 sm:px-3">
          <div className="sticky top-0 z-20 grid bg-surface" style={{ gridTemplateColumns: `40px repeat(${data.days.length}, minmax(0,1fr))` }}>
            <span />
            {data.days.map(d => (
              <span key={d} className="pb-2 text-center text-xs font-medium text-fg-muted">
                <abbr title={DAY_LONG[d]} className="no-underline">
                  {DAY_SHORT[d]}
                </abbr>
              </span>
            ))}
          </div>
          <div className="grid pt-2" style={{ gridTemplateColumns: `40px repeat(${data.days.length}, minmax(0,1fr))` }}>
            <div className="relative" style={{ height }}>
              {hours.map(h => (
                <span
                  key={h}
                  className="absolute right-2 -translate-y-1/2 text-[0.6875rem] text-fg-subtle tabular-nums"
                  style={{ top: ((h - data.lo) / 60) * HOUR_PX }}
                >
                  {h % 720 === 0 ? (h === 720 ? "12p" : "12a") : `${((h / 60) % 12) || 12}${h < 720 ? "a" : "p"}`}
                </span>
              ))}
            </div>
            {data.days.map(d => (
              <div key={d} className="relative border-l border-border" style={{ height }} aria-label={DAY_LONG[d]} role="group">
                {hours.map(h => (
                  <span key={h} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ top: ((h - data.lo) / 60) * HOUR_PX }} />
                ))}
                {data.blocks
                  .filter(b => b.day === d)
                  .sort((a, b) => order(a) - order(b))
                  .map(b => (
                    <CalendarBlock key={b.key} block={b} lo={data.lo} />
                  ))}
              </div>
            ))}
          </div>
          {!schedule && !generating && (
            <p className="pt-3 text-center text-[0.8125rem] text-fg-muted">
              {result ? "Pick a schedule to preview it" : "Schedules you generate show up on this week"}
            </p>
          )}
          {data.untimed.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
              <span className="mr-1 text-xs text-fg-muted">Online or arranged</span>
              {data.untimed.map(u => (
                <span
                  key={u.label}
                  className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs"
                  style={{ borderColor: `${u.color}66`, color: u.color }}
                >
                  {u.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Pane>
  );
}

const order = (b: Block) => ({ break: 0, fixed: 1, course: 2, pinned: 3 })[b.kind];

function CalendarBlock({ block: b, lo }: { block: Block; lo: number }) {
  const top = ((b.start - lo) / 60) * HOUR_PX;
  const h = Math.max(14, ((b.end - b.start) / 60) * HOUR_PX - 2);
  const label = `${b.title} ${b.sub ?? ""} ${time12(`${Math.floor(b.start / 60)}:${String(b.start % 60).padStart(2, "0")}`)}`;
  const style: CSSProperties = { top: top + 1, height: h };
  const time = timeRange(
    `${String(Math.floor(b.start / 60)).padStart(2, "0")}:${String(b.start % 60).padStart(2, "0")}`,
    `${String(Math.floor(b.end / 60)).padStart(2, "0")}:${String(b.end % 60).padStart(2, "0")}`,
  );

  if (b.kind === "break")
    return (
      <div
        title={`Break ${time}`}
        className="absolute inset-x-0.5 rounded-[4px] border border-dashed border-border-strong px-1.5 py-1 text-[0.6875rem] text-fg-subtle"
        style={{
          ...style,
          backgroundImage: "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.055) 0 1px, transparent 1px 7px)",
        }}
      >
        {h > 26 && "Break"}
      </div>
    );

  if (b.kind === "fixed")
    return (
      <div
        title={`${b.title} registered ${time}`}
        className="absolute inset-x-0.5 overflow-hidden rounded-[4px] border border-border-strong px-1.5 py-1 text-[0.6875rem] leading-tight text-fg-muted"
        style={{ ...style, backgroundImage: "repeating-linear-gradient(45deg, #141414 0 6px, #0d0d0d 6px 12px)" }}
      >
        <span className="block truncate font-mono">{b.title}</span>
        {h > 34 && <span className="block truncate">{b.sub}</span>}
      </div>
    );

  if (b.kind === "pinned")
    return (
      <div
        title={`Pinned ${b.title} ${b.sub} ${time}`}
        className="pointer-events-none absolute inset-x-1 z-10 rounded-[4px] border border-dashed"
        style={{ ...style, borderColor: b.color }}
      >
        {h > 26 && (
          <span className="absolute -top-px right-1 rounded-b-[3px] bg-black px-1 font-mono text-[0.625rem]" style={{ color: b.color }}>
            {b.sub?.split(" ")[0]}
          </span>
        )}
      </div>
    );

  return (
    <div
      aria-label={label}
      title={`${b.title} ${b.sub}\n${time}${b.detail ? `\n${b.detail}` : ""}`}
      className="absolute inset-x-0.5 overflow-hidden rounded-[4px] border px-1.5 py-1 text-[0.6875rem] leading-tight transition-[top,height] duration-150 ease-out"
      style={{ ...style, borderColor: `${b.color}80`, background: `${b.color}24`, color: b.color }}
    >
      <span className="block truncate font-mono font-medium">{b.title}</span>
      {h > 30 && <span className="block truncate font-mono opacity-80">{b.sub}</span>}
      {h > 58 && b.detail && <span className="block truncate text-fg-muted">{b.detail}</span>}
    </div>
  );
}

// ---------- target ----------

function TargetDialog({
  open,
  onOpenChange,
  plan,
  schedule,
  result,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  plan: Plan;
  schedule: PlanSchedule;
  result: PlanGenerateResult;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Backups the server will add: this course's other bundles in the results that fit the other picks.
  const rows = useMemo(
    () =>
      schedule.picks.map(pick => {
        const pc = plan.courses.find(c => c.subject === pick.subject && c.number === pick.number);
        const others = schedule.picks.filter(p => p !== pick).flatMap(p => p.crns.map(c => result.sections[c]!).filter(Boolean));
        const seen = new Set<string>([pick.crns.join(",")]);
        let backups = 0;
        if (pc?.backups !== false)
          for (const s of result.schedules)
            for (const p of s.picks) {
              if (p.subject !== pick.subject || p.number !== pick.number) continue;
              const k = p.crns.join(",");
              if (seen.has(k)) continue;
              seen.add(k);
              const secs = p.crns.map(c => result.sections[c]).filter((x): x is PlanSection => !!x);
              if (secs.every(x => !others.some(o => timedOverlap(x, o)))) backups++;
            }
        return { pick, backups: Math.min(20, backups), sections: pick.crns.map(c => result.sections[c]?.section ?? c) };
      }),
    [schedule, plan.courses, result],
  );

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.targetPlan(plan.id, schedule.picks);
      local.upsertPlan(res.plan);
      for (const w of res.wanted) local.upsertWanted(w);
      setDone(true);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) setError(null);
        if (o) setDone(false);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogBody>
          <DialogTitle>Target this schedule</DialogTitle>
          <DialogDescription>These courses get armed. Their watchlist bundles are replaced.</DialogDescription>
          <ul className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
            {rows.map(r => (
              <li key={courseKey(r.pick)} className="flex items-center gap-3 bg-black px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[0.8125rem]">
                    {courseCode(r.pick)} <span className="text-fg-muted">{r.sections.join(" + ")}</span>
                  </p>
                  <p className="font-mono text-xs text-fg-subtle tabular-nums">{r.pick.crns.join(" + ")}</p>
                </div>
                <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                  {r.backups === 0 ? "No backups" : `+${r.backups} ${r.backups === 1 ? "backup" : "backups"}`}
                </span>
              </li>
            ))}
          </ul>
          <InlineError>{error}</InlineError>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy}>
            {!busy && <Crosshair aria-hidden />}
            Target and arm
          </Button>
        </DialogFooter>
      </DialogContent>
      {done && <span role="status" className="sr-only">Targeted {plan.name}</span>}
    </Dialog>
  );
}

