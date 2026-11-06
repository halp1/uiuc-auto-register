import { Check, ChevronRight, Ellipsis, ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import { DropdownMenu as DM } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { genEdGroups } from "../../src/core/gened";
import type { GenEdHit } from "../../src/core/types";
import { CourseGpa, GenEdPills } from "@/components/grades";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  menuContentClass,
} from "@/components/ui/dropdown-menu";
import { FilterChip, InlineError, PageHeader } from "@/components/ui/list";
import { Segmented } from "@/components/ui/segmented";
import { meetsStanding, STANDING_LABEL, type ClassStanding } from "../../src/core/standing";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { termName } from "@/lib/format";
import { coursePath, genEdsPath, hrefWithMock, linkClick, navigate, type GenEdMatch, type GenEdSort, type RouteMatch } from "@/lib/router";
import { local, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

const SORTS: { value: GenEdSort; label: string }[] = [
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

type Route = Extract<RouteMatch, { name: "geneds" }>;

export function GenEdsPage({ route }: { route: Route }) {
  const term = useStore(s => s.settings?.activeTerm ?? null);
  const terms = useStore(s => s.terms);
  const catalog = useStore(s => s.status!.catalog);
  const standing = useStore(s => s.settings?.classStanding ?? null);
  const { codes, match, sort, noPrereq } = route;
  const [q, setQ] = useState(route.q);
  const [result, setResult] = useState<{ hits: GenEdHit[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const query = q.trim();

  const go = (patch: Partial<{ codes: string[]; match: GenEdMatch; q: string; sort: GenEdSort; noPrereq: boolean }>) =>
    navigate(genEdsPath({ codes, match, q: query, sort, noPrereq, ...patch }), { replace: true });

  useEffect(() => {
    if (query !== route.q.trim()) go({ q: query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const key = codes.join(",");
  useEffect(() => {
    if (!term || codes.length === 0) {
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await api.genEds(term, { codes, match, q: query, sort, noPrereq }, controller.signal);
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
  }, [term, key, match, query, sort, noPrereq, standing, catalog.syncedAt]);

  async function sync() {
    if (!term) return;
    setSyncBusy(true);
    setSyncError(null);
    try {
      await api.syncCatalog(term);
    } catch (e) {
      setSyncError(errorMessage(e));
    } finally {
      setSyncBusy(false);
    }
  }

  const toggle = (code: string) =>
    go({ codes: codes.includes(code) ? codes.filter(c => c !== code) : [...codes, code] });

  const catalogEmpty = catalog.term === term && catalog.courses === 0;
  const hits = result?.hits ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Gen eds">
        <span className="text-[0.8125rem] text-fg-muted">{termName(terms, term)}</span>
      </PageHeader>

      {!term && <p className="text-sm text-fg-muted">Choose a term in the top bar first.</p>}

      {term && (catalogEmpty || catalog.syncing) && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-sm font-medium">
              {catalog.syncing ? "Syncing the catalog" : `No catalog for ${termName(terms, term)} yet`}
            </p>
            <InlineError className="mt-1">{syncError}</InlineError>
          </div>
          <Button variant="primary" size="sm" onClick={sync} loading={syncBusy || catalog.syncing}>
            {!(syncBusy || catalog.syncing) && <RefreshCw aria-hidden />}
            Sync catalog
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        {GROUPS.map(g => (
          <fieldset key={g.category} className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-xs text-fg-muted">{g.label}</legend>
            <div className="flex flex-wrap gap-1.5">
              {g.reqs.map(r => (
                <FilterChip
                  key={r.code}
                  active={codes.includes(r.code)}
                  onClick={() => toggle(r.code)}
                  aria-label={r.label === r.categoryLabel ? r.label : `${r.categoryLabel}: ${r.label}`}
                >
                  {r.label}
                </FilterChip>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      {codes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {codes.length > 1 && (
            <Segmented
              aria-label="Match requirements"
              value={match}
              onChange={v => go({ match: v })}
              options={[
                { value: "all", label: "All" },
                { value: "any", label: "Any" },
              ]}
            />
          )}
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              type="search"
              aria-label="Filter by subject or title"
              placeholder="Filter by subject or title"
              autoComplete="off"
              spellCheck={false}
              value={q}
              onChange={e => setQ(e.target.value)}
              className="h-9 w-full rounded-md border border-border-strong bg-surface-2 pl-9 pr-3 text-sm text-fg placeholder:text-placeholder transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-hover focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <FilterChip
            active={noPrereq}
            onClick={() => go({ noPrereq: !noPrereq })}
            className="h-9 px-3"
            title={standing ? `Keeps courses that only need ${STANDING_LABEL[standing].toLowerCase()} standing or lower` : undefined}
          >
            {noPrereq && <Check aria-hidden />}
            {standing ? `No prerequisites for a ${STANDING_LABEL[standing].toLowerCase()}` : "No prerequisites"}
          </FilterChip>
          <Select aria-label="Sort" className="w-48" value={sort} onValueChange={v => go({ sort: v as GenEdSort })} options={SORTS} />
        </div>
      )}

      <InlineError>{error}</InlineError>

      {codes.length > 0 && loading && !hits && <ResultsSkeleton />}

      {hits && hits.length === 0 && !loading && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">No courses match</p>
          {!catalogEmpty && !catalog.syncing && (
            <Button size="sm" onClick={sync} loading={syncBusy}>
              {!syncBusy && <RefreshCw aria-hidden />}
              Sync catalog
            </Button>
          )}
          <InlineError>{syncError}</InlineError>
        </div>
      )}

      {hits && hits.length > 0 && term && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted tabular-nums" role="status">
            {result!.total > hits.length ? `${hits.length} of ${result!.total} courses` : `${result!.total} ${result!.total === 1 ? "course" : "courses"}`}
          </p>
          <ul
            aria-label="Courses"
            className={cn(
              "overflow-hidden rounded-lg border border-border bg-surface transition-opacity duration-150 [&>*+*]:border-t [&>*+*]:border-border",
              loading && "opacity-60",
            )}
          >
            {hits.map(hit => (
              <HitRow key={`${hit.subject}${hit.number}`} hit={hit} term={term} standing={standing} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HitRow({ hit, term, standing }: { hit: GenEdHit; term: string; standing: ClassStanding | null }) {
  const href = coursePath(hit.term, hit.subject, hit.number);
  return (
    <li className="relative grid min-h-14 grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 transition-colors duration-150 ease-out hover:bg-hover sm:grid-cols-[110px_minmax(0,1fr)_auto_44px_auto]">
      <a
        href={hrefWithMock(href)}
        onClick={linkClick(href)}
        className="font-mono text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-accent)]"
      >
        {hit.subject} {hit.number}
        <span className="sr-only">: {hit.title}</span>
      </a>
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
      <span className="hidden text-[0.8125rem] text-fg-muted tabular-nums sm:block">{hit.creditHours ? `${hit.creditHours} hrs` : ""}</span>
      <span className="relative z-10 hidden sm:block">
        <CourseGpa gpa={hit.gpa} className="block text-right" />
      </span>
      <span className="relative z-10 flex items-center gap-2">
        <span className="font-mono text-[0.8125rem] text-fg-muted tabular-nums sm:hidden">{hit.gpa !== null ? hit.gpa.toFixed(2) : ""}</span>
        <RowMenu hit={hit} term={term} />
      </span>
    </li>
  );
}

function RowMenu({ hit, term }: { hit: GenEdHit; term: string }) {
  const plans = useStore(s => s.plans[term]);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const loaded = useRef(false);

  function load() {
    if (plans || loaded.current) return;
    loaded.current = true;
    api
      .plans(term)
      .then(list => local.plans(term, list))
      .catch(e => setError(errorMessage(e)));
  }

  async function add(planId: number) {
    setError(null);
    try {
      const plan = await api.addPlanCourse(planId, hit.subject, hit.number);
      local.upsertPlan(plan);
      setAdded(plan.name);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const code = `${hit.subject} ${hit.number}`;
  return (
    <>
      {(error || added) && (
        <span role="status" className={cn("hidden max-w-48 truncate text-xs md:block", error ? "text-error-fg" : "text-fg-muted")}>
          {error ?? `Added to ${added}`}
        </span>
      )}
      <DropdownMenu onOpenChange={o => o && load()}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${code}`}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DM.Sub>
            <DM.SubTrigger className="relative flex h-9 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors duration-100 data-[highlighted]:bg-selected data-[state=open]:bg-selected [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted">
              <Plus aria-hidden />
              Add to plan
              <ChevronRight className="ml-auto" aria-hidden />
            </DM.SubTrigger>
            <DM.Portal>
              <DM.SubContent sideOffset={4} className={menuContentClass}>
                {!plans ? (
                  <div className="flex flex-col gap-1 p-1" aria-busy aria-label="Loading plans">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-6 w-28" />
                  </div>
                ) : (
                  plans.map(p => {
                    const has = p.courses.some(c => c.subject === hit.subject && c.number === hit.number);
                    return (
                      <DropdownMenuItem key={p.id} disabled={has || p.courses.length >= 12} onSelect={() => add(p.id)}>
                        <span className="flex-1 truncate">{p.name}</span>
                        {has && <span className="text-xs text-fg-muted">Added</span>}
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DM.SubContent>
            </DM.Portal>
          </DM.Sub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate(coursePath(hit.term, hit.subject, hit.number))}>
            <ExternalLink aria-hidden />
            Open
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function ResultsSkeleton() {
  return (
    <div aria-busy aria-label="Loading courses" className="overflow-hidden rounded-lg border border-border">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className="flex h-14 items-center gap-4 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 max-w-64 flex-1" />
          <Skeleton className="ml-auto h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
