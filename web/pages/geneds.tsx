import { ChevronRight, Ellipsis, ExternalLink, Plus, RefreshCw, Search } from "lucide-react";
import { DropdownMenu as DM } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { GenEdHit } from "../../src/core/types";
import { GENED_SORTS, GenEdHitInfo, GenEdPicker, NoPrereqChip, toggleCode, useGenEdResults } from "@/components/geneds";
import { CourseGpa } from "@/components/grades";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  menuContentClass,
} from "@/components/ui/dropdown-menu";
import { InlineError, PageHeader } from "@/components/ui/list";
import { Segmented } from "@/components/ui/segmented";
import type { ClassStanding } from "../../src/core/standing";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { termName } from "@/lib/format";
import { coursePath, genEdsPath, hrefWithMock, linkClick, navigate, type GenEdMatch, type GenEdSort, type RouteMatch } from "@/lib/router";
import { local, useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

type Route = Extract<RouteMatch, { name: "geneds" }>;

export function GenEdsPage({ route }: { route: Route }) {
  const term = useStore(s => s.settings?.activeTerm ?? null);
  const terms = useStore(s => s.terms);
  const catalog = useStore(s => s.status!.catalog);
  const standing = useStore(s => s.settings?.classStanding ?? null);
  const { codes, match, sort, noPrereq } = route;
  const [q, setQ] = useState(route.q);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const query = q.trim();

  const go = (patch: Partial<{ codes: string[]; match: GenEdMatch; q: string; sort: GenEdSort; noPrereq: boolean }>) =>
    navigate(genEdsPath({ codes, match, q: query, sort, noPrereq, ...patch }), { replace: true });

  useEffect(() => {
    if (query !== route.q.trim()) go({ q: query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const { result, loading, error } = useGenEdResults(
    !!term && codes.length > 0,
    JSON.stringify([term, codes, match, query, sort, noPrereq, standing, catalog.syncedAt]),
    signal => api.genEds(term!, { codes, match, q: query, sort, noPrereq }, signal),
  );

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

  const toggle = (code: string) => go({ codes: toggleCode(codes, code) });

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

      <GenEdPicker codes={codes} onToggle={toggle} />

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
          <NoPrereqChip active={noPrereq} onToggle={() => go({ noPrereq: !noPrereq })} standing={standing} />
          <Select aria-label="Sort" className="w-48" value={sort} onValueChange={v => go({ sort: v as GenEdSort })} options={GENED_SORTS} />
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
      <GenEdHitInfo hit={hit} standing={standing} />
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
